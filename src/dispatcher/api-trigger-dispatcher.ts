/**
 * LANE AA — API-trigger dispatcher.
 *
 * V1 of the HTTP API (migration 016 + http-api/) persists runs with
 * status='queued' and returns immediately. This module is V1.5: a daemon-side
 * poll loop that picks queued runs, wires a synthetic session, and wakes a
 * container so the run actually executes.
 *
 * ──── Architecture ────────────────────────────────────────────────────
 *
 * Every POLL_INTERVAL_MS ticks:
 *
 *   1. Refresh dispatcher heartbeat (last_poll_at = now).
 *   2. Reconcile finished runs: any tracked run whose container is no longer
 *      running gets its status closed out (success/error) and the inbound
 *      session left for cleanup by the host-sweep.
 *   3. Backpressure alerter: if > ALERT_QUEUED_THRESHOLD runs are queued AND
 *      the oldest is > ALERT_QUEUE_AGE_S seconds old, fire the webhook (at
 *      most ALERT_DEBOUNCE_MS apart).
 *   4. Apply concurrency cap: stop if getActiveContainerCount() ≥ MAX_CONCURRENT.
 *   5. SELECT queued runs FIFO, LIMIT BATCH_SIZE.
 *   6. For each, atomically claim (UPDATE … WHERE status='queued'). If 0 rows
 *      change, another tick or another worker won — skip.
 *   7. Acquire in-memory per-target lock (agent_group_id, target_entity_id).
 *      If already held, release the run back to 'queued' for the next tick.
 *   8. Build/reuse a session for (agent_group_id, mg-api-trigger), write a
 *      'system' message with the run payload, call wakeContainer().
 *   9. Track (sessionId → runId) so the reconcile pass closes the run when
 *      the container exits.
 *
 * Locking strategy. SQLite doesn't have pg_advisory_xact_lock, so we use:
 *   - DB-level atomic claim: UPDATE … SET status='running' WHERE status='queued'
 *     RETURNING. The partial UNIQUE INDEX on (dedup_key) WHERE status IN
 *     ('queued','running') from migration 016 already prevents duplicate
 *     enqueues; the atomic UPDATE prevents double-claim by two ticks.
 *   - Process-level Set: targetLocks holds the (agent_group, target) pairs
 *     currently running. Since the daemon is a single process, an in-memory
 *     Set is sufficient — there is no second NanoClaw daemon to coordinate
 *     with. If we ever multi-process, this becomes a row in
 *     dispatcher_target_locks.
 *
 * Retry policy. wakeContainer() never throws — it returns false on transient
 * spawn failure (OneCLI gateway down, container runtime restart, etc.). On
 * failure we increment attempt_count and either re-queue (< MAX_ATTEMPTS) or
 * mark the run as error. The atomic claim ensures retry is not a double-spawn.
 */
import { createHmac } from 'node:crypto';

import { getActiveContainerCount, isContainerRunning, wakeContainer } from '../container-runner.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { createMessagingGroupAgent, getMessagingGroupAgentByPair } from '../db/messaging-groups.js';
import { getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import { openOutboundDb, resolveSession, writeSessionMessage } from '../session-manager.js';

// ── Tunables ──────────────────────────────────────────────────────────

/** How often the loop wakes up. 5s matches the spec's acceptance criteria. */
const POLL_INTERVAL_MS = 5_000;

/** Max queued runs claimed per tick (keeps each tick's work bounded). */
const BATCH_SIZE = 10;

/** Max containers in-flight at once. Above this we exert backpressure. */
const MAX_CONCURRENT = 5;

/** Max wake attempts before we give up and mark the run as 'error'. */
const MAX_ATTEMPTS = 3;

/** Queued-count threshold for the backpressure alert. */
const ALERT_QUEUED_THRESHOLD = 50;

/** Min age of the oldest queued run before we alert. */
const ALERT_QUEUE_AGE_S = 5 * 60;

/** Don't fire the same alert more often than this. */
const ALERT_DEBOUNCE_MS = 5 * 60_000;

/** Synthetic messaging_group row created by migration 017. */
const API_TRIGGER_MG_ID = 'mg-api-trigger';

// ── Module state ──────────────────────────────────────────────────────

interface DispatcherState {
  isRunning: boolean;
  /** Wall-clock of the last poll tick — exposed via /api/dispatcher/status. */
  lastPollAt: string | null;
  /** Wall-clock of the last successful dispatch. */
  lastDispatchAt: string | null;
  /** Wall-clock of the last backpressure alert fired. */
  lastAlertAt: number;
  /** Active poll timer handle, set while started. */
  timer: NodeJS.Timeout | null;
  /** Sessions we spawned, keyed by sessionId → runId, so we close runs out. */
  trackedRuns: Map<string, TrackedRun>;
  /** Per-target locks: "agent_group_id::target_entity_id". */
  targetLocks: Set<string>;
}

interface TrackedRun {
  runId: string;
  sessionId: string;
  agentGroupId: string;
  targetEntityId: string | null;
  /** When we called wakeContainer(). Used to grant a short grace period
   *  before the reconcile sweep gets to inspect container_status — the
   *  container may not have flipped to 'running' on the very first tick. */
  startedAt: number;
  /** Wall-clock ISO at which the dispatcher wrote the api_trigger system
   *  message. Used as the cutoff for harvesting messages_out → outcome at
   *  reconcile time (LANE H V1.5) so we don't pick up replies from a prior
   *  run that shared this session. */
  triggerWrittenAt: string;
  /** Caller-supplied skill identity, surfaced into the outcome webhook
   *  payload so agency-os can update its own runs row without re-joining. */
  skillSlug: string | null;
  skillVersion: number | null;
}

const state: DispatcherState = {
  isRunning: false,
  lastPollAt: null,
  lastDispatchAt: null,
  lastAlertAt: 0,
  timer: null,
  trackedRuns: new Map(),
  targetLocks: new Set(),
};

interface RunRow {
  id: string;
  agent_group_id: string;
  dedup_key: string | null;
  priority: string;
  input: string | null;
  attempt_count: number;
  created_at: string;
  // LANE H V1.5 — null for legacy/non-skill triggers (which still work,
  // they just don't get the structured SKILL EXECUTION REQUEST prompt).
  skill_slug: string | null;
  skill_version: number | null;
  skill_content: string | null;
}

// ── Public surface ────────────────────────────────────────────────────

export function startDispatcher(): void {
  if (state.timer) {
    log.warn('Dispatcher already running — startDispatcher() called twice');
    return;
  }
  state.isRunning = true;
  state.timer = setInterval(() => {
    tick().catch((err) => {
      log.error('Dispatcher tick threw', { err });
    });
  }, POLL_INTERVAL_MS);
  // Schedule a tick immediately so we don't wait the first 5s on cold boot.
  setImmediate(() => {
    tick().catch((err) => log.error('Initial dispatcher tick threw', { err }));
  });
  log.info('API-trigger dispatcher started', { pollMs: POLL_INTERVAL_MS, maxConcurrent: MAX_CONCURRENT });
}

export function stopDispatcher(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  state.isRunning = false;
  log.info('API-trigger dispatcher stopped');
}

export interface DispatcherStatus {
  is_running: boolean;
  queued_runs_count: number;
  running_runs_count: number;
  tracked_runs_count: number;
  active_containers: number;
  last_poll_at: string | null;
  last_dispatch_at: string | null;
  last_alert_at: string | null;
}

export function getDispatcherStatus(): DispatcherStatus {
  const db = getDb();
  const queued = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'`).get() as { n: number }).n;
  const running = (db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status = 'running'`).get() as { n: number }).n;
  return {
    is_running: state.isRunning,
    queued_runs_count: queued,
    running_runs_count: running,
    tracked_runs_count: state.trackedRuns.size,
    active_containers: getActiveContainerCount(),
    last_poll_at: state.lastPollAt,
    last_dispatch_at: state.lastDispatchAt,
    last_alert_at: state.lastAlertAt === 0 ? null : new Date(state.lastAlertAt).toISOString(),
  };
}

// ── Tick body ─────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  state.lastPollAt = new Date().toISOString();

  reconcileFinished();
  maybeFireBackpressureAlert();

  // Hard cap: never spawn beyond MAX_CONCURRENT.
  const headroom = MAX_CONCURRENT - getActiveContainerCount();
  if (headroom <= 0) {
    log.debug('Dispatcher backpressure: at concurrency cap', { active: getActiveContainerCount() });
    return;
  }

  const candidates = selectQueuedRuns(Math.min(headroom, BATCH_SIZE));
  if (candidates.length === 0) return;

  for (const run of candidates) {
    try {
      await dispatchOne(run);
    } catch (err) {
      // dispatchOne already handles its own failure paths — anything bubbling
      // up here is a programmer error.
      log.error('dispatchOne threw unexpectedly', { runId: run.id, err });
      failRun(run.id, `unexpected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function selectQueuedRuns(limit: number): RunRow[] {
  return getDb()
    .prepare(
      `SELECT id, agent_group_id, dedup_key, priority, input, attempt_count, created_at,
              skill_slug, skill_version, skill_content
         FROM runs
        WHERE status = 'queued'
        ORDER BY
          CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
          created_at ASC
        LIMIT ?`,
    )
    .all(limit) as RunRow[];
}

async function dispatchOne(run: RunRow): Promise<void> {
  const targetEntityId = extractTargetEntityId(run.input);
  const lockKey = `${run.agent_group_id}::${targetEntityId ?? ''}`;

  // Per-target concurrency: skip if another run for the same scope is mid-flight.
  // The run stays 'queued' and re-enters the next tick.
  if (state.targetLocks.has(lockKey)) {
    log.debug('Dispatcher target lock held — deferring run', { runId: run.id, lockKey });
    return;
  }

  // Atomic claim. Two ticks racing for the same row are reconciled here: the
  // second UPDATE sees status='running' (not 'queued') and changes 0 rows.
  const startedAt = new Date().toISOString();
  const claim = getDb()
    .prepare(
      `UPDATE runs SET status = 'running',
                       started_at = ?,
                       attempt_count = attempt_count + 1,
                       target_entity_id = COALESCE(?, target_entity_id),
                       last_poll_at = ?
         WHERE id = ? AND status = 'queued'`,
    )
    .run(startedAt, targetEntityId, startedAt, run.id);

  if (claim.changes === 0) {
    log.debug('Dispatcher claim lost — another tick took this run', { runId: run.id });
    return;
  }

  state.targetLocks.add(lockKey);
  recordEvent(run.id, 'info', 'run_claimed', {
    attempt: run.attempt_count + 1,
    target_entity_id: targetEntityId,
  });

  // From here on out, failure must release the target lock.
  try {
    const agentGroup = getAgentGroup(run.agent_group_id);
    if (!agentGroup) {
      failRun(run.id, `agent_group_not_found: ${run.agent_group_id}`);
      state.targetLocks.delete(lockKey);
      return;
    }

    // Wire the synthetic api-trigger MG → agent_group lazily on first use.
    ensureApiTriggerWiring(agentGroup.id);

    // Create or reuse a 'shared' session — every API trigger for a given
    // agent_group lands on the same session row, which keeps message context
    // available across triggers and avoids unbounded session creation.
    const { session } = resolveSession(agentGroup.id, API_TRIGGER_MG_ID, null, 'shared');

    // Write the run input as a 'system' message: the container's message-in
    // poll loop already handles kind='system' for synthetic injections. The
    // payload is a stable JSON shape the agent-runner can switch on.
    //
    // LANE H V1.5: include skill identity + markdown content inline so the
    // formatter can build a [SKILL EXECUTION REQUEST] prompt. When all three
    // skill_* fields are absent we keep the V1 shape — backward compat for
    // legacy queue-action triggers that come without explicit skill metadata.
    const payload = parseInput(run.input);
    const messageContent: Record<string, unknown> = {
      type: 'api_trigger',
      run_id: run.id,
      dedup_key: run.dedup_key,
      priority: run.priority,
      target_entity_id: targetEntityId,
      input: payload,
    };
    if (run.skill_slug) messageContent.skill_slug = run.skill_slug;
    if (run.skill_version !== null) messageContent.skill_version = run.skill_version;
    if (run.skill_content) messageContent.skill_content = run.skill_content;

    writeSessionMessage(agentGroup.id, session.id, {
      id: `api-trigger-${run.id}`,
      kind: 'system',
      timestamp: startedAt,
      content: JSON.stringify(messageContent),
      trigger: 1,
    });

    const freshSession = getSession(session.id);
    if (!freshSession) {
      failRun(run.id, 'session_disappeared');
      state.targetLocks.delete(lockKey);
      return;
    }

    recordEvent(run.id, 'info', 'container_wake_requested', { session_id: session.id });

    // wakeContainer never throws. false means a transient spawn failure
    // (e.g. OneCLI gateway unreachable). Either retry or give up.
    const woke = await wakeContainer(freshSession);

    if (!woke) {
      const nextAttempt = run.attempt_count + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        failRun(run.id, `spawn_failed_after_${nextAttempt}_attempts`);
      } else {
        // Re-queue. Keep attempt_count incremented so the next tick knows.
        getDb()
          .prepare(`UPDATE runs SET status = 'queued', started_at = NULL WHERE id = ? AND status = 'running'`)
          .run(run.id);
        recordEvent(run.id, 'warn', 'spawn_failed_will_retry', { attempt: nextAttempt });
      }
      state.targetLocks.delete(lockKey);
      return;
    }

    state.lastDispatchAt = new Date().toISOString();
    state.trackedRuns.set(session.id, {
      runId: run.id,
      sessionId: session.id,
      agentGroupId: agentGroup.id,
      targetEntityId,
      startedAt: Date.now(),
      triggerWrittenAt: startedAt,
      skillSlug: run.skill_slug,
      skillVersion: run.skill_version,
    });

    // Persist the session id on the run so external observers (the agency-os
    // dashboard, the dispatcher status endpoint) can join.
    getDb().prepare(`UPDATE runs SET session_id = ? WHERE id = ?`).run(session.id, run.id);

    recordEvent(run.id, 'info', 'container_spawned', { session_id: session.id });
    log.info('Run dispatched', { runId: run.id, sessionId: session.id, agentGroup: agentGroup.name });
  } catch (err) {
    state.targetLocks.delete(lockKey);
    throw err;
  }
}

function extractTargetEntityId(inputJson: string | null): string | null {
  if (!inputJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  // We accept several conventional locations so callers don't have to hoist
  // their domain key into a special slot. Priority order: explicit slot first,
  // then common nested locations from the agency-os queue payloads.
  const explicit = parsed.target_entity_id;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;

  const params = isRecord(parsed.parameters) ? parsed.parameters : null;
  if (params) {
    for (const key of ['target_entity_id', 'creator_id', 'queue_item_id', 'lead_id', 'campaign_id']) {
      const v = params[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }

  for (const key of ['queue_item_id', 'creator_id', 'lead_id', 'campaign_id']) {
    const v = parsed[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function parseInput(inputJson: string | null): Record<string, unknown> {
  if (!inputJson) return {};
  try {
    const parsed = JSON.parse(inputJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ── Reconcile finished runs ───────────────────────────────────────────

/**
 * Containers run async; the dispatcher learns they finished by polling
 * `isContainerRunning(sessionId)`. The container-runner's own close handler
 * has already called markContainerStopped(), so when we see a tracked
 * session whose container is no longer registered, we close out the run.
 *
 * Determining success vs error: we inspect the session's outbound DB for any
 * delivered messages_out rows and the inbound DB for unprocessed messages_in.
 * For V1.5 we keep it simple — if the container exited cleanly, we mark
 * 'success'. Any genuine failure mode (spawn-throw, agent crash) results in
 * container_status='stopped' without the wake-side wakePromises resolving
 * true, and would have failed earlier in dispatchOne.
 *
 * Lifetime guard: a session that's been tracked >24h without its container
 * ever appearing as "running" is treated as a stuck dispatch and forcibly
 * marked error. This prevents the trackedRuns map from leaking forever if
 * a container fails to register itself for some unanticipated reason.
 */
function reconcileFinished(): void {
  const STUCK_MS = 24 * 60 * 60 * 1000;
  const GRACE_MS = 10_000;
  const now = Date.now();

  for (const [sessionId, tracked] of state.trackedRuns) {
    if (isContainerRunning(sessionId)) continue;

    // Grace period: container.on('close') fires synchronously in spawnContainer
    // but the container may need a moment to come up before isContainerRunning
    // is true. If we're still inside the grace window and the container has
    // not yet appeared, give it more time.
    if (now - tracked.startedAt < GRACE_MS) continue;

    // The container exited (or never came up). Close out the run.
    const stuck = now - tracked.startedAt > STUCK_MS;
    const status = stuck ? 'error' : 'success';
    const errorMsg = stuck ? 'container_never_registered_within_24h' : null;
    const endedAt = new Date().toISOString();

    // LANE H V1.5 — harvest the agent's reply text from messages_out for the
    // window since this run's system message was written. Best-effort: any
    // failure here (db locked, schema mismatch on legacy sessions) is logged
    // and the run still closes out cleanly so the trackedRuns map doesn't
    // leak.
    let outcomeText: string | null = null;
    if (!stuck) {
      try {
        outcomeText = harvestOutcomeText(tracked.agentGroupId, sessionId, tracked.triggerWrittenAt);
      } catch (err) {
        log.warn('Outcome harvest failed', { runId: tracked.runId, err });
      }
    }

    getDb()
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, error_message = ?, outcome = ?
           WHERE id = ? AND status = 'running'`,
      )
      .run(status, endedAt, errorMsg, outcomeText, tracked.runId);

    recordEvent(tracked.runId, stuck ? 'error' : 'info', `run_${status}`, {
      session_id: sessionId,
      duration_ms: now - tracked.startedAt,
      outcome_bytes: outcomeText ? outcomeText.length : 0,
    });

    // Fire the outcome webhook so agency-os can update its mirror runs row
    // without polling. Fire-and-forget like the alert webhook.
    void maybePostOutcomeWebhook({
      runId: tracked.runId,
      status,
      errorMessage: errorMsg,
      outcome: outcomeText,
      startedAt: tracked.triggerWrittenAt,
      endedAt,
      skillSlug: tracked.skillSlug,
      skillVersion: tracked.skillVersion,
      sessionId,
      agentGroupId: tracked.agentGroupId,
    });

    state.trackedRuns.delete(sessionId);
    state.targetLocks.delete(`${tracked.agentGroupId}::${tracked.targetEntityId ?? ''}`);
  }
}

// ── Outcome harvest + webhook (LANE H V1.5) ──────────────────────────

/**
 * Read messages_out for the session written after the run's api_trigger
 * landed, parse the JSON content payload (`{text: ...}` shape produced
 * by the agent-runner), and concatenate the text into a single outcome
 * blob.
 *
 * We bound the result to 64KB so a runaway agent reply doesn't blow up
 * the runs.outcome column or the webhook body.
 */
function harvestOutcomeText(agentGroupId: string, sessionId: string, sinceIso: string): string | null {
  const MAX_OUTCOME_BYTES = 64 * 1024;
  let outDb: import('better-sqlite3').Database | null = null;
  try {
    outDb = openOutboundDb(agentGroupId, sessionId);
    const rows = outDb
      .prepare(
        `SELECT timestamp, content FROM messages_out
          WHERE timestamp >= ?
          ORDER BY timestamp ASC, seq ASC`,
      )
      .all(sinceIso) as Array<{ timestamp: string; content: string }>;
    if (rows.length === 0) return null;
    const parts: string[] = [];
    for (const row of rows) {
      const txt = extractText(row.content);
      if (txt) parts.push(txt);
    }
    if (parts.length === 0) return null;
    const joined = parts.join('\n\n');
    return joined.length > MAX_OUTCOME_BYTES ? joined.slice(0, MAX_OUTCOME_BYTES) + '\n…[truncated]' : joined;
  } finally {
    try {
      outDb?.close();
    } catch {
      // best-effort
    }
  }
}

function extractText(rawContent: string): string | null {
  if (!rawContent) return null;
  try {
    const parsed = JSON.parse(rawContent);
    if (isRecord(parsed)) {
      if (typeof parsed.text === 'string' && parsed.text.length > 0) return parsed.text;
      // Fallback: agent reply could be a tool-result wrapper; surface the
      // whole JSON so the operator can at least see what the container
      // sent. Bound it before joining.
      return JSON.stringify(parsed).slice(0, 2_000);
    }
    return null;
  } catch {
    // content wasn't JSON — assume it's plain text already
    return rawContent;
  }
}

interface OutcomeWebhookPayload {
  runId: string;
  status: string;
  errorMessage: string | null;
  outcome: string | null;
  startedAt: string;
  endedAt: string;
  skillSlug: string | null;
  skillVersion: number | null;
  sessionId: string;
  agentGroupId: string;
}

async function maybePostOutcomeWebhook(payload: OutcomeWebhookPayload): Promise<void> {
  const env = readEnvFile(['AGENCY_OS_OUTCOME_WEBHOOK', 'AGENCY_OS_OUTCOME_SECRET']);
  const webhookUrl = process.env.AGENCY_OS_OUTCOME_WEBHOOK ?? env.AGENCY_OS_OUTCOME_WEBHOOK;
  if (!webhookUrl) {
    log.debug('AGENCY_OS_OUTCOME_WEBHOOK not set — skipping outcome push', { runId: payload.runId });
    return;
  }
  const secret = process.env.AGENCY_OS_OUTCOME_SECRET ?? env.AGENCY_OS_OUTCOME_SECRET;

  const body = JSON.stringify({
    run_id: payload.runId,
    status: payload.status,
    error_message: payload.errorMessage,
    outcome: payload.outcome,
    started_at: payload.startedAt,
    ended_at: payload.endedAt,
    skill_slug: payload.skillSlug,
    skill_version: payload.skillVersion,
    nanoclaw_session_id: payload.sessionId,
    nanoclaw_agent_group_id: payload.agentGroupId,
  });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) {
    // HMAC-SHA256 of the body — agency-os webhook handler verifies this
    // against AGENCY_OS_OUTCOME_SECRET (same shared secret on both sides).
    // We send hex-encoded so the route can timingSafeEqual against a hex
    // expected. Header name follows the agency-os webhook convention
    // (`x-signature`), see src/lib/integrations/sendblue/webhook-verify.ts.
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    headers['x-nanoclaw-signature'] = sig;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('Outcome webhook returned non-2xx', {
        url: webhookUrl,
        status: res.status,
        runId: payload.runId,
      });
    } else {
      log.info('Outcome webhook posted', { runId: payload.runId, status: res.status });
    }
  } catch (err) {
    log.error('Outcome webhook failed', { url: webhookUrl, runId: payload.runId, err });
  }
}

// ── Backpressure alert ────────────────────────────────────────────────

function maybeFireBackpressureAlert(): void {
  if (Date.now() - state.lastAlertAt < ALERT_DEBOUNCE_MS) return;

  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              MIN(created_at) AS oldest
         FROM runs WHERE status = 'queued'`,
    )
    .get() as { n: number; oldest: string | null };

  if (row.n < ALERT_QUEUED_THRESHOLD || !row.oldest) return;
  const ageS = (Date.now() - new Date(row.oldest).getTime()) / 1000;
  if (ageS < ALERT_QUEUE_AGE_S) return;

  const env = readEnvFile(['AGENCY_OS_ALERT_WEBHOOK', 'AGENCY_OS_ALERT_TOKEN']);
  const webhookUrl = process.env.AGENCY_OS_ALERT_WEBHOOK ?? env.AGENCY_OS_ALERT_WEBHOOK;
  if (!webhookUrl) {
    log.warn('Dispatcher backlog detected but AGENCY_OS_ALERT_WEBHOOK not set', {
      queued: row.n,
      ageS,
    });
    state.lastAlertAt = Date.now();
    return;
  }

  const token = process.env.AGENCY_OS_ALERT_TOKEN ?? env.AGENCY_OS_ALERT_TOKEN;
  state.lastAlertAt = Date.now();

  // Fire-and-forget. We do NOT block the tick on the webhook — it's a hint
  // for the operator, not a transactional handoff. Result is logged.
  void postAlert(webhookUrl, token, {
    kind: 'backpressure',
    queued_count: row.n,
    oldest_age_seconds: Math.floor(ageS),
    fired_at: new Date().toISOString(),
  });
}

async function postAlert(url: string, token: string | undefined, body: Record<string, unknown>): Promise<void> {
  let status: number | null = null;
  let errMsg: string | null = null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      // 5s cap so a hung webhook doesn't pile up timers.
      signal: AbortSignal.timeout(5_000),
    });
    status = res.status;
    if (!res.ok) {
      errMsg = `non_2xx: ${res.status}`;
      log.warn('Dispatcher alert webhook returned non-2xx', { url, status: res.status });
    } else {
      log.info('Dispatcher alert posted', { url, status: res.status, body });
    }
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    log.error('Dispatcher alert webhook failed', { url, err });
  }

  getDb()
    .prepare(
      `INSERT INTO dispatcher_alerts
         (fired_at, kind, queued_count, oldest_age_s, webhook_url, http_status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      body.kind as string,
      (body.queued_count as number) ?? null,
      (body.oldest_age_seconds as number) ?? null,
      url,
      status,
      errMsg,
    );
}

// ── Helpers ───────────────────────────────────────────────────────────

function ensureApiTriggerWiring(agentGroupId: string): void {
  const existing = getMessagingGroupAgentByPair(API_TRIGGER_MG_ID, agentGroupId);
  if (existing) return;

  createMessagingGroupAgent({
    id: `mga-api-trigger-${agentGroupId}`,
    messaging_group_id: API_TRIGGER_MG_ID,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Wired api-trigger MG to agent group', { agentGroupId });
}

function failRun(runId: string, reason: string): void {
  const endedAt = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE runs SET status = 'error', ended_at = ?, error_message = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(endedAt, reason, runId);
  recordEvent(runId, 'error', 'run_failed', { reason });
}

function recordEvent(
  runId: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data: Record<string, unknown> | null,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO run_events (run_id, timestamp, level, message, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, new Date().toISOString(), level, message, data ? JSON.stringify(data) : null);
  } catch (err) {
    // Never throw out of an event write — the dispatch path is more important
    // than the audit trail.
    log.warn('Failed to write run_event', { runId, message, err });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Test-only exports — exposed via the underscore-prefixed path so the
// production surface stays focused.
export const _internals = {
  extractTargetEntityId,
  ensureApiTriggerWiring,
  reconcileFinished,
  selectQueuedRuns,
  state,
};

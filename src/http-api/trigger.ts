import { createHash } from 'node:crypto';

import { getDb } from '../db/connection.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { log } from '../log.js';

/**
 * HTTP-API trigger payload.
 *
 * Required fields are the V1 minimum (agent_group_id, dedup_key, input,
 * priority). The optional `run_id` + `skill_*` fields are the LANE H V1.5
 * additions that let the agency-os dashboard send full skill identity +
 * markdown content inline, so the container's agent-runner can read the
 * procedure without a filesystem sync.
 *
 * `skill_content` is treated as untrusted: stored verbatim in `runs`
 * (audit), forwarded into the container's messages_in (execution),
 * never logged in cleartext (run_events records hash + size + slug
 * only — see LANE H spec security clause).
 */
export interface TriggerInput {
  agent_group_id: string;
  dedup_key: string;
  input: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high';
  /**
   * Caller-supplied run id (agency-os UUID). If provided, NanoClaw uses it
   * verbatim instead of minting its own — this gives us a single run id
   * across the two systems' audit trails. If absent, fall back to the
   * V1 `run-<ts>-<rand>` shape.
   */
  run_id?: string;
  skill_slug?: string;
  skill_version?: number;
  skill_content?: string;
}

export interface TriggerResult {
  run_id: string;
  agent_group_id: string;
  status: 'queued';
  created_at: string;
}

export interface TriggerDuplicate {
  duplicate: true;
  run_id: string;
  dedup_key: string;
}

export interface TriggerError {
  error: 'not_found' | 'internal' | 'invalid_run_id';
}

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** SHA-256 of the skill markdown, hex, first 16 chars — enough to dedup
 *  audit entries without leaking content. */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Insert a new run row for an API-triggered execution.
 *
 * V1.5 (LANE H): the run row now carries skill identity + markdown body
 * as first-class columns. The dispatcher picks them up at claim time and
 * injects them into the container's messages_in payload, so the agent
 * runs the actual skill procedure rather than seeing an opaque Input
 * blob.
 *
 * Dedup: enforced by partial UNIQUE INDEX on runs(dedup_key) WHERE
 * status IN ('queued','running'). We read first to return a friendly
 * 409 with the existing run_id, then catch SQLITE_CONSTRAINT on the
 * insert race to be safe.
 *
 * run_id collision: if the caller supplies a run_id that already exists
 * in `runs`, we return 'invalid_run_id' (we never silently reuse a row
 * that may belong to a different dispatch).
 */
export function triggerAgentGroup(payload: TriggerInput): TriggerResult | TriggerDuplicate | TriggerError {
  const db = getDb();

  const group = getAgentGroup(payload.agent_group_id);
  if (!group) return { error: 'not_found' };

  const existing = db
    .prepare(`SELECT id FROM runs WHERE dedup_key = ? AND status IN ('queued', 'running') LIMIT 1`)
    .get(payload.dedup_key) as { id: string } | undefined;
  if (existing) {
    return { duplicate: true, run_id: existing.id, dedup_key: payload.dedup_key };
  }

  let runId = payload.run_id?.trim() || '';
  if (runId.length > 0) {
    const clash = db.prepare(`SELECT 1 FROM runs WHERE id = ?`).get(runId);
    if (clash) {
      log.warn('HTTP API trigger: caller-supplied run_id already exists', {
        runId,
        agentGroupId: payload.agent_group_id,
      });
      return { error: 'invalid_run_id' };
    }
  } else {
    runId = generateRunId();
  }
  const now = new Date().toISOString();

  const skillContent = payload.skill_content ?? null;
  const skillHash = skillContent ? shortHash(skillContent) : null;
  const skillSize = skillContent ? skillContent.length : null;

  try {
    db.prepare(
      `INSERT INTO runs (
         id, agent_group_id, dedup_key, status, priority, input,
         skill_slug, skill_version, skill_content, created_at
       )
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      payload.agent_group_id,
      payload.dedup_key,
      payload.priority,
      JSON.stringify(payload.input),
      payload.skill_slug ?? null,
      payload.skill_version ?? null,
      skillContent,
      now,
    );

    // Only log hash + size + slug — never the raw skill body. The body
    // may include API hints / partial credentials referenced by the
    // skill procedure (per LANE H security clause).
    db.prepare(
      `INSERT INTO run_events (run_id, timestamp, level, message, data)
       VALUES (?, ?, 'info', ?, ?)`,
    ).run(
      runId,
      now,
      'run_queued',
      JSON.stringify({
        source: 'http-api',
        skill_slug: payload.skill_slug ?? null,
        skill_version: payload.skill_version ?? null,
        skill_content_hash: skillHash,
        skill_content_bytes: skillSize,
      }),
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Lost a race with another concurrent trigger. Re-read and return
      // the winner's run_id so the caller sees a normal duplicate.
      const winner = db
        .prepare(`SELECT id FROM runs WHERE dedup_key = ? AND status IN ('queued', 'running') LIMIT 1`)
        .get(payload.dedup_key) as { id: string } | undefined;
      if (winner) {
        return { duplicate: true, run_id: winner.id, dedup_key: payload.dedup_key };
      }
    }
    log.error('Failed to insert run row', { err, agentGroupId: payload.agent_group_id });
    return { error: 'internal' };
  }

  log.info('Run queued via HTTP API', {
    runId,
    agentGroupId: payload.agent_group_id,
    dedupKey: payload.dedup_key,
    priority: payload.priority,
    skillSlug: payload.skill_slug ?? null,
    skillVersion: payload.skill_version ?? null,
    skillContentBytes: skillSize,
  });

  return {
    run_id: runId,
    agent_group_id: payload.agent_group_id,
    status: 'queued',
    created_at: now,
  };
}

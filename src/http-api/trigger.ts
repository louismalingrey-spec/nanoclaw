import { getDb } from '../db/connection.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { log } from '../log.js';

export interface TriggerInput {
  agent_group_id: string;
  dedup_key: string;
  input: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high';
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
  error: 'not_found' | 'internal';
}

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Insert a new run row for an API-triggered execution.
 *
 * V1: persists the run + emits an initial run_event so the agency-os
 * dashboard can return a run_id and dedup correctly. Actual container
 * dispatch (writing a messages_in row + wakeContainer) is V1.5 — when
 * LANE H lands and the canonical input shape is locked in. The run sits
 * in status='queued' until something picks it up.
 *
 * Dedup: enforced by partial UNIQUE INDEX on runs(dedup_key) WHERE
 * status IN ('queued','running'). We read first to return a friendly
 * 409 with the existing run_id, then catch SQLITE_CONSTRAINT on the
 * insert race to be safe.
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

  const runId = generateRunId();
  const now = new Date().toISOString();

  try {
    db.prepare(
      `INSERT INTO runs (id, agent_group_id, dedup_key, status, priority, input, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(runId, payload.agent_group_id, payload.dedup_key, payload.priority, JSON.stringify(payload.input), now);

    db.prepare(
      `INSERT INTO run_events (run_id, timestamp, level, message, data)
       VALUES (?, ?, 'info', ?, ?)`,
    ).run(runId, now, 'run_queued', JSON.stringify({ source: 'http-api' }));
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
  });

  return {
    run_id: runId,
    agent_group_id: payload.agent_group_id,
    status: 'queued',
    created_at: now,
  };
}

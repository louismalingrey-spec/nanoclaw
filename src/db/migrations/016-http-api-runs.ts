import type { Migration } from './index.js';

/**
 * HTTP API: runs + run_events.
 *
 * Spec: docs/integrations/nanoclaw-http-api.md in the agency-os repo.
 *
 * A `run` is a single API-triggered execution of an agent group. It is
 * inserted by POST /api/groups/:id/trigger with status='queued' and
 * transitions queued → running → success|error|cancelled. Idempotency is
 * enforced via dedup_key: a second trigger with the same dedup_key while
 * an earlier run is still queued/running returns the existing run_id.
 *
 * run_events is the time-ordered log surfaced by GET /api/runs/:id/events
 * and the SSE stream. NanoClaw's container runner is expected to append to
 * this table for any run it processes; the HTTP API itself only reads.
 *
 * Partial UNIQUE INDEX enforces the active-dedup invariant in the DB so
 * the API does not have to rely on a read-then-write race. Completed runs
 * keep their dedup_key for audit but no longer block new triggers.
 */
export const migration016: Migration = {
  version: 16,
  name: 'http-api-runs',
  up(db) {
    db.exec(`
      CREATE TABLE runs (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id      TEXT,
        dedup_key       TEXT,
        status          TEXT NOT NULL DEFAULT 'queued',
                        -- 'queued' | 'running' | 'success' | 'error' | 'cancelled'
        priority        TEXT NOT NULL DEFAULT 'normal',
                        -- 'low' | 'normal' | 'high'
        input           TEXT,           -- JSON encoded
        metrics         TEXT,           -- JSON encoded
        error_message   TEXT,
        parent_run_id   TEXT REFERENCES runs(id),
        created_at      TEXT NOT NULL,
        started_at      TEXT,
        ended_at        TEXT
      );

      CREATE INDEX idx_runs_agent_group ON runs(agent_group_id, started_at DESC);
      CREATE INDEX idx_runs_status ON runs(status, started_at DESC);

      -- Partial unique index: only one active run per dedup_key at a time.
      -- Completed runs (success/error/cancelled) keep the key for audit but
      -- no longer block new triggers.
      CREATE UNIQUE INDEX idx_runs_dedup_active
        ON runs(dedup_key)
        WHERE dedup_key IS NOT NULL AND status IN ('queued', 'running');

      CREATE TABLE run_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        timestamp  TEXT NOT NULL,
        level      TEXT NOT NULL DEFAULT 'info',
                   -- 'debug' | 'info' | 'warn' | 'error'
        message    TEXT NOT NULL,
        data       TEXT             -- JSON encoded, nullable
      );

      CREATE INDEX idx_run_events_run ON run_events(run_id, timestamp);
    `);
  },
};

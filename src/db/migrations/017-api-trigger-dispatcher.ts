import type { Migration } from './index.js';

/**
 * LANE AA: API-trigger dispatcher.
 *
 * Extends the V1 HTTP API foundation (migration 016) into V1.5 — a daemon-side
 * poll loop that picks queued runs and actually wakes containers. This
 * migration is purely additive:
 *
 *   1. Extra columns on `runs`:
 *      - attempt_count   — incremented on transient spawn failures, capped at
 *                          MAX_ATTEMPTS by the dispatcher (then status='error').
 *      - target_entity_id — opaque scope key extracted from input_payload at
 *                          claim time, e.g. a creator_id or queue_item_id.
 *                          The dispatcher uses (agent_group_id, target_entity_id)
 *                          as its per-target concurrency key so two runs
 *                          touching the same logical target don't fan out into
 *                          two containers at once.
 *      - last_poll_at    — timestamp the dispatcher last touched this row.
 *                          Cheap heartbeat used by the status endpoint to
 *                          show "is the dispatcher alive" without a separate
 *                          state table.
 *      - last_alert_at   — set when the backpressure alerter has already
 *                          paged about this row, so we don't fire the same
 *                          webhook every 5s for a stuck queue.
 *
 *   2. Synthetic api-trigger messaging_group. NanoClaw's dispatch path is
 *      session-based: every container wake needs a (session → agent_group,
 *      messaging_group) pair. API-triggered runs are not tied to any real
 *      chat, so we insert one synthetic messaging_group row that owns all of
 *      them. channel_type='api-trigger' is reserved — no adapter registers
 *      for it, so the router's normal inbound path can never match.
 *
 *      Wiring (messaging_group_agents row) is created lazily by the
 *      dispatcher on first use per agent_group so this migration stays
 *      schema-only — it does not need to know which agent_groups exist.
 *
 *   3. Backpressure-alert table (one row, append-only). Records every webhook
 *      fired so the operator can audit. Bounded by the dispatcher to N rows.
 *
 * The agent-runner (container/agent-runner/) is unchanged — it already polls
 * messages_in for any session, regardless of how the session was created.
 */
export const migration017: Migration = {
  version: 17,
  name: 'api-trigger-dispatcher',
  up(db) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN target_entity_id TEXT;
      ALTER TABLE runs ADD COLUMN last_poll_at TEXT;
      ALTER TABLE runs ADD COLUMN last_alert_at TEXT;

      CREATE INDEX idx_runs_target_active
        ON runs(agent_group_id, target_entity_id)
        WHERE status IN ('queued', 'running');

      -- One synthetic messaging_group for ALL API-triggered runs. The
      -- channel_type='api-trigger' value is reserved: no channel adapter
      -- registers for it, so this row can never be hit by the inbound
      -- router. platform_id='internal' makes the (channel_type, platform_id)
      -- UNIQUE constraint trivially safe.
      --
      -- unknown_sender_policy is 'strict' because there is no sender — runs
      -- bypass the access gate entirely (the dispatcher writes messages_in
      -- directly without going through routeInbound). Storing 'strict' as
      -- the documented value still keeps the row safe if someone ever wires
      -- it from a real channel by mistake.
      INSERT INTO messaging_groups
        (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES
        ('mg-api-trigger', 'api-trigger', 'internal', 'API Trigger', 0, 'strict', datetime('now'));

      CREATE TABLE dispatcher_alerts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        fired_at      TEXT NOT NULL,
        kind          TEXT NOT NULL,        -- 'backpressure' | 'spawn_failure'
        queued_count  INTEGER,
        oldest_age_s  INTEGER,
        webhook_url   TEXT,
        http_status   INTEGER,
        error         TEXT
      );
      CREATE INDEX idx_dispatcher_alerts_fired ON dispatcher_alerts(fired_at DESC);
    `);
  },
};

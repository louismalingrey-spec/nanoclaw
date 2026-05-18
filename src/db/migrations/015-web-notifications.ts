import type { Migration } from './index.js';

/**
 * Notification inbox for the NanoClaw OS workspace.
 *
 * Agents call the `notify` MCP tool to surface things the user should see
 * when they get back: cron completions, errors needing attention,
 * background-task done pings. Distinct from `pending_approvals` (require
 * a click) and `messages_out` (conversational replies).
 *
 * `read_at` is nullable — null = unread, ISO string = read.
 */
export const migration015: Migration = {
  version: 15,
  name: 'web-notifications',
  up(db) {
    db.exec(`
      CREATE TABLE web_notifications (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        kind           TEXT NOT NULL DEFAULT 'info',
        title          TEXT NOT NULL,
        body           TEXT,
        created_at     TEXT NOT NULL,
        read_at        TEXT
      );
      CREATE INDEX idx_web_notifications_agent_group ON web_notifications(agent_group_id);
      CREATE INDEX idx_web_notifications_unread
        ON web_notifications(agent_group_id, created_at)
        WHERE read_at IS NULL;
    `);
  },
};

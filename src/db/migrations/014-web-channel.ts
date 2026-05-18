import type { Migration } from './index.js';

/**
 * Web channel tables.
 *
 *   web_sessions  — bearer-token auth for the NanoClaw OS workspace UI.
 *   web_apps      — persistent OpenUI Lang programs (`app_create` MCP tool).
 *   web_artifacts — markdown documents the agent saves for later
 *                   (`create_markdown_artifact` / `update_markdown_artifact`).
 *
 * All three are scoped per-user / per-agent-group so ON DELETE CASCADE
 * from the parent rows wipes their dependents cleanly.
 */
export const migration014: Migration = {
  version: 14,
  name: 'web-channel',
  up(db) {
    db.exec(`
      CREATE TABLE web_sessions (
        token         TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id),
        label         TEXT,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT
      );
      CREATE INDEX idx_web_sessions_user ON web_sessions(user_id);

      CREATE TABLE web_apps (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        code           TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX idx_web_apps_agent_group ON web_apps(agent_group_id);

      CREATE TABLE web_artifacts (
        id             TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        kind           TEXT NOT NULL DEFAULT 'markdown',
        content        TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX idx_web_artifacts_agent_group ON web_artifacts(agent_group_id);
    `);
  },
};

/**
 * DAO for the web channel — auth tokens + persistent OpenUI surfaces.
 *
 * Three tables, three roles:
 *   • web_sessions       — bearer tokens that gate WS connections to the
 *                          workspace. One row per issued token; resolves
 *                          to a NanoClaw `user.id`.
 *   • web_apps           — OpenUI Lang programs the agent saved with
 *                          `app_create`. Listed in the sidebar, opened
 *                          in a right-side renderer panel.
 *   • web_artifacts      — markdown documents from `create_markdown_artifact`.
 *   • web_notifications  — inbox items from `notify`.
 */
import { getDb } from './connection.js';

export interface WebSession {
  token: string;
  user_id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface WebApp {
  id: string;
  agent_group_id: string;
  name: string;
  code: string;
  created_at: string;
  updated_at: string;
}

export interface WebArtifact {
  id: string;
  agent_group_id: string;
  name: string;
  kind: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface WebNotification {
  id: string;
  agent_group_id: string;
  kind: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
}

// ── web_sessions ──────────────────────────────────────────────────────────

export function createWebSession(s: WebSession): void {
  getDb()
    .prepare(
      `INSERT INTO web_sessions (token, user_id, label, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(s.token, s.user_id, s.label, s.created_at, s.last_used_at);
}

export function getWebSession(token: string): WebSession | undefined {
  return getDb().prepare('SELECT * FROM web_sessions WHERE token = ?').get(token) as WebSession | undefined;
}

export function touchWebSession(token: string, at: string): void {
  getDb().prepare('UPDATE web_sessions SET last_used_at = ? WHERE token = ?').run(at, token);
}

export function deleteWebSession(token: string): void {
  getDb().prepare('DELETE FROM web_sessions WHERE token = ?').run(token);
}

// ── web_apps ──────────────────────────────────────────────────────────────

export function upsertWebApp(a: WebApp): void {
  getDb()
    .prepare(
      `INSERT INTO web_apps (id, agent_group_id, name, code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name       = excluded.name,
         code       = excluded.code,
         updated_at = excluded.updated_at`,
    )
    .run(a.id, a.agent_group_id, a.name, a.code, a.created_at, a.updated_at);
}

export function getWebApp(id: string): WebApp | undefined {
  return getDb().prepare('SELECT * FROM web_apps WHERE id = ?').get(id) as WebApp | undefined;
}

export function listWebAppsByAgentGroup(agentGroupId: string): WebApp[] {
  return getDb()
    .prepare('SELECT * FROM web_apps WHERE agent_group_id = ? ORDER BY updated_at DESC')
    .all(agentGroupId) as WebApp[];
}

// ── web_artifacts ─────────────────────────────────────────────────────────

export function upsertWebArtifact(a: WebArtifact): void {
  getDb()
    .prepare(
      `INSERT INTO web_artifacts (id, agent_group_id, name, kind, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name       = excluded.name,
         kind       = excluded.kind,
         content    = excluded.content,
         updated_at = excluded.updated_at`,
    )
    .run(a.id, a.agent_group_id, a.name, a.kind, a.content, a.created_at, a.updated_at);
}

export function getWebArtifact(id: string): WebArtifact | undefined {
  return getDb().prepare('SELECT * FROM web_artifacts WHERE id = ?').get(id) as WebArtifact | undefined;
}

export function listWebArtifactsByAgentGroup(agentGroupId: string): WebArtifact[] {
  return getDb()
    .prepare('SELECT * FROM web_artifacts WHERE agent_group_id = ? ORDER BY updated_at DESC')
    .all(agentGroupId) as WebArtifact[];
}

// ── web_notifications ─────────────────────────────────────────────────────

export function createWebNotification(n: WebNotification): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO web_notifications
         (id, agent_group_id, kind, title, body, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(n.id, n.agent_group_id, n.kind, n.title, n.body, n.created_at, n.read_at);
}

export function listWebNotificationsByAgentGroup(agentGroupId: string, limit = 50): WebNotification[] {
  return getDb()
    .prepare('SELECT * FROM web_notifications WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentGroupId, limit) as WebNotification[];
}

export function countUnreadNotifications(agentGroupId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM web_notifications WHERE agent_group_id = ? AND read_at IS NULL')
    .get(agentGroupId) as { n: number };
  return row.n;
}

export function markNotificationRead(id: string, readAt: string): void {
  getDb().prepare('UPDATE web_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(readAt, id);
}

export function markAllNotificationsRead(agentGroupId: string, readAt: string): void {
  getDb()
    .prepare('UPDATE web_notifications SET read_at = ? WHERE agent_group_id = ? AND read_at IS NULL')
    .run(readAt, agentGroupId);
}

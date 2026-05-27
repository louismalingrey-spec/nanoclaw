/**
 * Per-agent-group sandbox SQLite — backing store for OpenUI Lang Query()
 * calls in persistent apps.
 *
 * Layout: `data/v2-web/<agent_group_id>/data.db`. Each agent group has
 * one isolated scratch DB. The agent's `db_execute` MCP tool runs writes
 * (schema + seed), the workspace UI's `db.query` RPC runs read-only
 * SELECTs. The host mediates both — the container never opens this
 * file directly.
 *
 * Connections are cached per agent_group_id with a small LRU eviction.
 * WAL is on for read-while-write concurrency between the UI's polling
 * Query() loops and the agent's occasional writes.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

const SANDBOX_ROOT = path.join(DATA_DIR, 'v2-web');
const MAX_OPEN = 8;

const cache = new Map<string, { db: Database.Database; lastUsed: number }>();

function sandboxPath(agentGroupId: string): string {
  // Sanitize — the id is user-derived; defense-in-depth.
  const safe = agentGroupId.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(SANDBOX_ROOT, safe, 'data.db');
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_OPEN) return;
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [k, v] of cache) {
    if (v.lastUsed < oldestTs) {
      oldestTs = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey) {
    const entry = cache.get(oldestKey);
    try {
      entry?.db.close();
    } catch (err) {
      log.warn('Failed to close evicted sandbox DB', { agentGroupId: oldestKey, err });
    }
    cache.delete(oldestKey);
  }
}

/** Get-or-open the sandbox DB for an agent group (creates the file if missing). */
export function getSandboxDb(agentGroupId: string): Database.Database {
  const cached = cache.get(agentGroupId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.db;
  }
  const file = sandboxPath(agentGroupId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  cache.set(agentGroupId, { db, lastUsed: Date.now() });
  evictIfNeeded();
  log.info('Opened sandbox DB', { agentGroupId, file });
  return db;
}

export function closeAllSandboxes(): void {
  for (const [k, v] of cache) {
    try {
      v.db.close();
    } catch (err) {
      log.warn('Failed to close sandbox DB at shutdown', { agentGroupId: k, err });
    }
  }
  cache.clear();
}

/**
 * Validate a SQL statement is read-only for the public UI RPC. Strips
 * leading comments, then requires a starting keyword from the safe set.
 *
 * This is the only line of defense between a bearer-token holder and
 * arbitrary writes against the sandbox DB. Keep it conservative.
 */
export function isReadOnlySql(sql: string): boolean {
  const stripped = sql
    .replace(/^\s*(?:(?:--[^\n]*\n)\s*|(?:\/\*[\s\S]*?\*\/)\s*)*/u, '')
    .trimStart()
    .toLowerCase();
  return (
    stripped.startsWith('select') ||
    stripped.startsWith('with') ||
    stripped.startsWith('pragma') ||
    stripped.startsWith('explain')
  );
}

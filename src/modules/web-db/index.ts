/**
 * Handle the container's `db_execute` system action.
 *
 * The agent uses `db_execute` to set up schema + seed rows in its
 * per-agent-group sandbox SQLite. The UI's apps then `Query("sql", ...)`
 * which the web channel's `db.query` RPC reads back from the same file.
 *
 * Errors are surfaced as `event:db.error` to any open workspace tab so
 * the user can see what went wrong; the agent will also receive an
 * async chat-back if we wire that later.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getSandboxDb } from '../../db/web-sandbox.js';
import type { Session } from '../../types.js';

interface DbExecuteAction {
  action: 'db_execute';
  sql: string;
  params?: unknown[] | Record<string, unknown>;
}

async function handleDbExecute(content: Record<string, unknown>, session: Session): Promise<void> {
  const p = content as unknown as Partial<DbExecuteAction>;
  if (typeof p.sql !== 'string' || p.sql.length === 0) {
    log.warn('db_execute: missing sql', { sessionId: session.id });
    return;
  }
  const db = getSandboxDb(session.agent_group_id);
  let info: { changes: number; lastInsertRowid: number | bigint };
  try {
    const stmt = db.prepare(p.sql);
    if (Array.isArray(p.params)) {
      info = stmt.run(...p.params);
    } else if (p.params && typeof p.params === 'object') {
      info = stmt.run(p.params as Record<string, unknown>);
    } else {
      info = stmt.run();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('db_execute failed', { agentGroupId: session.agent_group_id, err: msg });
    notify(session.agent_group_id, 'db.error', { sql: p.sql.slice(0, 200), message: msg });
    return;
  }
  log.info('db_execute applied', {
    agentGroupId: session.agent_group_id,
    changes: info.changes,
    bytes: p.sql.length,
  });
  // Tell any open UI tabs to invalidate their Query caches.
  notify(session.agent_group_id, 'db.changed', { changes: info.changes });
}

function notify(agentGroupId: string, event: string, payload: unknown): void {
  const adapter = getChannelAdapter('web') as
    | (ReturnType<typeof getChannelAdapter> & {
        broadcastToAgentGroup?: (g: string, e: string, p: unknown) => void;
      })
    | undefined;
  adapter?.broadcastToAgentGroup?.(agentGroupId, event, payload);
}

registerDeliveryAction('db_execute', handleDbExecute);

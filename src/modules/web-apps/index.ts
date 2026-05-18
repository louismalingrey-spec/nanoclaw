/**
 * Persist + broadcast OpenUI Lang apps created by the container's
 * `app_create` MCP tool. The agent writes a `messages_out` row with
 *   kind = 'system'
 *   content = { action: 'openui_app_create', app_id, name, code }
 * the host's delivery loop dispatches via `registerDeliveryAction`,
 * and we land here.
 *
 * On success we also fan out `event:app.changed` so any open workspace
 * tab subscribed to this agent_group refreshes its sidebar.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getWebApp, upsertWebApp } from '../../db/web.js';
import type { Session } from '../../types.js';

interface AppCreateAction {
  action: 'openui_app_create';
  app_id: string;
  name: string;
  code: string;
}

async function handleAppCreate(content: Record<string, unknown>, session: Session): Promise<void> {
  const p = content as unknown as Partial<AppCreateAction>;
  if (typeof p.app_id !== 'string' || typeof p.name !== 'string' || typeof p.code !== 'string') {
    log.warn('openui_app_create: malformed payload', { sessionId: session.id });
    return;
  }
  const now = new Date().toISOString();
  const existing = getWebApp(p.app_id);
  upsertWebApp({
    id: p.app_id,
    agent_group_id: session.agent_group_id,
    name: p.name,
    code: p.code,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  log.info('openui_app_create: persisted', {
    appId: p.app_id,
    agentGroupId: session.agent_group_id,
    name: p.name,
    bytes: p.code.length,
  });

  const adapter = getChannelAdapter('web') as
    | (ReturnType<typeof getChannelAdapter> & {
        broadcastToAgentGroup?: (g: string, e: string, p: unknown) => void;
      })
    | undefined;
  adapter?.broadcastToAgentGroup?.(session.agent_group_id, 'app.changed', {
    app_id: p.app_id,
    name: p.name,
    updated_at: now,
  });
}

registerDeliveryAction('openui_app_create', handleAppCreate);

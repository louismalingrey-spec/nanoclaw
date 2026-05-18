/**
 * Persist + broadcast notifications from the container's `notify` tool.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { createWebNotification } from '../../db/web.js';
import type { Session } from '../../types.js';

interface NotifyCreateAction {
  action: 'notify_create';
  notification_id: string;
  kind: string;
  title: string;
  body?: string;
}

async function handleNotifyCreate(content: Record<string, unknown>, session: Session): Promise<void> {
  const p = content as unknown as Partial<NotifyCreateAction>;
  if (typeof p.notification_id !== 'string' || typeof p.title !== 'string') {
    log.warn('notify_create: malformed payload', { sessionId: session.id });
    return;
  }
  const now = new Date().toISOString();
  createWebNotification({
    id: p.notification_id,
    agent_group_id: session.agent_group_id,
    kind: p.kind || 'info',
    title: p.title,
    body: typeof p.body === 'string' ? p.body : null,
    created_at: now,
    read_at: null,
  });
  log.info('notify_create: persisted', { agentGroupId: session.agent_group_id, kind: p.kind, title: p.title });
  const adapter = getChannelAdapter('web') as
    | (ReturnType<typeof getChannelAdapter> & {
        broadcastToAgentGroup?: (g: string, e: string, p: unknown) => void;
      })
    | undefined;
  adapter?.broadcastToAgentGroup?.(session.agent_group_id, 'notification.new', {
    id: p.notification_id,
    kind: p.kind || 'info',
    title: p.title,
    body: p.body,
    created_at: now,
  });
}

registerDeliveryAction('notify_create', handleNotifyCreate);

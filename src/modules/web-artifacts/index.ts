/**
 * Persist markdown artifacts the container's `create_markdown_artifact`
 * / `update_markdown_artifact` tools emit. Fans out `artifact.changed`
 * to open workspace tabs.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getWebArtifact, upsertWebArtifact } from '../../db/web.js';
import type { Session } from '../../types.js';

interface ArtifactCreateAction {
  action: 'artifact_create';
  artifact_id: string;
  name: string;
  kind: string;
  content: string;
}

interface ArtifactUpdateAction {
  action: 'artifact_update';
  artifact_id: string;
  name?: string;
  content: string;
}

async function handleArtifactCreate(content: Record<string, unknown>, session: Session): Promise<void> {
  const p = content as unknown as Partial<ArtifactCreateAction>;
  if (typeof p.artifact_id !== 'string' || typeof p.name !== 'string' || typeof p.content !== 'string') {
    log.warn('artifact_create: malformed payload', { sessionId: session.id });
    return;
  }
  const now = new Date().toISOString();
  upsertWebArtifact({
    id: p.artifact_id,
    agent_group_id: session.agent_group_id,
    name: p.name,
    kind: p.kind || 'markdown',
    content: p.content,
    created_at: now,
    updated_at: now,
  });
  log.info('artifact_create: persisted', { artifactId: p.artifact_id, bytes: p.content.length });
  broadcast(session.agent_group_id, p.artifact_id, p.name, now);
}

async function handleArtifactUpdate(content: Record<string, unknown>, session: Session): Promise<void> {
  const p = content as unknown as Partial<ArtifactUpdateAction>;
  if (typeof p.artifact_id !== 'string' || typeof p.content !== 'string') {
    log.warn('artifact_update: malformed', { sessionId: session.id });
    return;
  }
  const existing = getWebArtifact(p.artifact_id);
  if (!existing) {
    log.warn('artifact_update: id not found', { artifactId: p.artifact_id });
    return;
  }
  // Defense — agents in different groups must not edit each other's
  // artifacts even if they guess the id.
  if (existing.agent_group_id !== session.agent_group_id) {
    log.warn('artifact_update: cross-group attempt blocked', {
      artifactId: p.artifact_id,
      agentGroupId: session.agent_group_id,
    });
    return;
  }
  const now = new Date().toISOString();
  const name = p.name && p.name.trim() ? p.name : existing.name;
  upsertWebArtifact({
    id: p.artifact_id,
    agent_group_id: existing.agent_group_id,
    name,
    kind: existing.kind,
    content: p.content,
    created_at: existing.created_at,
    updated_at: now,
  });
  log.info('artifact_update: applied', { artifactId: p.artifact_id, bytes: p.content.length });
  broadcast(existing.agent_group_id, p.artifact_id, name, now);
}

function broadcast(agentGroupId: string, artifactId: string, name: string, updatedAt: string): void {
  const adapter = getChannelAdapter('web') as
    | (ReturnType<typeof getChannelAdapter> & {
        broadcastToAgentGroup?: (g: string, e: string, p: unknown) => void;
      })
    | undefined;
  adapter?.broadcastToAgentGroup?.(agentGroupId, 'artifact.changed', {
    artifact_id: artifactId,
    name,
    updated_at: updatedAt,
  });
}

registerDeliveryAction('artifact_create', handleArtifactCreate);
registerDeliveryAction('artifact_update', handleArtifactUpdate);

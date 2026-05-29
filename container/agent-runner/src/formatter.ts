import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config', '/start']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

/**
 * Narrow check for /clear — the only command the runner handles directly.
 * All other command gating (filtered, admin) is done by the host router
 * before messages reach the container.
 */
export function isClearCommand(msg: MessageInRow): boolean {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  return text.toLowerCase().startsWith('/clear');
}

/**
 * True for any chat that needs the outer loop's command path: /clear plus
 * admin/passthrough slash commands the SDK can only dispatch when they are
 * a query's first input. Used by the follow-up poller to bail out and let
 * the outer loop reopen the query.
 */
export function isRunnerCommand(msg: MessageInRow): boolean {
  if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') return false;
  const cat = categorizeMessage(msg).category;
  return cat === 'admin' || cat === 'passthrough';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 *
 * Prepends a `<context timezone="<IANA>" />` header so the agent always knows
 * what timezone it's in — every timestamp it sees in message bodies is the
 * user's local time, and every time it produces (schedules, suggests) should
 * be interpreted as local time in that same zone. This header is v1 behavior
 * (src/v1/router.ts:20-22); dropping it led to misinterpretations where the
 * agent scheduled tasks for the wrong hour.
 *
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  const header = `<context timezone="${escapeXml(TIMEZONE)}" />\n`;
  if (messages.length === 0) return header;

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return header + parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    lines.push(formatSingleChat(msg));
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatLocalTime(msg.timestamp, TIMEZONE);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyAttr = content.replyTo?.id ? ` reply_to="${escapeXml(String(content.replyTo.id))}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  // Look up the destination name for the origin (reverse map lookup).
  // If not found, fall back to a raw channel:platform_id marker so nothing
  // gets silently dropped — this should only happen if the destination was
  // removed between when the message was received and when it's being processed.
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  const fromAttr = fromDest
    ? ` from="${escapeXml(fromDest.name)}"`
    : msg.channel_type || msg.platform_id
      ? ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`
      : '';

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${escapeXml(time)}"${replyAttr}>${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const parts = ['[SCHEDULED TASK]'];
  if (content.scriptOutput) {
    parts.push('', 'Script output:', JSON.stringify(content.scriptOutput, null, 2));
  }
  parts.push('', 'Instructions:', content.prompt || '');
  return parts.join('\n');
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  return `[WEBHOOK: ${source}/${event}]\n\n${JSON.stringify(content.payload || content, null, 2)}`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);

  // Host dispatcher → agent: a queued HTTP API run was claimed and dispatched
  // here. The agent should see the run_id (so it can correlate logs / write a
  // structured response) plus the actual input payload.
  if (content?.type === 'api_trigger') {
    // LANE H V1.5: when the dispatcher includes a `skill_content` markdown
    // body, emit the [SKILL EXECUTION REQUEST] prompt shape — the agent
    // reads the procedure inline and follows it step-by-step rather than
    // staring at an opaque `Input: {…}` blob (which was the V1 behavior
    // that produced `Result: (empty)` for every manual exec).
    const hasSkillContent =
      typeof content.skill_content === 'string' && content.skill_content.length > 0;
    if (hasSkillContent) {
      return formatSkillExecutionRequest(content);
    }

    // LANE #61 — defense in depth. The HTTP API rejects skill triggers
    // missing `skill_content` (see http-api/server.ts), but legacy rows
    // already in messages_in and direct CLI test harnesses may bypass
    // that check. When a stored api_trigger carries `skill_slug` (i.e.
    // the caller meant to execute a skill) but no `skill_content`, the
    // legacy V1 shape would hand the agent an empty-instructions prompt
    // and the SDK turn ends with `Result: (empty)` — outcome=null in
    // agency-os. Instead, surface the configuration error so the
    // operator sees a clear failure message rather than silent nothing.
    const hasSkillSlug = typeof content.skill_slug === 'string' && content.skill_slug.length > 0;
    if (hasSkillSlug) {
      return formatSkillContentMissingError(content);
    }

    const lines = ['[API TRIGGER]'];
    if (content.run_id) lines.push(`run_id: ${content.run_id}`);
    if (content.dedup_key) lines.push(`dedup_key: ${content.dedup_key}`);
    if (content.priority) lines.push(`priority: ${content.priority}`);
    if (content.target_entity_id) lines.push(`target_entity_id: ${content.target_entity_id}`);
    lines.push('', 'Input:', JSON.stringify(content.input ?? {}, null, 2));
    return lines.join('\n');
  }

  return `[SYSTEM RESPONSE]\n\nAction: ${content.action || 'unknown'}\nStatus: ${content.status || 'unknown'}\nResult: ${JSON.stringify(content.result || null)}`;
}

/**
 * Build the structured [SKILL EXECUTION REQUEST] prompt the agent sees
 * inside the container. The shape is fixed by LANE H spec — the agent
 * reads `INSTRUCTIONS` (the skill markdown body) and follows it.
 *
 * `input` is JSON-stringified and inlined so the agent can read its own
 * input dict (the agency-os caller passes `{_manual: true, _dry_run:
 * bool, ...}` plus skill-specific fields). The trailing paragraph is
 * fixed; it tells the agent how to interpret the `_dry_run` / `_manual`
 * flags consistently across skills.
 */
/**
 * LANE #61 — Fallback prompt when an api_trigger has `skill_slug` (the
 * caller intended a skill execution) but no `skill_content` (the markdown
 * body the agent-runner needs to read). The HTTP API now rejects this
 * shape at the boundary, but stored rows and legacy callers can still
 * reach here. Without a clear instruction the model emits an empty turn
 * (`Result: (empty)`) and outcome ends up null in agency-os, which made
 * the original "intermittent text=null" symptom hard to debug.
 *
 * We instruct the model to respond with a single, fixed structured error
 * string. That string lands in messages_out → runs.outcome via the normal
 * harvest path, so the operator sees the configuration error explicitly
 * instead of silent nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatSkillContentMissingError(content: any): string {
  const slug = typeof content.skill_slug === 'string' ? content.skill_slug : 'unknown';
  const version =
    typeof content.skill_version === 'number' && Number.isFinite(content.skill_version)
      ? `v${content.skill_version}`
      : 'v?';
  const lines: string[] = [
    '[SKILL EXECUTION REQUEST — MALFORMED]',
    `skill: ${slug} (${version})`,
  ];
  if (content.run_id) lines.push(`run_id: ${content.run_id}`);
  lines.push('input: ' + JSON.stringify(content.input ?? {}));
  lines.push('');
  lines.push(
    'CONFIGURATION ERROR: this skill trigger arrived without a `skill_content` ' +
      'markdown body. The agent-runner needs the procedure inline (it has no ' +
      'on-disk skill registry) so there is no way to execute the skill.',
  );
  lines.push('');
  lines.push(
    'Respond with EXACTLY this single line and nothing else, no commentary, ' +
      'no tool calls:',
  );
  lines.push('');
  lines.push(
    `SKILL_CONTENT_MISSING: skill_slug=${slug} ${version} triggered without skill_content. ` +
      'Caller must include the full skill markdown body on the api_trigger payload. ' +
      'See LANE #61.',
  );
  return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatSkillExecutionRequest(content: any): string {
  const slug = typeof content.skill_slug === 'string' ? content.skill_slug : 'unknown';
  const version =
    typeof content.skill_version === 'number' && Number.isFinite(content.skill_version)
      ? `v${content.skill_version}`
      : 'v?';
  const lines: string[] = ['[SKILL EXECUTION REQUEST]', `skill: ${slug} (${version})`];
  if (content.run_id) lines.push(`run_id: ${content.run_id}`);
  if (content.target_entity_id) lines.push(`target_entity_id: ${content.target_entity_id}`);
  lines.push('input: ' + JSON.stringify(content.input ?? {}));
  lines.push('');
  lines.push('INSTRUCTIONS:');
  lines.push(String(content.skill_content));
  lines.push('');
  lines.push(
    'Read INSTRUCTIONS above, follow the Procédure step-by-step, honour ' +
      'input flags (_dry_run = produce structured output without side-effects, ' +
      '_manual = founder-triggered), and respond with the final outcome.',
  );
  return lines.join('\n');
}

/**
 * Render the quoted original inside the <message> body.
 *
 * Matches v1 format (src/v1/router.ts:10-18): `<quoted_message from="X">Y</quoted_message>`.
 * Requires BOTH sender and text — if only id is present the reply_to attribute
 * on the parent <message> carries the link without an inline preview.
 *
 * No truncation here (v1 didn't truncate).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender;
  const text = replyTo.text;
  if (!sender || !text) return '';
  return `\n  <quoted_message from="${escapeXml(sender)}">${escapeXml(text)}</quoted_message>\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]`;
    }
    return url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip `<internal>...</internal>` blocks from agent output, then trim.
 * Ported from v1 (src/v1/router.ts:25-27). Used to remove the agent's
 * own scratchpad/reasoning before a reply goes out over a channel.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Web channel — NanoClaw OS workspace UI over HTTP + WebSocket.
 *
 * The host runs a small Fastify-less HTTP server that:
 *   • serves the prebuilt React UI from `web/dist/` (built separately)
 *   • exposes `POST /auth/issue` (gated by `WEB_ADMIN_SECRET` header) for
 *     the owner to mint bearer tokens
 *   • hosts a `/ws` WebSocket endpoint authenticated by bearer token
 *
 * Each authenticated socket maps to a NanoClaw user via `web_sessions`,
 * and from there `canAccessAgentGroup` gates every per-agent RPC.
 *
 * Outbound message rows for a user's web messaging-group platform_id
 * (`web:<user_id>:<agent_group_id>`) get fanned out to their open
 * sockets as `event:chat.final` frames. `setTyping` (called by the
 * typing module while a container is busy) becomes `event:chat.typing`.
 *
 * Disabled by default — the factory returns `null` unless `WEB_PORT` is
 * set, mirroring how every other channel adapter gates on credentials.
 *
 * To enable, add to `.env`:
 *   WEB_PORT=7117
 *   WEB_ADMIN_SECRET=<openssl rand -hex 32>
 */
import { randomBytes } from 'crypto';
import { createReadStream, statSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { URL } from 'url';
import { WebSocketServer, type WebSocket } from 'ws';

import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { openInboundDb, openOutboundDb } from '../../session-manager.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { createUser, getUser } from '../../modules/permissions/db/users.js';
import {
  createWebSession,
  getWebApp,
  getWebSession,
  listWebAppsByAgentGroup,
  touchWebSession,
} from '../../db/web.js';
import { closeAllSandboxes, getSandboxDb, isReadOnlySql } from '../../db/web-sandbox.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';
import type { ClientFrame, RequestFrame, ResponseFrame, ServerFrame } from './protocol.js';

const CHANNEL_TYPE = 'web';

/** Build the per-user platform_id for a (user, agent_group) pair. */
export function platformIdFor(userId: string, agentGroupId: string): string {
  return `web:${userId}:${agentGroupId}`;
}

/** Parse the platform_id back into (user_id, agent_group_id). user_id may
 *  contain its own ":" (e.g. "slack:U123"), so we split on the LAST colon. */
export function parsePlatformId(platformId: string): { userId: string; agentGroupId: string } | null {
  if (!platformId.startsWith('web:')) return null;
  const rest = platformId.slice('web:'.length);
  const idx = rest.lastIndexOf(':');
  if (idx < 0) return null;
  return { userId: rest.slice(0, idx), agentGroupId: rest.slice(idx + 1) };
}

interface AuthedSocket {
  ws: WebSocket;
  userId: string;
}

/** Adapter type with the cross-module broadcast helper added. Other host
 *  modules (openui-apps, web-notifications, …) discover this via
 *  `getChannelAdapter('web')` and call it to push fan-out events. */
export type WebChannelAdapter = ChannelAdapter & {
  broadcastToAgentGroup: (agentGroupId: string, event: string, payload: unknown) => void;
};

function createAdapter(): ChannelAdapter | null {
  // Read both env sources: explicit process.env (set by launchd plist or
  // shell) takes precedence, falling back to the .env file via readEnvFile.
  // This is the same pattern src/config.ts uses for ONECLI_URL etc., and
  // it MATTERS — setting WEB_PORT only in .env without this fallback was
  // a bug in the earlier prototype that made the adapter silently skip.
  const envFile = readEnvFile(['WEB_PORT', 'WEB_ADMIN_SECRET']);
  const portStr = process.env.WEB_PORT ?? envFile.WEB_PORT ?? '';
  const port = parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  const adminSecret = process.env.WEB_ADMIN_SECRET ?? envFile.WEB_ADMIN_SECRET ?? '';

  let httpServer: Server | null = null;
  let wss: WebSocketServer | null = null;
  // platformId → sockets currently listening for that mg's outbound stream.
  // A user with two tabs open keeps two entries; deliver() fans out to both.
  const subscribers = new Map<string, Set<AuthedSocket>>();

  function subscribe(platformId: string, socket: AuthedSocket): void {
    let set = subscribers.get(platformId);
    if (!set) {
      set = new Set();
      subscribers.set(platformId, set);
    }
    set.add(socket);
  }

  function unsubscribeAll(socket: AuthedSocket): void {
    for (const set of subscribers.values()) set.delete(socket);
  }

  /** Cross-module fan-out: push an event to every socket whose subscribed
   *  platform_id ends with `:<agentGroupId>`. Used by openui-apps,
   *  web-notifications, web-artifacts to notify open tabs of changes. */
  function broadcastToAgentGroup(agentGroupId: string, event: string, payload: unknown): void {
    const suffix = `:${agentGroupId}`;
    const frame: ServerFrame = { type: 'event', event, payload };
    const json = JSON.stringify(frame);
    for (const [platformId, set] of subscribers) {
      if (!platformId.endsWith(suffix)) continue;
      for (const sub of set) {
        try {
          sub.ws.send(json);
        } catch {
          // socket may be closing; outer poll will retry on next tick
        }
      }
    }
  }

  const adapter: WebChannelAdapter = {
    name: 'web',
    channelType: CHANNEL_TYPE,
    // The web channel models a single conversation per (user × agent_group)
    // — threads aren't a first-class concept like on Slack/Discord. Replies
    // go to the same mg/session every time.
    supportsThreads: false,

    broadcastToAgentGroup,

    async setup(config: ChannelSetup): Promise<void> {
      httpServer = createServer((req, res) => handleHttp(req, res, adminSecret));
      wss = new WebSocketServer({ noServer: true });

      httpServer.on('upgrade', (req, socket, head) => {
        if (!req.url || !req.url.startsWith('/ws')) {
          socket.destroy();
          return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
          handleSocket(ws, config, subscribe, unsubscribeAll);
        });
      });

      await new Promise<void>((resolve, reject) => {
        httpServer!.once('error', reject);
        httpServer!.listen(port, '127.0.0.1', () => {
          log.info('Web channel listening', { port });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (wss) {
        for (const ws of wss.clients) {
          try {
            ws.close();
          } catch {
            // swallow
          }
        }
        wss.close();
        wss = null;
      }
      if (httpServer) {
        await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
        httpServer = null;
      }
      subscribers.clear();
      // Release the sandbox DB handles we accumulated while serving;
      // other modules may have opened their own too, close() is idempotent.
      closeAllSandboxes();
    },

    isConnected(): boolean {
      return httpServer !== null;
    },

    /**
     * Called by the typing module while the container is actively processing
     * an inbound. Re-fires every ~4s. We surface as `event:chat.typing` so
     * the UI shows a thinking indicator the whole time the agent works.
     */
    async setTyping(platformId: string): Promise<void> {
      const set = subscribers.get(platformId);
      if (!set || set.size === 0) return;
      const parsed = parsePlatformId(platformId);
      if (!parsed) return;
      const frame: ServerFrame = {
        type: 'event',
        event: 'chat.typing',
        payload: { agent_group_id: parsed.agentGroupId, ts: new Date().toISOString() },
      };
      const json = JSON.stringify(frame);
      for (const sub of set) {
        try {
          sub.ws.send(json);
        } catch {
          // swallow
        }
      }
    },

    /**
     * Push an outbound message_row to every subscribed socket for the
     * recipient's web platform_id. Idempotent — no DB write here; the row
     * has already been persisted by the agent runner and the host's
     * delivery loop is calling us to fan it out.
     */
    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const set = subscribers.get(platformId);
      if (!set || set.size === 0) return undefined;
      const parsed = parsePlatformId(platformId);
      if (!parsed) return undefined;
      const frame: ServerFrame = {
        type: 'event',
        event: 'chat.final',
        payload: {
          agent_group_id: parsed.agentGroupId,
          kind: message.kind,
          content: message.content,
          ts: new Date().toISOString(),
        },
      };
      const json = JSON.stringify(frame);
      for (const sub of set) {
        try {
          sub.ws.send(json);
        } catch (err) {
          log.warn('web.deliver: send failed', { err });
        }
      }
      return undefined;
    },
  };

  return adapter;
}

// ── Session previews + chat history readers ──────────────────────────────

interface SessionPreviewRow {
  id: string;
  agent_group_id: string;
  thread_id: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
  created_at: string;
  channel_type: string | null;
  /** Best-effort label — first user message or thread_id fallback. */
  title: string;
  /** Most recent message text (in or out), trimmed for preview. */
  last_preview: string;
  /** Most recent activity timestamp across in + out. */
  last_at: string;
  /** Total chat-kind messages (in + out). */
  message_count: number;
}

/** Walk each session's two DBs to derive a human-readable summary. One
 *  inbound + outbound DB open per session; we accept that cost because
 *  sessions per agent_group are O(tens) for any realistic install.
 *
 *  Defensive: a missing or corrupt DB surfaces with empty preview rather
 *  than crashing the whole `sessions.list` reply. */
function readSessionPreviews(
  agentGroupId: string,
  sessions: ReturnType<typeof getSessionsByAgentGroup>,
): SessionPreviewRow[] {
  const out: SessionPreviewRow[] = [];
  for (const s of sessions) {
    const mg = s.messaging_group_id
      ? (() => {
          try {
            return getMessagingGroup(s.messaging_group_id!) ?? null;
          } catch {
            return null;
          }
        })()
      : null;

    let firstUserText = '';
    let lastText = '';
    let lastAt = s.last_active ?? s.created_at;
    let msgCount = 0;

    let inDb: ReturnType<typeof openInboundDb> | null = null;
    try {
      inDb = openInboundDb(agentGroupId, s.id);
      const rows = inDb
        .prepare(
          `SELECT content, timestamp FROM messages_in
           WHERE kind IN ('chat', 'chat-sdk') AND COALESCE(status, '') != 'paused'
           ORDER BY seq ASC`,
        )
        .all() as Array<{ content: string; timestamp: string }>;
      rows.forEach((r, i) => {
        const t = extractText(r.content);
        if (i === 0 && t) firstUserText = t;
        if (t) {
          lastText = t;
          if (r.timestamp > lastAt) lastAt = r.timestamp;
        }
      });
      msgCount += rows.length;
    } catch {
      // inbound DB missing — fine, we'll just show what we have
    } finally {
      inDb?.close();
    }

    let outDb: ReturnType<typeof openOutboundDb> | null = null;
    try {
      outDb = openOutboundDb(agentGroupId, s.id);
      const rows = outDb
        .prepare(`SELECT content, timestamp FROM messages_out WHERE kind = 'chat' ORDER BY seq ASC`)
        .all() as Array<{ content: string; timestamp: string }>;
      for (const r of rows) {
        const t = extractText(r.content);
        if (t) {
          lastText = t;
          if (r.timestamp > lastAt) lastAt = r.timestamp;
        }
      }
      msgCount += rows.length;
    } catch {
      // outbound DB missing — same
    } finally {
      outDb?.close();
    }

    // Title heuristic: prefer the user's opening line; fall back to a
    // suffix of the platform thread id; last resort, the session's
    // created_at as a local date string.
    const title = firstUserText
      ? firstUserText.slice(0, 80)
      : s.thread_id
        ? `thread ${s.thread_id.slice(-12)}`
        : new Date(s.created_at).toLocaleString();

    out.push({
      id: s.id,
      agent_group_id: s.agent_group_id,
      thread_id: s.thread_id ?? null,
      status: s.status ?? 'active',
      container_status: s.container_status ?? 'stopped',
      last_active: s.last_active ?? null,
      created_at: s.created_at,
      channel_type: mg?.channel_type ?? null,
      title,
      last_preview: lastText.slice(0, 140),
      last_at: lastAt,
      message_count: msgCount,
    });
  }
  // Most recent first — matches Claude.ai's "recent conversations" pattern.
  out.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
  return out;
}

interface HistoryRow {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  kind: string;
  text: string;
  content: unknown;
  session_id: string;
  channel_type: string | null;
  sender: string | null;
}

/** Merge messages_in + messages_out of one or all sessions into a single
 *  chronological transcript. If `sessionIdFilter` is set, only that
 *  session is read; otherwise we aggregate across every session of the
 *  agent_group (the "All conversations" view).
 *
 *  Per-session caps prevent a chatty session from drowning out the rest
 *  when aggregating; single-session reads pull the full limit. */
function readChatHistory(agentGroupId: string, limit: number, sessionIdFilter?: string): HistoryRow[] {
  const all = getSessionsByAgentGroup(agentGroupId);
  const sessions = sessionIdFilter ? all.filter((s) => s.id === sessionIdFilter) : all;
  const perSession = sessionIdFilter ? limit : Math.min(limit, 200);
  const merged: HistoryRow[] = [];

  type Row = { id: string; kind: string; timestamp: string; content: string; channel_type: string | null };
  const tag = (rows: Row[], role: 'user' | 'assistant', sessionId: string): HistoryRow[] =>
    rows.map((r) => {
      let parsed: unknown = r.content;
      let text = '';
      let sender: string | null = null;
      try {
        parsed = JSON.parse(r.content);
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.text === 'string') text = obj.text;
        if (typeof obj.sender === 'string') sender = obj.sender;
        else if (typeof obj.senderName === 'string') sender = obj.senderName;
      } catch {
        text = r.content;
      }
      return {
        id: r.id,
        role,
        timestamp: r.timestamp,
        kind: r.kind,
        text,
        content: parsed,
        session_id: sessionId,
        channel_type: r.channel_type,
        sender,
      };
    });

  for (const session of sessions) {
    let inDb: ReturnType<typeof openInboundDb> | null = null;
    try {
      inDb = openInboundDb(agentGroupId, session.id);
      const userRows = inDb
        .prepare(
          `SELECT id, kind, timestamp, content, channel_type FROM messages_in
           WHERE kind IN ('chat', 'chat-sdk')
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(perSession) as Row[];
      merged.push(...tag(userRows, 'user', session.id));
    } catch (err) {
      log.debug('readChatHistory: inbound open failed', { sessionId: session.id, err });
    } finally {
      inDb?.close();
    }

    let outDb: ReturnType<typeof openOutboundDb> | null = null;
    try {
      outDb = openOutboundDb(agentGroupId, session.id);
      const rows = outDb
        .prepare(
          `SELECT id, kind, timestamp, content, channel_type FROM messages_out
           WHERE kind = 'chat'
           ORDER BY seq DESC LIMIT ?`,
        )
        .all(perSession) as Row[];
      merged.push(...tag(rows, 'assistant', session.id));
    } catch (err) {
      log.debug('readChatHistory: outbound open failed', { sessionId: session.id, err });
    } finally {
      outDb?.close();
    }
  }

  // Sort ascending by timestamp so the UI renders oldest-first; cap to
  // `limit` AFTER merge so genuinely recent rows always win even if a
  // single session was capped earlier.
  merged.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return merged.slice(-limit);
}

function extractText(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
  } catch {
    return raw;
  }
  return '';
}

// ── HTTP routing (static UI + auth) ──────────────────────────────────────

function handleHttp(req: IncomingMessage, res: ServerResponse, adminSecret: string): void {
  if (!req.url) {
    res.writeHead(400).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/auth/issue') {
    void issueToken(req, res, adminSecret);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (req.method === 'GET') {
    serveStatic(url.pathname, res);
    return;
  }

  res.writeHead(405).end();
}

// Resolve to the project root regardless of dev (tsx) vs prod (compiled).
// `import.meta.url` points at .../src/channels/web/index.ts (dev) or
// .../dist/src/channels/web/index.js (build). Either way four parents up
// lands at the repo root, and `web/dist/` sits one level below that.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.resolve(MODULE_DIR, '..', '..', '..', 'web', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname: string, res: ServerResponse): void {
  // SPA fallback: any unknown path serves index.html so client-side routes
  // (e.g. `/agents/ag-1`) work without a real router on the server.
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^[/\\]+/, '');
  let absolute = path.join(STATIC_ROOT, safe);
  // Defense-in-depth — block `..` escape after normalization.
  if (!absolute.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end();
    return;
  }
  let ext = path.extname(absolute).toLowerCase();
  try {
    if (!statSync(absolute).isFile()) throw new Error('not-file');
  } catch {
    absolute = path.join(STATIC_ROOT, 'index.html');
    ext = '.html';
    try {
      statSync(absolute);
    } catch {
      // No build yet — friendly hint instead of a bare 404.
      res
        .writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Web UI not built. Run `cd web && npm run build` and reload.');
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(absolute)
    .on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    })
    .pipe(res);
}

async function issueToken(req: IncomingMessage, res: ServerResponse, adminSecret: string): Promise<void> {
  if (!adminSecret) {
    res.writeHead(503).end('WEB_ADMIN_SECRET not set');
    return;
  }
  if (req.headers['x-admin-secret'] !== adminSecret) {
    res.writeHead(401).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk as string;
  let parsed: { user_id?: unknown; label?: unknown };
  try {
    parsed = body ? (JSON.parse(body) as typeof parsed) : {};
  } catch {
    res.writeHead(400).end('Bad JSON');
    return;
  }
  if (typeof parsed.user_id !== 'string' || parsed.user_id.length === 0) {
    res.writeHead(400).end('user_id required');
    return;
  }
  // Auto-create the user row if missing. Token issuance is owner-gated
  // (header secret), so being able to mint for a not-yet-seen user_id is
  // intentional — the owner is bootstrapping access.
  if (!getUser(parsed.user_id)) {
    createUser({
      id: parsed.user_id,
      kind: 'human',
      display_name: typeof parsed.label === 'string' ? parsed.label : null,
      created_at: new Date().toISOString(),
    });
  }
  const token = `web_${randomBytes(24).toString('hex')}`;
  createWebSession({
    token,
    user_id: parsed.user_id,
    label: typeof parsed.label === 'string' ? parsed.label : null,
    created_at: new Date().toISOString(),
    last_used_at: null,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token, user_id: parsed.user_id }));
}

// ── WebSocket handling ────────────────────────────────────────────────────

function handleSocket(
  ws: WebSocket,
  config: ChannelSetup,
  subscribe: (platformId: string, s: AuthedSocket) => void,
  unsubscribeAll: (s: AuthedSocket) => void,
): void {
  let authed: AuthedSocket | null = null;
  // Auth timeout — a connected socket that doesn't auth within 5s is
  // disconnected. Stops connect-and-hold DoS variants.
  const authTimeout = setTimeout(() => {
    if (!authed) {
      try {
        ws.close(4001, 'auth-timeout');
      } catch {
        // swallow
      }
    }
  }, 5000);

  ws.on('message', (raw) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw.toString()) as ClientFrame;
    } catch {
      sendError(ws, 'parse', 'bad-json', 'Frame is not valid JSON');
      return;
    }

    if (!authed) {
      if (frame.type !== 'auth') {
        sendError(ws, 'parse', 'auth-required', 'First frame must be { type: "auth" }');
        ws.close(4001, 'auth-required');
        return;
      }
      const session = getWebSession(frame.token);
      if (!session) {
        sendError(ws, 'parse', 'auth-failed', 'Unknown token');
        ws.close(4003, 'auth-failed');
        return;
      }
      touchWebSession(session.token, new Date().toISOString());
      authed = { ws, userId: session.user_id };
      clearTimeout(authTimeout);
      const ok: ServerFrame = { type: 'auth-ok', user_id: session.user_id };
      ws.send(JSON.stringify(ok));
      log.info('Web channel: client authed', { userId: session.user_id });
      return;
    }

    if (frame.type === 'req') {
      void handleRpc(authed, frame, config, subscribe);
      return;
    }

    sendError(ws, 'parse', 'unexpected-frame', `Unexpected frame type after auth: ${frame.type}`);
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (authed) unsubscribeAll(authed);
  });

  ws.on('error', (err) => {
    log.warn('Web channel: ws error', { err });
  });
}

function sendError(ws: WebSocket, kind: string, code: string, message: string): void {
  const frame: ServerFrame = {
    type: 'event',
    event: 'error',
    payload: { kind, code, message },
  };
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // socket may already be closing
  }
}

function respond(
  ws: WebSocket,
  id: string,
  ok: boolean,
  payload?: unknown,
  error?: { code: string; message: string },
): void {
  const frame: ResponseFrame = { type: 'res', id, ok, payload, error };
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // swallow
  }
}

// ── RPC handlers ──────────────────────────────────────────────────────────

async function handleRpc(
  socket: AuthedSocket,
  req: RequestFrame,
  config: ChannelSetup,
  subscribe: (platformId: string, s: AuthedSocket) => void,
): Promise<void> {
  const { ws, userId } = socket;
  try {
    switch (req.method) {
      case 'agents.list': {
        const all = getAllAgentGroups();
        const accessible = all.filter((g) => canAccessAgentGroup(userId, g.id).allowed);
        respond(ws, req.id, true, {
          agents: accessible.map((g) => ({
            id: g.id,
            folder: g.folder ?? g.id,
            name: g.name,
            agent_provider: g.agent_provider ?? null,
            sessions: getSessionsByAgentGroup(g.id).length,
          })),
        });
        return;
      }

      case 'sessions.list': {
        const params = req.params as { agent_group_id?: string } | undefined;
        if (!params?.agent_group_id) {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'agent_group_id required' });
          return;
        }
        if (!canAccessAgentGroup(userId, params.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access to this agent group' });
          return;
        }
        const sessions = getSessionsByAgentGroup(params.agent_group_id);
        respond(ws, req.id, true, { sessions: readSessionPreviews(params.agent_group_id, sessions) });
        return;
      }

      case 'chat.history': {
        const params = req.params as { agent_group_id?: string; session_id?: string; limit?: number } | undefined;
        if (!params?.agent_group_id) {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'agent_group_id required' });
          return;
        }
        if (!canAccessAgentGroup(userId, params.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access' });
          return;
        }
        const limit = Math.min(typeof params.limit === 'number' ? params.limit : 200, 500);
        // Two modes: session_id given → single thread; omitted → aggregated.
        // This is the difference between "show me THIS conversation" and
        // "show me everything I've ever said to this agent."
        const messages = readChatHistory(params.agent_group_id, limit, params.session_id);
        respond(ws, req.id, true, { messages });
        return;
      }

      case 'chat.send': {
        const params = req.params as { agent_group_id?: string; text?: string } | undefined;
        if (!params?.agent_group_id || typeof params.text !== 'string') {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'agent_group_id and text required' });
          return;
        }
        if (!canAccessAgentGroup(userId, params.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access to this agent group' });
          return;
        }
        const agent = getAgentGroup(params.agent_group_id);
        if (!agent) {
          respond(ws, req.id, false, undefined, { code: 'not-found', message: 'Agent group not found' });
          return;
        }

        const platformId = platformIdFor(userId, params.agent_group_id);

        // Lazy-create the messaging_group + wiring on first message —
        // saves a round-trip at auth time and keeps the central DB clean
        // for users who only ever read history without sending.
        let mg = getMessagingGroupByPlatform(CHANNEL_TYPE, platformId);
        if (!mg) {
          mg = {
            id: `mg-web-${randomBytes(6).toString('hex')}`,
            channel_type: CHANNEL_TYPE,
            platform_id: platformId,
            name: agent.name,
            is_group: 0,
            // Web sockets are bearer-token authed — the holder's user_id is
            // trusted, so no `request_approval` gate needed for strangers.
            unknown_sender_policy: 'public',
            denied_at: null,
            created_at: new Date().toISOString(),
          };
          createMessagingGroup(mg);
          log.info('Web channel: created messaging group', {
            mgId: mg.id,
            userId,
            agentGroupId: params.agent_group_id,
          });
        }
        if (!getMessagingGroupAgentByPair(mg.id, params.agent_group_id)) {
          createMessagingGroupAgent({
            id: `mga-web-${randomBytes(6).toString('hex')}`,
            messaging_group_id: mg.id,
            agent_group_id: params.agent_group_id,
            // Web is a 1:1 DM — the user is always addressing this agent.
            // `pattern` + `.` matches every message.
            engage_mode: 'pattern',
            engage_pattern: '.',
            sender_scope: 'all',
            ignored_message_policy: 'drop',
            session_mode: 'shared',
            priority: 0,
            created_at: new Date().toISOString(),
          });
        }

        // Auto-subscribe — sending a message means the user is interested
        // in the reply. The UI can ALSO call chat.subscribe explicitly to
        // re-attach to a session it's just opened from history.
        subscribe(platformId, socket);

        const messageId = `web-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const inbound: InboundMessage = {
          id: messageId,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          isMention: true,
          isGroup: false,
          content: {
            text: params.text,
            sender: userId,
            senderId: userId,
          },
        };
        await config.onInbound(platformId, null, inbound);
        respond(ws, req.id, true, { message_id: messageId });
        return;
      }

      case 'chat.subscribe': {
        // Idempotent — join this socket to an agent's outbound stream
        // without sending. The UI calls this on thread-open so subsequent
        // assistant replies arrive over `event:chat.final`.
        const params = req.params as { agent_group_id?: string } | undefined;
        if (!params?.agent_group_id) {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'agent_group_id required' });
          return;
        }
        if (!canAccessAgentGroup(userId, params.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access' });
          return;
        }
        subscribe(platformIdFor(userId, params.agent_group_id), socket);
        respond(ws, req.id, true, { subscribed: true });
        return;
      }

      case 'apps.list': {
        const params = req.params as { agent_group_id?: string } | undefined;
        if (!params?.agent_group_id) {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'agent_group_id required' });
          return;
        }
        if (!canAccessAgentGroup(userId, params.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access' });
          return;
        }
        respond(ws, req.id, true, {
          apps: listWebAppsByAgentGroup(params.agent_group_id).map((a) => ({
            id: a.id,
            agent_group_id: a.agent_group_id,
            name: a.name,
            updated_at: a.updated_at,
          })),
        });
        return;
      }

      case 'apps.get': {
        const params = req.params as { id?: string } | undefined;
        if (!params?.id) {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'id required' });
          return;
        }
        const app = getWebApp(params.id);
        if (!app) {
          respond(ws, req.id, false, undefined, { code: 'not-found', message: 'App not found' });
          return;
        }
        if (!canAccessAgentGroup(userId, app.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access' });
          return;
        }
        respond(ws, req.id, true, app);
        return;
      }

      case 'db.query': {
        const params = req.params as {
          agent_group_id?: string;
          q?: string;
          params?: unknown[] | Record<string, unknown>;
        } | undefined;
        if (!params?.agent_group_id || typeof params.q !== 'string') {
          respond(ws, req.id, false, undefined, { code: 'bad-params', message: 'agent_group_id and q required' });
          return;
        }
        if (!canAccessAgentGroup(userId, params.agent_group_id).allowed) {
          respond(ws, req.id, false, undefined, { code: 'forbidden', message: 'No access' });
          return;
        }
        if (!isReadOnlySql(params.q)) {
          respond(ws, req.id, false, undefined, {
            code: 'write-blocked',
            message:
              'Only SELECT / WITH / PRAGMA / EXPLAIN are allowed over db.query. Use db_execute on the agent side for writes.',
          });
          return;
        }
        try {
          const db = getSandboxDb(params.agent_group_id);
          const stmt = db.prepare(params.q);
          let rows: unknown[];
          if (Array.isArray(params.params)) {
            rows = stmt.all(...params.params);
          } else if (params.params && typeof params.params === 'object') {
            rows = stmt.all(params.params as Record<string, unknown>);
          } else {
            rows = stmt.all();
          }
          respond(ws, req.id, true, { rows });
        } catch (err) {
          respond(ws, req.id, false, undefined, {
            code: 'sql-error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      // Subsequent phases add artifacts.*, notifications.*, crons.list,
      // and agent.* as more `case` branches here.

      default:
        respond(ws, req.id, false, undefined, { code: 'unknown-method', message: `Unknown method: ${req.method}` });
    }
  } catch (err) {
    log.error('Web RPC handler threw', { method: req.method, err });
    respond(ws, req.id, false, undefined, {
      code: 'internal',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

registerChannelAdapter('web', { factory: createAdapter });

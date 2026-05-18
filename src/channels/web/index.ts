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
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { canAccessAgentGroup } from '../../modules/permissions/access.js';
import { createUser, getUser } from '../../modules/permissions/db/users.js';
import { createWebSession, getWebSession, touchWebSession } from '../../db/web.js';
import type {
  ChannelAdapter,
  ChannelSetup,
  OutboundMessage,
} from '../adapter.js';
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
  _config: ChannelSetup,
  _subscribe: (platformId: string, s: AuthedSocket) => void,
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

      // More methods (sessions.list, chat.history, chat.send, apps.list, …)
      // get added in subsequent phases. Each lives as a `case` here and
      // delegates to a small reader function below.

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

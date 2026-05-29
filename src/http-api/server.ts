/**
 * HTTP API for agency-os dashboard.
 *
 * Spec: docs/integrations/nanoclaw-http-api.md in the agency-os repo.
 *
 * 7 endpoints behind a single Bearer token (NANOCLAW_API_TOKEN), served
 * on 127.0.0.1 only. Read-mostly: lists groups/runs, exposes run events
 * (polling SSE), and the one write path (POST /api/groups/:id/trigger)
 * is idempotent via dedup_key.
 *
 * Port: defaults to 3003 because NanoClaw's gbrain proxy already owns
 * 3002. Override with NANOCLAW_HTTP_PORT.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';

import { getDb } from '../db/connection.js';
import { getDispatcherStatus } from '../dispatcher/api-trigger-dispatcher.js';
import { log } from '../log.js';
import { triggerAgentGroup } from './trigger.js';

type Handler = (url: URL, req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: getHealth },
  { method: 'GET', pattern: /^\/api\/groups$/, handler: listGroups },
  { method: 'GET', pattern: /^\/api\/groups\/([^/]+)$/, handler: getGroup },
  { method: 'POST', pattern: /^\/api\/groups\/([^/]+)\/trigger$/, handler: triggerGroup },
  { method: 'GET', pattern: /^\/api\/runs$/, handler: listRuns },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)$/, handler: getRun },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)\/events$/, handler: streamRunEvents },
  { method: 'POST', pattern: /^\/api\/skills\/([^/]+)\/reload$/, handler: reloadSkill },
  { method: 'GET', pattern: /^\/api\/dispatcher\/status$/, handler: getDispatcherStatusHandler },
];

const HEALTH_PATH = '/api/health';

export interface StartHttpApiOptions {
  port: number;
  token: string | undefined;
  /**
   * Address to bind on. Defaults to 127.0.0.1 (Mac install, cloudflared on
   * host network). On the VPS docker install, set this to 0.0.0.0 so the
   * sidecar cloudflared container can reach us via the internal bridge.
   */
  bind?: string;
}

export function startHttpApi(opts: StartHttpApiOptions): Server {
  if (!opts.token) {
    log.warn('NANOCLAW_API_TOKEN not set — HTTP API will reject all non-health requests');
  }
  // Pre-hash the token bytes once so each request only allocates the
  // incoming header buffer.
  const tokenBuf = opts.token ? Buffer.from(opts.token, 'utf-8') : null;

  const server = createServer((req, res) => {
    handleRequest(req, res, tokenBuf).catch((err) => {
      log.error('http-api handler threw', { err, url: req.url });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      }
    });
  });

  const bind = opts.bind ?? '127.0.0.1';
  server.listen(opts.port, bind, () => {
    log.info('HTTP API listening', { url: `http://${bind}:${opts.port}` });
  });

  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, tokenBuf: Buffer | null): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Health probe is unauthenticated so external watchdogs can ping without
  // needing the token. It leaks only liveness + version, which is fine.
  if (url.pathname !== HEALTH_PATH) {
    if (!tokenBuf || !validBearer(req.headers.authorization, tokenBuf)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  await route.handler(url, req, res);
}

function validBearer(header: string | undefined, tokenBuf: Buffer): boolean {
  if (!header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  const candidate = Buffer.from(m[1], 'utf-8');
  if (candidate.length !== tokenBuf.length) return false;
  return timingSafeEqual(candidate, tokenBuf);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > 1_000_000) throw new Error('payload_too_large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new Error('invalid_json');
  }
}

function parseJsonField<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ── Handlers ──────────────────────────────────────────────────────────

const STARTED_AT = Date.now();

function getHealth(_url: URL, _req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    version: process.env.npm_package_version ?? 'unknown',
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
  });
}

function listGroups(_url: URL, _req: IncomingMessage, res: ServerResponse): void {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT ag.id, ag.folder, ag.name, ag.agent_provider, ag.created_at,
              (SELECT json_object('id', r.id, 'status', r.status, 'started_at', r.started_at, 'created_at', r.created_at)
                 FROM runs r WHERE r.agent_group_id = ag.id
                 ORDER BY COALESCE(r.started_at, r.created_at) DESC LIMIT 1) AS last_run_json
         FROM agent_groups ag
         ORDER BY ag.created_at DESC`,
    )
    .all() as Array<{
    id: string;
    folder: string;
    name: string;
    agent_provider: string | null;
    created_at: string;
    last_run_json: string | null;
  }>;

  const out = rows.map((r) => ({
    id: r.id,
    folder: r.folder,
    name: r.name,
    agent_provider: r.agent_provider,
    created_at: r.created_at,
    last_run: r.last_run_json ? JSON.parse(r.last_run_json) : null,
  }));
  sendJson(res, 200, out);
}

function getGroup(url: URL, _req: IncomingMessage, res: ServerResponse): void {
  const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  const db = getDb();
  const row = db.prepare(`SELECT * FROM agent_groups WHERE id = ?`).get(id);
  if (!row) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const recentRuns = db
    .prepare(
      `SELECT id, status, priority, dedup_key, created_at, started_at, ended_at
         FROM runs WHERE agent_group_id = ?
         ORDER BY COALESCE(started_at, created_at) DESC LIMIT 10`,
    )
    .all(id);
  sendJson(res, 200, { ...row, recent_runs: recentRuns });
}

async function triggerGroup(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return;
  }

  if (!isRecord(body)) {
    sendJson(res, 400, { error: 'invalid_body' });
    return;
  }
  const dedupKey = body.dedup_key;
  const input = body.input;
  const priorityRaw = body.priority;

  if (typeof dedupKey !== 'string' || dedupKey.length === 0) {
    sendJson(res, 400, { error: 'invalid_body', details: 'dedup_key required (non-empty string)' });
    return;
  }
  if (!isRecord(input)) {
    sendJson(res, 400, { error: 'invalid_body', details: 'input must be an object' });
    return;
  }
  const priority: 'low' | 'normal' | 'high' = priorityRaw === 'low' || priorityRaw === 'high' ? priorityRaw : 'normal';

  // LANE H V1.5 optional fields. Type-validated here, then trusted by the
  // handler. `skill_content` has a soft 256KB cap so a runaway markdown
  // can't blow past the 1MB body limit on its own and starve other fields
  // — the spec assumes skill markdown ~5-50KB.
  const SKILL_CONTENT_MAX = 256 * 1024;
  const runIdRaw = body.run_id;
  const skillSlugRaw = body.skill_slug;
  const skillVersionRaw = body.skill_version;
  const skillContentRaw = body.skill_content;

  if (runIdRaw !== undefined && (typeof runIdRaw !== 'string' || runIdRaw.length === 0 || runIdRaw.length > 128)) {
    sendJson(res, 400, { error: 'invalid_body', details: 'run_id must be a non-empty string ≤128 chars' });
    return;
  }
  if (
    skillSlugRaw !== undefined &&
    (typeof skillSlugRaw !== 'string' || skillSlugRaw.length === 0 || skillSlugRaw.length > 128)
  ) {
    sendJson(res, 400, { error: 'invalid_body', details: 'skill_slug must be a non-empty string ≤128 chars' });
    return;
  }
  if (
    skillVersionRaw !== undefined &&
    (typeof skillVersionRaw !== 'number' || !Number.isInteger(skillVersionRaw) || skillVersionRaw < 1)
  ) {
    sendJson(res, 400, { error: 'invalid_body', details: 'skill_version must be a positive integer' });
    return;
  }
  if (
    skillContentRaw !== undefined &&
    (typeof skillContentRaw !== 'string' || skillContentRaw.length > SKILL_CONTENT_MAX)
  ) {
    sendJson(res, 400, {
      error: 'invalid_body',
      details: `skill_content must be a string ≤${SKILL_CONTENT_MAX} bytes`,
    });
    return;
  }

  // LANE #61 — Skill triggers must carry the markdown body. Without it the
  // agent-runner's formatter falls back to the legacy V1 shape ([API TRIGGER]
  // + raw input blob) and the agent receives no procedure to execute. The
  // model then ends the turn with no text (`Result: (empty)`) and outcome is
  // null — looks like an intermittent model bug but is actually a malformed
  // trigger. Reject loud at the boundary so callers know to send skill_content
  // (or drop the skill metadata entirely if they meant a legacy queue trigger).
  const hasSkillSlug = typeof skillSlugRaw === 'string' && skillSlugRaw.length > 0;
  const hasSkillContent = typeof skillContentRaw === 'string' && skillContentRaw.length > 0;
  if (hasSkillSlug && !hasSkillContent) {
    sendJson(res, 400, {
      error: 'invalid_body',
      details:
        'skill_content is required when skill_slug is set (the agent-runner has no other source for the procedure body)',
    });
    return;
  }

  const result = triggerAgentGroup({
    agent_group_id: id,
    dedup_key: dedupKey,
    input,
    priority,
    run_id: typeof runIdRaw === 'string' ? runIdRaw : undefined,
    skill_slug: typeof skillSlugRaw === 'string' ? skillSlugRaw : undefined,
    skill_version: typeof skillVersionRaw === 'number' ? skillVersionRaw : undefined,
    skill_content: typeof skillContentRaw === 'string' ? skillContentRaw : undefined,
  });

  if ('error' in result) {
    const status = result.error === 'not_found' ? 404 : result.error === 'invalid_run_id' ? 409 : 500;
    sendJson(res, status, { error: result.error });
    return;
  }
  if ('duplicate' in result) {
    sendJson(res, 409, { run_id: result.run_id, duplicate_of: result.dedup_key });
    return;
  }
  sendJson(res, 202, result);
}

function listRuns(url: URL, _req: IncomingMessage, res: ServerResponse): void {
  const db = getDb();
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 500));
  const status = url.searchParams.get('status');
  const groupId = url.searchParams.get('group_id');

  let sql = `SELECT id, agent_group_id, session_id, status, priority, dedup_key,
            created_at, started_at, ended_at, metrics, error_message
       FROM runs WHERE 1 = 1`;
  const params: unknown[] = [];
  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  if (groupId) {
    sql += ` AND agent_group_id = ?`;
    params.push(groupId);
  }
  sql += ` ORDER BY COALESCE(started_at, created_at) DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{ metrics: string | null }>;
  const out = rows.map((r) => ({
    ...r,
    metrics: parseJsonField<Record<string, unknown> | null>(r.metrics, null),
  }));
  sendJson(res, 200, out);
}

function getRun(url: URL, _req: IncomingMessage, res: ServerResponse): void {
  const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  const db = getDb();
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
    | (Record<string, unknown> & { metrics: string | null; input: string | null })
    | undefined;
  if (!run) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const events = db
    .prepare(
      `SELECT timestamp, level, message, data FROM run_events WHERE run_id = ?
         ORDER BY timestamp ASC, id ASC LIMIT 500`,
    )
    .all(id) as Array<{ data: string | null }>;
  sendJson(res, 200, {
    ...run,
    metrics: parseJsonField<Record<string, unknown> | null>(run.metrics, null),
    input: parseJsonField<Record<string, unknown> | null>(run.input, null),
    events: events.map((e) => ({
      ...e,
      data: parseJsonField<Record<string, unknown> | null>(e.data, null),
    })),
  });
}

function streamRunEvents(url: URL, req: IncomingMessage, res: ServerResponse): void {
  const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  const db = getDb();
  const exists = db.prepare(`SELECT 1 FROM runs WHERE id = ?`).get(id);
  if (!exists) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  let lastSeen = url.searchParams.get('since') ?? '1970-01-01T00:00:00Z';
  let closed = false;

  const interval = setInterval(() => {
    if (closed) return;
    let events: Array<{ timestamp: string; level: string; message: string; data: string | null }>;
    try {
      events = db
        .prepare(
          `SELECT timestamp, level, message, data FROM run_events
             WHERE run_id = ? AND timestamp > ?
             ORDER BY timestamp ASC, id ASC`,
        )
        .all(id, lastSeen) as typeof events;
    } catch (err) {
      log.error('SSE event poll failed', { err, runId: id });
      cleanup();
      return;
    }
    for (const ev of events) {
      res.write(
        `event: log\ndata: ${JSON.stringify({
          ...ev,
          data: parseJsonField<Record<string, unknown> | null>(ev.data, null),
        })}\n\n`,
      );
      lastSeen = ev.timestamp;
    }

    const run = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(id) as { status: string } | undefined;
    if (run && (run.status === 'success' || run.status === 'error' || run.status === 'cancelled')) {
      res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
      cleanup();
    }
  }, 1000);

  // Heartbeat every 15s to keep proxies from idling out.
  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(`: heartbeat\n\n`);
  }, 15_000);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    clearInterval(heartbeat);
    res.end();
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
}

function reloadSkill(url: URL, _req: IncomingMessage, res: ServerResponse): void {
  const id = decodeURIComponent(url.pathname.split('/')[3] ?? '');
  // V1 no-op: NanoClaw re-reads CLAUDE.local.md from disk on every container
  // wake, so there is no in-process cache to invalidate. Logged for audit.
  log.info('Skill reload requested via HTTP API', { skillId: id });
  sendJson(res, 200, { id, reloaded_at: new Date().toISOString(), no_op: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getDispatcherStatusHandler(_url: URL, _req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, getDispatcherStatus());
}

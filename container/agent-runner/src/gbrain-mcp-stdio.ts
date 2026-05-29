/**
 * GBrain MCP server (stdio transport).
 *
 * Spawned as a child process by the Claude Agent SDK. Bridges the host's
 * gbrain HTTP proxy (`POST $GBRAIN_PROXY_URL` with `{tool, args}`) into
 * MCP tool calls so the in-container agent sees the brain via
 * `mcp__gbrain__*` tools.
 *
 * Wiring: `agent-runner/src/index.ts` registers this file under the
 * `gbrain` MCP server name iff `GBRAIN_PROXY_URL` is set in the container
 * env (set by the host in `src/container-runner.ts` →
 * `http://${CONTAINER_HOST_GATEWAY}:3002/tool`). The host proxy
 * (`src/gbrain-proxy.ts`) shells out to `gbrain call <tool> '<json>'` and
 * returns `{result}` or `{error}`.
 *
 * Tool catalog mirrors the proxy's ALLOWED_TOOLS set — keep in sync.
 *
 * --- Why raw JSON-RPC instead of @modelcontextprotocol/sdk ---
 *
 * The SDK's `Server` class validates incoming `initialize` requests with
 * a Zod schema that requires `params.clientInfo` to be an object. Claude
 * Agent SDK (as of @anthropic-ai/claude-agent-sdk@0.2.x) sends an
 * `initialize` without `clientInfo`, which the server SDK rejects with
 * JSON-RPC error -32603 "expected object, received undefined at
 * params.clientInfo". The initialize handshake never completes →
 * Claude SDK doesn't register `mcp__gbrain__*` in its tool catalog →
 * the agent has no brain access (LANE #53 outcome was empty for this
 * exact reason).
 *
 * Fix: implement the stdio transport + JSON-RPC dispatch ourselves with
 * a permissive `initialize` handler. No version coupling to the SDK, no
 * Zod schemas in the hot path. Logs go to stderr only — stdout is
 * reserved for protocol frames.
 */
import { Buffer } from 'node:buffer';

function log(msg: string): void {
  console.error(`[gbrain-mcp] ${msg}`);
}

const PROXY_URL = process.env.GBRAIN_PROXY_URL;
if (!PROXY_URL) {
  log('GBRAIN_PROXY_URL not set — refusing to start');
  process.exit(1);
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonValue;
}

const TOOLS: ToolDef[] = [
  {
    name: 'search',
    description: 'Keyword search over brain pages (Postgres full-text). Returns ranked matches with slug + snippet. Use for fast exact-term lookup; for semantic queries, prefer `query`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (tsvector tokenisation).' },
        limit: { type: 'number', description: 'Max results (default 10).' },
        offset: { type: 'number', description: 'Pagination offset.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'query',
    description: 'Hybrid semantic + keyword search with optional multi-query expansion. Best for natural-language questions where exact keyword match is not enough.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
        offset: { type: 'number', description: 'Pagination offset.' },
        expand: { type: 'boolean', description: 'Enable LLM query expansion (default false in this proxy).' },
        detail: { type: 'string', description: 'Optional detail mode ("chunks" | "pages"). Defaults to pages.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_page',
    description: 'Read a single brain page by slug. Returns markdown body + frontmatter.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug.' },
        fuzzy: { type: 'boolean', description: 'If true, fuzzy-match the slug.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'put_page',
    description: 'Create or update a brain page. Markdown body with frontmatter. Chunks, embeds, and reconciles tags atomically.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug.' },
        content: { type: 'string', description: 'Full markdown body (frontmatter optional).' },
      },
      required: ['slug', 'content'],
    },
  },
  {
    name: 'list_pages',
    description: 'List brain pages with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by frontmatter type.' },
        tag: { type: 'string', description: 'Filter by tag.' },
        limit: { type: 'number', description: 'Max results.' },
      },
    },
  },
  {
    name: 'add_timeline_entry',
    description: 'Append a timestamped entry to a page timeline (frontmatter `timeline:` array).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Target page slug.' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        summary: { type: 'string', description: 'Short one-line summary.' },
        detail: { type: 'string', description: 'Optional longer detail.' },
        source: { type: 'string', description: 'Optional source attribution.' },
      },
      required: ['slug', 'date', 'summary'],
    },
  },
  {
    name: 'get_timeline',
    description: 'Read the timeline entries for a page.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'add_link',
    description: 'Create a typed link between two pages (graph edge).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source page slug.' },
        to: { type: 'string', description: 'Target page slug.' },
        link_type: { type: 'string', description: 'Optional type label.' },
        context: { type: 'string', description: 'Optional context snippet.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_backlinks',
    description: 'List incoming links to a page.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Page slug.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'traverse_graph',
    description: 'BFS-traverse the link graph from a page up to N hops.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Seed page slug.' },
        depth: { type: 'number', description: 'Max hops (default 2).' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_stats',
    description: 'Brain-wide statistics: page count, chunk count, embed coverage, etc.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

async function callProxy(tool: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(PROXY_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return { ok: false, error: `proxy fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, error: `proxy returned non-JSON (HTTP ${response.status}): ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!response.ok) {
    const errMsg = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${response.status}`;
    return { ok: false, error: errMsg };
  }

  if (body && typeof body === 'object' && 'error' in body) {
    return { ok: false, error: String((body as { error: unknown }).error) };
  }

  const result = body && typeof body === 'object' && 'result' in body ? (body as { result: unknown }).result : body;
  return { ok: true, data: result };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

function writeMessage(msg: JsonRpcSuccess | JsonRpcError): void {
  // MCP stdio: newline-delimited JSON. Must hit stdout directly (not
  // console.log — Bun's console.log can buffer / decorate).
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id: string | number | null, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function err(id: string | number | null, code: number, message: string, data?: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

async function handleMessage(raw: string): Promise<void> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(raw) as JsonRpcRequest;
  } catch (parseErr) {
    err(null, -32700, `Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
    return;
  }

  // JSON-RPC notifications have no `id`. They never get a response.
  const isNotification = !('id' in msg) || msg.id === undefined;
  const id = (msg.id ?? null) as string | number | null;
  const method = msg.method;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  // --- Lifecycle -----------------------------------------------------
  if (method === 'initialize') {
    const clientProtocol = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const protocolVersion = clientProtocol && SUPPORTED_PROTOCOL_VERSIONS.has(clientProtocol)
      ? clientProtocol
      : DEFAULT_PROTOCOL_VERSION;
    if (!isNotification) {
      ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'gbrain', version: '1.0.0' },
      });
    }
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') {
    // Notification — silent ack.
    return;
  }

  if (method === 'ping') {
    if (!isNotification) ok(id, {});
    return;
  }

  // --- Tools ---------------------------------------------------------
  if (method === 'tools/list') {
    if (!isNotification) ok(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;

    if (!TOOL_NAMES.has(toolName)) {
      if (!isNotification) {
        ok(id, {
          content: [{ type: 'text', text: `Unknown gbrain tool: ${toolName}. Known: ${[...TOOL_NAMES].join(', ')}` }],
          isError: true,
        });
      }
      return;
    }

    const proxyResult = await callProxy(toolName, toolArgs);
    if (!proxyResult.ok) {
      log(`tool=${toolName} error=${proxyResult.error}`);
      if (!isNotification) {
        ok(id, {
          content: [{ type: 'text', text: `gbrain ${toolName} failed: ${proxyResult.error}` }],
          isError: true,
        });
      }
      return;
    }

    const text = typeof proxyResult.data === 'string' ? proxyResult.data : JSON.stringify(proxyResult.data, null, 2);
    if (!isNotification) {
      ok(id, { content: [{ type: 'text', text }] });
    }
    return;
  }

  // --- Unknown method ------------------------------------------------
  if (!isNotification) {
    err(id, -32601, `Method not found: ${method}`);
  }
}

async function main(): Promise<void> {
  // Newline-delimited JSON-RPC framing. Buffer partial lines across chunks.
  let buffer = '';
  // Track in-flight handlers so we don't exit on stdin close while a
  // proxy fetch is still pending (caught by smoke test: tools/call was
  // dropped when stdin closed before the 60s-timeout fetch resolved).
  let pending = 0;
  let stdinClosed = false;

  const maybeExit = () => {
    if (stdinClosed && pending === 0) {
      log('stdin closed and no pending work — exiting');
      process.exit(0);
    }
  };

  process.stdin.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        pending += 1;
        handleMessage(line)
          .catch((handleErr) => {
            log(`handler crashed: ${handleErr instanceof Error ? handleErr.message : String(handleErr)}`);
          })
          .finally(() => {
            pending -= 1;
            maybeExit();
          });
      }
      nl = buffer.indexOf('\n');
    }
  });

  process.stdin.on('end', () => {
    stdinClosed = true;
    maybeExit();
  });

  process.stdin.on('error', (e: Error) => {
    log(`stdin error: ${e.message}`);
    process.exit(1);
  });

  log(`server started (${TOOLS.length} tools, proxy=${PROXY_URL})`);
}

main().catch((mainErr) => {
  log(`fatal: ${mainErr instanceof Error ? mainErr.message : String(mainErr)}`);
  process.exit(1);
});

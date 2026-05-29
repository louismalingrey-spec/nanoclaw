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
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

function log(msg: string): void {
  console.error(`[gbrain-mcp] ${msg}`);
}

const PROXY_URL = process.env.GBRAIN_PROXY_URL;
if (!PROXY_URL) {
  log('GBRAIN_PROXY_URL not set — refusing to start');
  process.exit(1);
}

const TOOLS: Tool[] = [
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

async function main(): Promise<void> {
  const server = new Server({ name: 'gbrain', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!TOOL_NAMES.has(name)) {
      return {
        content: [{ type: 'text' as const, text: `Unknown gbrain tool: ${name}. Known: ${[...TOOL_NAMES].join(', ')}` }],
        isError: true,
      };
    }

    const result = await callProxy(name, (args as Record<string, unknown>) ?? {});
    if (!result.ok) {
      log(`tool=${name} error=${result.error}`);
      return {
        content: [{ type: 'text' as const, text: `gbrain ${name} failed: ${result.error}` }],
        isError: true,
      };
    }

    const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
    return { content: [{ type: 'text' as const, text }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`server started (${TOOLS.length} tools, proxy=${PROXY_URL})`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

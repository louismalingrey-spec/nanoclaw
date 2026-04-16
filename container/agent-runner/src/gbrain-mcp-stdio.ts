/**
 * GBrain MCP stdio server — container side.
 *
 * Exposes gbrain brain operations as MCP tools by proxying requests to the
 * host-side gbrain HTTP proxy (reachable via GBRAIN_PROXY_URL).
 *
 * The agent uses these tools like:
 *   mcp__gbrain__search({ query: "Louis" })
 *   mcp__gbrain__query({ query: "what formats work for SaaS companies" })
 *   mcp__gbrain__get_page({ slug: "people/clients/louis" })
 *   mcp__gbrain__put_page({ slug: "people/...", content: "# ...\n..." })
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PROXY_URL = process.env.GBRAIN_PROXY_URL!;

async function callProxy(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });

  if (!resp.ok) {
    throw new Error(`GBrain proxy error ${resp.status}: ${await resp.text()}`);
  }

  const body = (await resp.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result;
}

function resultText(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data, null, 2);
}

const server = new McpServer({ name: 'gbrain', version: '1.0.0' });

server.tool(
  'search',
  'Keyword (full-text) search across all brain pages. Returns ranked chunks with context. Use for specific names, dates, or exact terms.',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results (default 20)'),
  },
  async ({ query, limit }) => {
    const result = await callProxy('search', { query, ...(limit ? { limit } : {}) });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'query',
  'Hybrid semantic + keyword search. Use for conceptual questions, topic exploration, or when you need context rather than exact matches.',
  {
    query: z.string().describe('Natural-language question or topic'),
    limit: z.number().optional().describe('Max results (default 20)'),
    expand: z.boolean().optional().describe('Enable multi-query expansion (default true)'),
  },
  async ({ query, limit, expand }) => {
    const result = await callProxy('query', {
      query,
      ...(limit !== undefined ? { limit } : {}),
      ...(expand !== undefined ? { expand } : {}),
    });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'get_page',
  'Read a brain page by slug (e.g. "people/clients/acme", "concepts/formats/listicle"). Use after search/query to get the full page content.',
  {
    slug: z.string().describe('Page slug'),
    fuzzy: z.boolean().optional().describe('Enable fuzzy slug resolution'),
  },
  async ({ slug, fuzzy }) => {
    const result = await callProxy('get_page', { slug, ...(fuzzy ? { fuzzy } : {}) });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'put_page',
  'Write or update a brain page. Content must be markdown with YAML frontmatter (type, title fields). Creates the page if it does not exist.',
  {
    slug: z
      .string()
      .describe(
        'Page slug matching the brain folder structure (e.g. "people/clients/acme", "concepts/formats/listicle")',
      ),
    content: z
      .string()
      .describe(
        'Full markdown content with YAML frontmatter. Minimum: ---\\ntype: person\\ntitle: Name\\n---\\n\\n## Compiled Truth\\n',
      ),
  },
  async ({ slug, content }) => {
    const result = await callProxy('put_page', { slug, content });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'list_pages',
  'List brain pages with optional type filter. Returns slug, type, title, updated_at.',
  {
    type: z
      .string()
      .optional()
      .describe(
        'Filter by type: person, company, concept, deal, meeting, original, idea, or any custom type',
      ),
    limit: z.number().optional().describe('Max results (default 50)'),
  },
  async ({ type, limit }) => {
    const result = await callProxy('list_pages', {
      ...(type ? { type } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'add_timeline_entry',
  'Append a timestamped event to a brain page timeline. Use to record facts, observations, and interactions.',
  {
    slug: z.string().describe('Page slug to add the entry to'),
    text: z.string().describe('Event text (plain markdown)'),
    date: z
      .string()
      .optional()
      .describe('ISO date string (defaults to today)'),
    source: z
      .string()
      .optional()
      .describe('Source label, e.g. "User, 2026-04-15" or "Conversation"'),
  },
  async ({ slug, text, date, source }) => {
    const result = await callProxy('add_timeline_entry', {
      slug,
      text,
      ...(date ? { date } : {}),
      ...(source ? { source } : {}),
    });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'get_backlinks',
  'Get all pages that link to a given slug. Use to find related context and cross-references.',
  {
    slug: z.string().describe('Page slug to look up backlinks for'),
  },
  async ({ slug }) => {
    const result = await callProxy('get_backlinks', { slug });
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

server.tool(
  'get_stats',
  'Show brain statistics (page count, last sync, etc).',
  {},
  async () => {
    const result = await callProxy('get_stats', {});
    return { content: [{ type: 'text' as const, text: resultText(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

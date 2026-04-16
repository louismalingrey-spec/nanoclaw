/**
 * GBrain HTTP Proxy
 *
 * Runs on the host and exposes gbrain operations over a simple HTTP API
 * so container agents can call brain tools via the host gateway.
 *
 * Endpoint: POST /tool
 * Body:     { "tool": "<operation>", "args": { ... } }
 * Response: { "result": <json> } | { "error": "<message>" }
 *
 * Uses `gbrain call <tool> '<json>'` under the hood.
 * Returns HTTP 200 for both success and operation errors (check response.error).
 * Returns HTTP 500 only for infrastructure failures.
 */
import { createServer, Server } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Supported gbrain operations (from `gbrain tools-json`)
const ALLOWED_TOOLS = new Set([
  'search',
  'query',
  'get_page',
  'put_page',
  'list_pages',
  'add_timeline_entry',
  'get_timeline',
  'add_link',
  'get_backlinks',
  'traverse_graph',
  'get_stats',
]);

async function callGbrain(
  gbrainBin: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // gbrain's shebang is `#!/usr/bin/env bun` — ensure bun's directory is on PATH.
  const path = await import('path');
  const binDir = path.dirname(gbrainBin);
  const existingPath = process.env.PATH || '';
  const pathWithBun = existingPath.includes(binDir)
    ? existingPath
    : `${binDir}:${existingPath}`;

  const { stdout, stderr } = await execFileAsync(
    gbrainBin,
    ['call', tool, JSON.stringify(args)],
    {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024, // 4MB
      env: { ...process.env, PATH: pathWithBun },
    },
  );

  if (stderr) {
    logger.debug({ tool, stderr: stderr.slice(0, 200) }, 'gbrain call stderr');
  }

  return JSON.parse(stdout.trim());
}

export async function startGbrainProxy(
  port: number,
  gbrainBin: string,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/tool') {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body: { tool?: string; args?: Record<string, unknown> };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        const { tool, args = {} } = body;

        if (!tool || typeof tool !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing "tool" field' }));
          return;
        }

        if (!ALLOWED_TOOLS.has(tool)) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: `Unknown tool: ${tool}. Allowed: ${[...ALLOWED_TOOLS].join(', ')}`,
            }),
          );
          return;
        }

        try {
          const result = await callGbrain(gbrainBin, tool, args);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
          logger.debug(
            { tool, argsKeys: Object.keys(args) },
            'gbrain tool call',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // JSON parse errors mean gbrain returned an error — surface it
          if (msg.includes('JSON')) {
            logger.warn({ tool, err: msg }, 'gbrain call returned non-JSON');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          } else {
            logger.error({ tool, err: msg }, 'gbrain call failed');
            res.writeHead(500);
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, gbrainBin }, 'GBrain proxy started');
      resolve(server);
    });
  });
}

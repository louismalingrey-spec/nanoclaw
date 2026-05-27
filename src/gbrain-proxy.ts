/**
 * GBrain HTTP Proxy
 *
 * Runs on the host and exposes gbrain operations over HTTP so container
 * agents can call brain tools via the host gateway.
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
import path from 'path';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

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

async function callGbrain(gbrainBin: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  // gbrain's shebang is `#!/usr/bin/env bun` — ensure bun's directory is on PATH.
  const binDir = path.dirname(gbrainBin);
  const existingPath = process.env.PATH || '';
  const pathWithBun = existingPath.includes(binDir) ? existingPath : `${binDir}:${existingPath}`;

  const { stdout, stderr } = await execFileAsync(gbrainBin, ['call', tool, JSON.stringify(args)], {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: pathWithBun },
  });

  if (stderr) {
    log.debug('gbrain call stderr', { tool, stderr: stderr.slice(0, 200) });
  }

  return JSON.parse(stdout.trim());
}

export async function startGbrainProxy(port: number, gbrainBin: string, host = '0.0.0.0'): Promise<Server> {
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
          log.debug('gbrain tool call', { tool, argsKeys: Object.keys(args) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('JSON')) {
            log.warn('gbrain call returned non-JSON', { tool, err: msg });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          } else {
            log.error('gbrain call failed', { tool, err: msg });
            res.writeHead(500);
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
    });

    server.listen(port, host, () => {
      log.info('GBrain proxy started', { port, host, gbrainBin });
      resolve(server);
    });
  });
}

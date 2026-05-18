/**
 * NanoClaw OS workspace surface — `app_create` + `db_execute`.
 *
 * Both write a `system`-kind outbound row that the host's delivery
 * action registry picks up:
 *   • app_create  → openui_app_create  → persists to web_apps + fans out app.changed
 *   • db_execute  → db_execute         → runs SQL against the per-agent-group sandbox
 *
 * Inline OpenUI Lang in chat replies doesn't need a tool — the agent
 * just embeds `root = ...` code in its message and the workspace
 * detects it. Persistent app_create is for dashboards the user wants
 * to re-open from the sidebar.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function appId(): string {
  return `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const MAX_CODE_BYTES = 200_000;

export const appCreate: McpToolDefinition = {
  tool: {
    name: 'app_create',
    description:
      'Save an OpenUI Lang program as a persistent app the user can re-open from the NanoClaw OS workspace sidebar. Use ONLY for dashboards / status boards the user will revisit (NOT for one-off visual answers — for those just embed `root = ...` code in your chat reply). Read `skills/openui-lang/SKILL.md` before calling. Returns the assigned app id.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable app title shown in the sidebar.' },
        code: { type: 'string', description: 'OpenUI Lang program. Must include `root = ...`.' },
      },
      required: ['name', 'code'],
    },
  },
  async handler(args) {
    const name = (args.name as string | undefined)?.trim() ?? '';
    const code = (args.code as string | undefined) ?? '';
    if (!name) return err('name is required');
    if (!code) return err('code is required');
    if (!/^\s*root\s*=/m.test(code)) return err('Program must include a `root = ...` statement.');
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      return err(`Code too large (max ${MAX_CODE_BYTES} bytes).`);
    }
    const id = appId();
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'openui_app_create', app_id: id, name, code }),
    });
    log(`app_create: ${id} name="${name}" bytes=${code.length}`);
    return ok(`App saved as "${name}" (id: ${id}). It will appear in the workspace sidebar shortly.`);
  },
};

export const dbExecute: McpToolDefinition = {
  tool: {
    name: 'db_execute',
    description:
      'Run a SQL statement (DDL / INSERT / UPDATE / DELETE) against your per-agent-group sandbox SQLite. Use to set up tables + seed data the workspace UI can later read via `Query("sql", { q: "SELECT ..." })` in an OpenUI app. Multi-statement strings are NOT supported — call once per statement. Fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: 'Single SQL statement.' },
        params: { description: 'Optional positional (array) or named ($name) parameters.' },
      },
      required: ['sql'],
    },
  },
  async handler(args) {
    const sql = (args.sql as string | undefined)?.trim() ?? '';
    if (!sql) return err('sql is required');
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'db_execute', sql, params: args.params }),
    });
    log(`db_execute: bytes=${sql.length}`);
    return ok(
      "SQL submitted. Effects apply on the host's next delivery tick. Open apps that Query this data will pick up changes on their next refresh cycle.",
    );
  },
};

registerTools([appCreate, dbExecute]);

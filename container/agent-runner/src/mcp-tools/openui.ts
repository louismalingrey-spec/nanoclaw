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

function artifactId(): string {
  return `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const MAX_ARTIFACT_BYTES = 1_000_000;

export const createMarkdownArtifact: McpToolDefinition = {
  tool: {
    name: 'create_markdown_artifact',
    description:
      'Save a markdown document as a persistent artifact in the NanoClaw OS workspace sidebar. Use for: reports, meeting notes, weekly summaries, drafts — anything more than a few paragraphs the user will revisit. Returns the id. For dashboards with live data use app_create instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Title shown in the sidebar.' },
        content: { type: 'string', description: 'Markdown body.' },
      },
      required: ['name', 'content'],
    },
  },
  async handler(args) {
    const name = (args.name as string | undefined)?.trim() ?? '';
    const content = (args.content as string | undefined) ?? '';
    if (!name) return err('name is required');
    if (!content) return err('content is required');
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) return err(`Content too large (max ${MAX_ARTIFACT_BYTES}).`);
    const id = artifactId();
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'artifact_create', artifact_id: id, name, kind: 'markdown', content }),
    });
    log(`create_markdown_artifact: ${id} name="${name}" bytes=${content.length}`);
    return ok(`Saved as "${name}" (id: ${id}). It will appear in the workspace sidebar shortly.`);
  },
};

export const updateMarkdownArtifact: McpToolDefinition = {
  tool: {
    name: 'update_markdown_artifact',
    description: 'Replace the body of an existing markdown artifact (id from a previous create call). Use when iterating on a report/note instead of creating a new one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Artifact id (e.g. "art-...").' },
        name: { type: 'string', description: 'Updated title (optional — keeps existing if omitted).' },
        content: { type: 'string', description: 'Replacement markdown body.' },
      },
      required: ['id', 'content'],
    },
  },
  async handler(args) {
    const id = (args.id as string | undefined)?.trim() ?? '';
    const name = (args.name as string | undefined) ?? '';
    const content = (args.content as string | undefined) ?? '';
    if (!id) return err('id is required');
    if (!content) return err('content is required');
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) return err(`Content too large.`);
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'artifact_update', artifact_id: id, name: name || undefined, content }),
    });
    log(`update_markdown_artifact: ${id} bytes=${content.length}`);
    return ok(`Artifact ${id} updated.`);
  },
};

export const notify: McpToolDefinition = {
  tool: {
    name: 'notify',
    description:
      'Push a notification to the NanoClaw OS workspace inbox (bell icon). Use for: background task completion, cron results, errors needing attention. NOT for routine chat replies — those go through send_message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short headline (under 80 chars).' },
        body: { type: 'string', description: 'Optional details (plain text).' },
        kind: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Defaults to "info".' },
      },
      required: ['title'],
    },
  },
  async handler(args) {
    const title = (args.title as string | undefined)?.trim() ?? '';
    if (!title) return err('title is required');
    const body = (args.body as string | undefined) ?? '';
    const kind = ((args.kind as string | undefined) ?? 'info').toLowerCase();
    if (!['info', 'success', 'warning', 'error'].includes(kind)) return err(`Invalid kind: ${kind}`);
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({ action: 'notify_create', notification_id: id, kind, title, body: body || undefined }),
    });
    log(`notify: ${id} kind=${kind} title="${title.slice(0, 60)}"`);
    return ok(`Notification queued (id: ${id}).`);
  },
};

registerTools([appCreate, dbExecute, createMarkdownArtifact, updateMarkdownArtifact, notify]);

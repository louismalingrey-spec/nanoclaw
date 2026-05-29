/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags } from './formatter.js';
import { TIMEZONE } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the <messages> block', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const msgsIdx = result.indexOf('<messages>');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(msgsIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe(
      'The answer is 42',
    );
  });
});

/**
 * LANE H V1.5 — api_trigger system messages.
 *
 * Covers both legacy shape (no skill_content → `[API TRIGGER] / Input: …`)
 * and the new shape (skill_content present → `[SKILL EXECUTION REQUEST]`
 * with INSTRUCTIONS inline). The behavior is the contract that agency-os'
 * `/admin/skills/<id>/execute` flow depends on — without it the agent gets
 * an opaque Input blob and returns `Result: (empty)`.
 */
describe('api_trigger system message formatting', () => {
  it('legacy api_trigger (no skill_content) renders [API TRIGGER] with Input dump', () => {
    insertMessage('s1', 'system', {
      type: 'api_trigger',
      run_id: 'run-abc-123',
      dedup_key: 'manual:run-abc-123',
      priority: 'normal',
      target_entity_id: 'creator-9',
      input: { action: 'send_imessage', body: 'hi' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[API TRIGGER]');
    expect(result).toContain('run_id: run-abc-123');
    expect(result).toContain('dedup_key: manual:run-abc-123');
    expect(result).toContain('priority: normal');
    expect(result).toContain('target_entity_id: creator-9');
    expect(result).toContain('Input:');
    expect(result).toContain('send_imessage');
    // Legacy shape must NOT have the SKILL marker.
    expect(result).not.toContain('[SKILL EXECUTION REQUEST]');
  });

  it('skill_content present → renders [SKILL EXECUTION REQUEST] with inline INSTRUCTIONS', () => {
    insertMessage('s1', 'system', {
      type: 'api_trigger',
      run_id: 'run-xyz-789',
      dedup_key: 'manual:run-xyz-789',
      priority: 'normal',
      target_entity_id: null,
      input: { _manual: true, _dry_run: true, query: 'Polsia campaign' },
      skill_slug: 'brain_recall_test',
      skill_version: 1,
      skill_content:
        '## Procédure\nCall mcp__gbrain__search with the query, return top 3 results.',
    });
    const result = formatMessages(getPendingMessages());

    expect(result).toContain('[SKILL EXECUTION REQUEST]');
    expect(result).toContain('skill: brain_recall_test (v1)');
    expect(result).toContain('run_id: run-xyz-789');
    expect(result).toContain('INSTRUCTIONS:');
    expect(result).toContain('Call mcp__gbrain__search');
    // Input dict is JSON-stringified single line (not pretty-printed)
    expect(result).toMatch(/input:.*"_manual":\s*true/);
    expect(result).toMatch(/input:.*"_dry_run":\s*true/);
    // Trailing reminder paragraph must be present so the agent knows how
    // to interpret _dry_run / _manual.
    expect(result).toContain('Read INSTRUCTIONS above');
    expect(result).toContain('_dry_run');
    expect(result).toContain('_manual');
    // Legacy [API TRIGGER] header should NOT be emitted when we route to
    // the skill shape — otherwise the agent sees two competing headers.
    expect(result).not.toContain('[API TRIGGER]');
  });

  it('missing skill_version falls back to (v?)', () => {
    insertMessage('s1', 'system', {
      type: 'api_trigger',
      run_id: 'run-novers',
      input: {},
      skill_slug: 'some_skill',
      skill_content: '## Procédure\nDo the thing.',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('skill: some_skill (v?)');
  });

  it('LANE #61: skill_slug present with empty skill_content → MALFORMED error prompt', () => {
    // Pre-LANE #61 this fell through to the legacy [API TRIGGER] shape, which
    // handed the model an empty-instructions prompt → `Result: (empty)` →
    // outcome=null in agency-os. We now surface the configuration error so
    // the operator sees a clear failure message via runs.outcome.
    insertMessage('s1', 'system', {
      type: 'api_trigger',
      run_id: 'run-empty',
      input: { foo: 'bar' },
      skill_slug: 'brain-recall-test',
      skill_version: 1,
      skill_content: '',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[SKILL EXECUTION REQUEST — MALFORMED]');
    expect(result).toContain('skill: brain-recall-test (v1)');
    expect(result).toContain('run_id: run-empty');
    expect(result).toContain('CONFIGURATION ERROR');
    expect(result).toContain('SKILL_CONTENT_MISSING');
    // Must NOT be confused with a healthy skill exec or a legacy trigger.
    expect(result).not.toContain('[SKILL EXECUTION REQUEST]\n');
    expect(result).not.toContain('Read INSTRUCTIONS above');
    expect(result).not.toContain('[API TRIGGER]');
  });

  it('LANE #61: skill_slug present with skill_content omitted → MALFORMED error prompt', () => {
    // Same shape as the LANE #55 smoke test which surfaced the bug — caller
    // sent skill_slug + skill_version but no skill_content field at all.
    insertMessage('s1', 'system', {
      type: 'api_trigger',
      run_id: 'run-omitted',
      input: { query: 'hello' },
      skill_slug: 'brain-recall-test',
      skill_version: 1,
      // skill_content intentionally absent
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[SKILL EXECUTION REQUEST — MALFORMED]');
    expect(result).toContain('SKILL_CONTENT_MISSING');
    expect(result).toContain('skill_slug=brain-recall-test');
  });

  it('LANE #61: no skill_slug AND no skill_content keeps legacy [API TRIGGER] path', () => {
    // Pure legacy queue-action triggers (no skill metadata at all) must keep
    // working — the agent reads action_type / target_entity_id and dispatches
    // via the in-conversation playbook. Don't break this path.
    insertMessage('s1', 'system', {
      type: 'api_trigger',
      run_id: 'run-legacy',
      input: { action: 'send_imessage', body: 'hi' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[API TRIGGER]');
    expect(result).not.toContain('[SKILL EXECUTION REQUEST]');
    expect(result).not.toContain('MALFORMED');
  });

  it('non-api_trigger system message still renders [SYSTEM RESPONSE]', () => {
    insertMessage('s1', 'system', {
      action: 'schedule_task',
      status: 'ok',
      result: { task_id: 't1' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('[SYSTEM RESPONSE]');
    expect(result).toContain('Action: schedule_task');
    expect(result).toContain('Status: ok');
  });
});

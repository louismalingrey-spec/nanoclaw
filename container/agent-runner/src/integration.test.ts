import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('LANE #54: skill (api_trigger) batch clears prior continuation before query', async () => {
    // Seed a stale continuation as if a prior chat or skill run left one behind.
    // The fix in poll-loop.ts should detect the api_trigger system message in
    // this batch and clear that continuation BEFORE calling provider.query,
    // forcing the SDK to spawn a fresh transcript instead of resuming a
    // potentially-corrupted one.
    setContinuation('recording', 'stale-session-abc123');
    expect(getContinuation('recording')).toBe('stale-session-abc123');

    // Insert an api_trigger system message — the shape the dispatcher writes
    // (see src/dispatcher/api-trigger-dispatcher.ts → writeSessionMessage).
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content, trigger)
         VALUES ('api-trigger-1', 'system', datetime('now'), 'pending', ?, 1)`,
      )
      .run(
        JSON.stringify({
          type: 'api_trigger',
          run_id: 'run-test-1',
          dedup_key: 'lane54-test',
          priority: 'normal',
          target_entity_id: null,
          input: { _manual: true },
          skill_slug: 'test-skill',
          skill_version: 1,
          skill_content: '# Test skill\n\nDo nothing.',
        }),
      );

    const provider = new RecordingProvider();
    const controller = new AbortController();
    const loopPromise = Promise.race([
      runPollLoop({ provider, providerName: 'recording', cwd: '/tmp' }),
      new Promise<void>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);

    await waitFor(() => provider.calls.length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    // The provider must have been called with continuation === undefined for
    // this api_trigger batch — i.e. the stale 'stale-session-abc123' was NOT
    // forwarded into the SDK call.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].continuation).toBeUndefined();

    // And the persisted slot was rewritten to the provider's new init id, not
    // left as the stale one. (The mock provider emits 'fresh-init-id' on init.)
    expect(getContinuation('recording')).toBe('fresh-init-id');
  });

  it('LANE #55: skill (api_trigger) batch exits the poll loop gracefully after result', async () => {
    // After delivering the skill response the agent-runner must exit the
    // poll loop so the host dispatcher's reconcile sweep can immediately
    // harvest messages_out → runs.outcome and fire the outcome webhook.
    // Without this, the container sits idle until the 30-min ceiling
    // killer reaps it (gap of up to 30 min between "response ready" and
    // "agency-os sees the outcome"). The test asserts the loop returns
    // naturally (no abort, no timeout) AND that the response was written.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content, trigger)
         VALUES ('api-trigger-55a', 'system', datetime('now'), 'pending', ?, 1)`,
      )
      .run(
        JSON.stringify({
          type: 'api_trigger',
          run_id: 'run-test-55a',
          dedup_key: 'lane55-test-a',
          priority: 'normal',
          target_entity_id: null,
          input: { _manual: true },
          skill_slug: 'test-skill',
          skill_version: 1,
          skill_content: '# Test skill',
        }),
      );

    const provider = new RecordingProvider();
    const start = Date.now();
    // No abort signal — the loop MUST terminate on its own (via the LANE #55
    // exit path). A 3s timeout below would catch a regression where the
    // loop fails to terminate.
    const loopPromise = Promise.race([
      runPollLoop({ provider, providerName: 'recording-55a', cwd: '/tmp' }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('runPollLoop did not exit within 3s')), 3000)),
    ]);

    await loopPromise; // Must resolve, not reject

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);

    // The response was dispatched to messages_out before exit
    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(out[0].content).text).toBe('ok');

    // Exactly one query was made (no follow-up re-entry attempts after exit)
    expect(provider.calls).toHaveLength(1);
  });

  it('LANE #55: chat batch does NOT auto-exit after result (stays alive for next turn)', async () => {
    // The exit behaviour must be scoped to skill triggers. Chat sessions
    // depend on the warm-stream behaviour (keep the SDK subprocess alive
    // between turns to avoid the ~few-seconds re-spawn + transcript
    // reload). Asserts the loop is still running after the result event
    // — i.e. it requires the 1s race to time out instead of resolving
    // naturally.
    insertMessage('m-chat-55b', { sender: 'Alice', text: 'hi there' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new RecordingProvider();
    let resolvedNaturally = false;
    const loopPromise = runPollLoop({ provider, providerName: 'recording-55b', cwd: '/tmp' }).then(
      () => {
        resolvedNaturally = true;
      },
      () => {
        // ignore — test owns the lifecycle
      },
    );

    // Wait for the result to be written, then give the loop another beat
    // to (incorrectly) exit if the regression were present.
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    await sleep(300);

    expect(resolvedNaturally).toBe(false);

    // Tear down: detach from the still-running loop. The afterEach
    // closeSessionDb() will release resources; the dangling poll loop
    // exits on next iteration when the DB connection errors.
    await Promise.race([loopPromise, sleep(50)]);
  });

  it('LANE #54: chat batch preserves prior continuation (no fresh-session reset)', async () => {
    // The skill-fresh logic must NOT touch normal chat flows. Resuming a
    // chat session is the whole point of session continuity.
    setContinuation('recording', 'chat-session-keep-me');

    insertMessage('m1', { sender: 'Alice', text: 'hello again' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new RecordingProvider();
    const controller = new AbortController();
    const loopPromise = Promise.race([
      runPollLoop({ provider, providerName: 'recording', cwd: '/tmp' }),
      new Promise<void>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);

    await waitFor(() => provider.calls.length > 0, 2000);
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].continuation).toBe('chat-session-keep-me');
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test-only provider that records the `QueryInput` of every query() call so the
 * LANE #54 tests can assert what continuation poll-loop forwarded into the SDK.
 */
class RecordingProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly calls: QueryInput[] = [];

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.calls.push({ ...input });
    let ended = false;
    let waiting: (() => void) | null = null;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 'fresh-init-id' };
        yield { type: 'result', text: '<message to="discord-test">ok</message>' };
        while (!ended) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
      },
    };

    return {
      push() {
        /* no-op for the recording test */
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        ended = true;
        waiting?.();
      },
    };
  }
}

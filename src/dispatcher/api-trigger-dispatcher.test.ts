import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be hoisted above the imports they cover.
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// container-runner pulls in lots of host-side machinery (OneCLI, docker exec,
// session-manager, providers/...). We stub it to the surface the dispatcher
// actually depends on so the test runs in-memory.
const wakeContainerMock = vi.fn<(s: { id: string }) => Promise<boolean>>(async () => true);
const isContainerRunningMock = vi.fn<(id: string) => boolean>(() => false);
const getActiveContainerCountMock = vi.fn<() => number>(() => 0);

vi.mock('../container-runner.js', () => ({
  wakeContainer: (s: { id: string }) => wakeContainerMock(s),
  isContainerRunning: (id: string) => isContainerRunningMock(id),
  getActiveContainerCount: () => getActiveContainerCountMock(),
}));

// session-manager touches the filesystem; we stub the bits the dispatcher hits.
const writeSessionMessageMock = vi.fn();
const resolveSessionMock = vi.fn<
  (
    agentGroupId: string,
    mgId: string | null,
    threadId: string | null,
    mode: string,
  ) => {
    session: { id: string; agent_group_id: string };
    created: boolean;
  }
>();

vi.mock('../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => writeSessionMessageMock(...args),
  resolveSession: (...args: unknown[]) =>
    resolveSessionMock(args[0] as string, args[1] as string, args[2] as string | null, args[3] as string),
}));

// env.js reads the on-disk .env file; not relevant for tests.
vi.mock('../env.js', () => ({
  readEnvFile: () => ({}),
}));

import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { _internals } from './api-trigger-dispatcher.js';

const { extractTargetEntityId, ensureApiTriggerWiring, reconcileFinished, selectQueuedRuns, state } = _internals;

function now(): string {
  return new Date().toISOString();
}

function insertRun(opts: {
  id: string;
  agent_group_id: string;
  dedup_key?: string | null;
  status?: string;
  priority?: string;
  input?: unknown;
  attempt_count?: number;
  created_at?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO runs
         (id, agent_group_id, dedup_key, status, priority, input, attempt_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.agent_group_id,
      opts.dedup_key ?? null,
      opts.status ?? 'queued',
      opts.priority ?? 'normal',
      opts.input ? JSON.stringify(opts.input) : null,
      opts.attempt_count ?? 0,
      opts.created_at ?? now(),
    );
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });

  // Reset module state between tests so each test starts clean.
  state.trackedRuns.clear();
  state.targetLocks.clear();
  state.lastAlertAt = 0;
  state.lastPollAt = null;
  state.lastDispatchAt = null;

  wakeContainerMock.mockReset().mockImplementation(async () => true);
  isContainerRunningMock.mockReset().mockImplementation(() => false);
  getActiveContainerCountMock.mockReset().mockImplementation(() => 0);
  writeSessionMessageMock.mockReset();
  resolveSessionMock.mockReset().mockImplementation(() => ({
    session: { id: 'sess-1', agent_group_id: 'ag-1' },
    created: true,
  }));
});

afterEach(() => {
  closeDb();
});

// ── Pure helper: extractTargetEntityId ───────────────────────────────

describe('extractTargetEntityId', () => {
  it('returns null for missing input', () => {
    expect(extractTargetEntityId(null)).toBeNull();
    expect(extractTargetEntityId('')).toBeNull();
    expect(extractTargetEntityId('not json')).toBeNull();
  });

  it('reads the explicit slot first', () => {
    expect(extractTargetEntityId(JSON.stringify({ target_entity_id: 'aaa', parameters: { creator_id: 'bbb' } }))).toBe(
      'aaa',
    );
  });

  it('falls back to nested parameters', () => {
    expect(extractTargetEntityId(JSON.stringify({ parameters: { creator_id: 'creator-99' } }))).toBe('creator-99');
  });

  it('falls back to top-level conventional keys', () => {
    expect(extractTargetEntityId(JSON.stringify({ queue_item_id: 'q-1' }))).toBe('q-1');
  });

  it('returns null when no slot matches', () => {
    expect(extractTargetEntityId(JSON.stringify({ action: 'ping' }))).toBeNull();
  });
});

// ── DB-driven: selectQueuedRuns ──────────────────────────────────────

describe('selectQueuedRuns', () => {
  it('orders by priority then created_at', () => {
    insertRun({ id: 'r-old-normal', agent_group_id: 'ag-1', created_at: '2026-05-19T00:00:00Z' });
    insertRun({
      id: 'r-new-high',
      agent_group_id: 'ag-1',
      priority: 'high',
      created_at: '2026-05-20T10:00:00Z',
    });
    insertRun({
      id: 'r-new-low',
      agent_group_id: 'ag-1',
      priority: 'low',
      created_at: '2026-05-20T11:00:00Z',
    });

    const got = selectQueuedRuns(10);
    expect(got.map((r) => r.id)).toEqual(['r-new-high', 'r-old-normal', 'r-new-low']);
  });

  it('excludes non-queued rows', () => {
    insertRun({ id: 'r-running', agent_group_id: 'ag-1', status: 'running' });
    insertRun({ id: 'r-success', agent_group_id: 'ag-1', status: 'success' });
    insertRun({ id: 'r-queued', agent_group_id: 'ag-1' });
    expect(selectQueuedRuns(10).map((r) => r.id)).toEqual(['r-queued']);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 15; i++) {
      insertRun({
        id: `r-${i}`,
        agent_group_id: 'ag-1',
        created_at: `2026-05-20T00:00:${String(i).padStart(2, '0')}Z`,
      });
    }
    expect(selectQueuedRuns(5)).toHaveLength(5);
  });
});

// ── DB-driven: ensureApiTriggerWiring ────────────────────────────────

describe('ensureApiTriggerWiring', () => {
  it('creates a messaging_group_agents row on first call', () => {
    ensureApiTriggerWiring('ag-1');
    const row = getDb()
      .prepare(
        `SELECT * FROM messaging_group_agents WHERE messaging_group_id = 'mg-api-trigger' AND agent_group_id = 'ag-1'`,
      )
      .get() as { engage_mode: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.engage_mode).toBe('pattern');
  });

  it('is idempotent', () => {
    ensureApiTriggerWiring('ag-1');
    ensureApiTriggerWiring('ag-1');
    const count = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM messaging_group_agents WHERE messaging_group_id = 'mg-api-trigger' AND agent_group_id = 'ag-1'`,
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});

// ── Synthetic messaging_group seeded by migration 017 ────────────────

describe('migration 017 seeded data', () => {
  it('creates the mg-api-trigger row', () => {
    const row = getDb().prepare(`SELECT * FROM messaging_groups WHERE id = 'mg-api-trigger'`).get() as
      | { channel_type: string; name: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.channel_type).toBe('api-trigger');
    expect(row!.name).toBe('API Trigger');
  });

  it('adds attempt_count + target_entity_id columns to runs', () => {
    insertRun({ id: 'r-1', agent_group_id: 'ag-1' });
    const row = getDb().prepare(`SELECT attempt_count, target_entity_id FROM runs WHERE id = 'r-1'`).get() as {
      attempt_count: number;
      target_entity_id: string | null;
    };
    expect(row.attempt_count).toBe(0);
    expect(row.target_entity_id).toBeNull();
  });
});

// ── DB-driven: atomic claim invariant ────────────────────────────────

describe('atomic claim', () => {
  it('exactly one of two concurrent UPDATEs wins', () => {
    insertRun({ id: 'r-race', agent_group_id: 'ag-1' });
    const sql = `UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`;
    const a = getDb().prepare(sql).run(now(), 'r-race');
    const b = getDb().prepare(sql).run(now(), 'r-race');
    // SQLite executes serially; the second UPDATE sees status='running'
    // and changes 0 rows. This mirrors what the dispatcher relies on.
    expect(a.changes + b.changes).toBe(1);
  });
});

// ── DB-driven: reconcileFinished ─────────────────────────────────────

describe('reconcileFinished', () => {
  it('marks a tracked run success when its container is no longer running', () => {
    insertRun({ id: 'r-fin', agent_group_id: 'ag-1', status: 'running' });
    state.trackedRuns.set('sess-fin', {
      runId: 'r-fin',
      sessionId: 'sess-fin',
      agentGroupId: 'ag-1',
      targetEntityId: null,
      // Older than the 10s grace so reconcile picks it up immediately.
      startedAt: Date.now() - 30_000,
    });
    isContainerRunningMock.mockImplementation(() => false);

    reconcileFinished();

    const row = getDb().prepare(`SELECT status, ended_at FROM runs WHERE id = 'r-fin'`).get() as {
      status: string;
      ended_at: string | null;
    };
    expect(row.status).toBe('success');
    expect(row.ended_at).not.toBeNull();
    expect(state.trackedRuns.size).toBe(0);
  });

  it('leaves the run alone if container still registered', () => {
    insertRun({ id: 'r-still', agent_group_id: 'ag-1', status: 'running' });
    state.trackedRuns.set('sess-still', {
      runId: 'r-still',
      sessionId: 'sess-still',
      agentGroupId: 'ag-1',
      targetEntityId: null,
      startedAt: Date.now() - 30_000,
    });
    isContainerRunningMock.mockImplementation(() => true);

    reconcileFinished();
    const row = getDb().prepare(`SELECT status FROM runs WHERE id = 'r-still'`).get() as {
      status: string;
    };
    expect(row.status).toBe('running');
    expect(state.trackedRuns.size).toBe(1);
  });

  it('respects the grace window for very-recent spawns', () => {
    insertRun({ id: 'r-grace', agent_group_id: 'ag-1', status: 'running' });
    state.trackedRuns.set('sess-grace', {
      runId: 'r-grace',
      sessionId: 'sess-grace',
      agentGroupId: 'ag-1',
      targetEntityId: null,
      // Spawned 100ms ago — inside the 10s grace window.
      startedAt: Date.now() - 100,
    });
    isContainerRunningMock.mockImplementation(() => false);

    reconcileFinished();
    const row = getDb().prepare(`SELECT status FROM runs WHERE id = 'r-grace'`).get() as {
      status: string;
    };
    expect(row.status).toBe('running');
    expect(state.trackedRuns.size).toBe(1);
  });
});

// ── DB-driven: dedup invariant ───────────────────────────────────────

describe('dedup partial unique index (migration 016)', () => {
  it('rejects two active runs with the same dedup_key', () => {
    insertRun({ id: 'r-a', agent_group_id: 'ag-1', dedup_key: 'k1', status: 'queued' });
    expect(() => insertRun({ id: 'r-b', agent_group_id: 'ag-1', dedup_key: 'k1', status: 'queued' })).toThrow(/UNIQUE/);
  });

  it('allows reusing a dedup_key once the first run is complete', () => {
    insertRun({ id: 'r-done', agent_group_id: 'ag-1', dedup_key: 'k2', status: 'success' });
    expect(() => insertRun({ id: 'r-new', agent_group_id: 'ag-1', dedup_key: 'k2', status: 'queued' })).not.toThrow();
  });
});

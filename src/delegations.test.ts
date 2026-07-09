import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DelegationStore } from './delegations.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0TEST';

const openStore = () => {
  let tick = 0;
  return new DelegationStore(':memory:', () => `2026-07-08T12:00:0${tick++}.000Z`);
};

const dispatchRow = (overrides: Partial<Parameters<DelegationStore['recordDispatch']>[0]> = {}) => ({
  taskId: 'task_13c700f151b3',
  dispatchId: 'ctx_8b685db09a47',
  worktreeId: '444c::/home/dev/scratch::workspace:98',
  worktreeName: 'scratch-21-bench',
  worktreePath: '/home/dev/scratch',
  repo: 'scratch',
  issueNumber: 21,
  agent: 'claude',
  workerHandle: 'term_300035ab',
  threadTs: THREAD,
  channelId: CHANNEL,
  cardTs: '1751970001.000200',
  title: 'bench harness',
  ...overrides,
});

describe('DelegationStore — delegations ledger', () => {
  it('records a dispatch with every identifier and reads it back', () => {
    const store = openStore();

    store.recordDispatch(dispatchRow());

    expect(store.listForThread(THREAD)).toEqual([
      {
        ...dispatchRow(),
        status: 'dispatched',
        dispatchedAt: '2026-07-08T12:00:00.000Z',
        lastBusAt: null,
        closedAt: null,
      },
    ]);
  });

  it('replaces, not duplicates, a replayed dispatch id', () => {
    const store = openStore();

    store.recordDispatch(dispatchRow());
    store.recordDispatch(dispatchRow({ title: 'bench harness, retried' }));

    const rows = store.listForThread(THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('bench harness, retried');
  });

  it('counts only in-flight delegations toward the worker cap', () => {
    const store = openStore();

    store.recordDispatch(dispatchRow());
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_2', taskId: 'task_2' }));

    expect(store.inFlightCount()).toBe(2);
  });

  it('recordBusActivity stamps the in-flight row’s bus clock (issue #48)', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());

    expect(store.recordBusActivity('ctx_8b685db09a47')).toBe(true);

    expect(store.getByDispatchId('ctx_8b685db09a47')?.lastBusAt).toBe('2026-07-08T12:00:01.000Z');
  });

  it('a bus straggler stamps neither a closed dispatch nor an unknown one', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.closeDelegation('ctx_8b685db09a47', 'completed');

    expect(store.recordBusActivity('ctx_8b685db09a47')).toBe(false);
    expect(store.recordBusActivity('ctx_never_seen')).toBe(false);

    expect(store.getByDispatchId('ctx_8b685db09a47')?.lastBusAt).toBeNull();
  });

  it('a replayed dispatch resets the bus clock — a fresh hand-off starts silent', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordBusActivity('ctx_8b685db09a47');

    store.recordDispatch(dispatchRow({ title: 'bench harness, retried' }));

    expect(store.getByDispatchId('ctx_8b685db09a47')?.lastBusAt).toBeNull();
  });

  it('migrates a pre-#48 delegations table in place — rows survive, the bus clock works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-delegations-'));
    const dbPath = join(dir, 'orchestrator.db');
    try {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE delegations (
          dispatch_id   TEXT PRIMARY KEY,
          task_id       TEXT NOT NULL,
          worktree_id   TEXT,
          worktree_name TEXT,
          worktree_path TEXT,
          repo          TEXT,
          issue_number  INTEGER,
          agent         TEXT,
          worker_handle TEXT,
          thread_ts     TEXT NOT NULL,
          channel_id    TEXT NOT NULL,
          card_ts       TEXT,
          title         TEXT,
          status        TEXT NOT NULL DEFAULT 'dispatched'
                        CHECK (status IN ('dispatched', 'completed', 'failed')),
          dispatched_at TEXT NOT NULL,
          closed_at     TEXT
        ) STRICT;
      `);
      legacy
        .prepare(
          `INSERT INTO delegations
             (dispatch_id, task_id, thread_ts, channel_id, status, dispatched_at)
           VALUES (?, ?, ?, ?, 'dispatched', ?)`,
        )
        .run('ctx_pre48', 'task_pre48', THREAD, CHANNEL, '2026-07-08T11:00:00.000Z');
      legacy.close();

      const store = new DelegationStore(dbPath);
      expect(store.getByDispatchId('ctx_pre48')).toMatchObject({
        taskId: 'task_pre48',
        status: 'dispatched',
        lastBusAt: null,
      });
      expect(store.recordBusActivity('ctx_pre48')).toBe(true);
      expect(store.getByDispatchId('ctx_pre48')?.lastBusAt).not.toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close flips the status and stamps closed_at — the #20 seam', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());

    store.closeDelegation('ctx_8b685db09a47', 'completed');

    const row = store.listForThread(THREAD)[0];
    expect(row?.status).toBe('completed');
    expect(row?.closedAt).not.toBeNull();
    expect(store.inFlightCount()).toBe(0);
  });

  it('accepts a dispatch the daemon could not fully associate — nulls, not a crash', () => {
    const store = openStore();

    store.recordDispatch(
      dispatchRow({
        worktreeId: null,
        worktreeName: null,
        worktreePath: null,
        repo: null,
        issueNumber: null,
        agent: null,
        workerHandle: null,
        cardTs: null,
        title: null,
      }),
    );

    expect(store.listForThread(THREAD)).toHaveLength(1);
    expect(store.listForThread(THREAD)[0]?.issueNumber).toBeNull();
  });

  it('scopes the thread ledger to the thread', () => {
    const store = openStore();

    store.recordDispatch(dispatchRow());
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_2', threadTs: '1751970099.000900' }));

    expect(store.listForThread(THREAD)).toHaveLength(1);
    expect(store.listForThread('1751970099.000900')).toHaveLength(1);
    expect(store.listForThread('1751970098.000000')).toHaveLength(0);
  });
});

describe('DelegationStore — closing and the in-flight views (issue #20)', () => {
  it('closes an in-flight row exactly once — the duplicate reports false', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());

    expect(store.closeDelegation('ctx_8b685db09a47', 'completed')).toBe(true);
    expect(store.closeDelegation('ctx_8b685db09a47', 'failed')).toBe(false);

    const row = store.getByDispatchId('ctx_8b685db09a47');
    expect(row?.status).toBe('completed');
    expect(row?.closedAt).not.toBeNull();
    expect(store.inFlightCount()).toBe(0);
  });

  it('finds a row by dispatch id, or by task id among the thread’s in-flight', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordDispatch(
      dispatchRow({ dispatchId: 'ctx_other_thread', threadTs: '1751970099.000900' }),
    );

    expect(store.getByDispatchId('ctx_8b685db09a47')?.threadTs).toBe(THREAD);
    expect(store.getByDispatchId('ctx_nope')).toBeUndefined();
    // Task-id fallback is thread-scoped: the other thread's row never matches.
    expect(store.inFlightByTaskId(THREAD, 'task_13c700f151b3')?.dispatchId).toBe(
      'ctx_8b685db09a47',
    );
    expect(store.inFlightByTaskId('1751970098.000000', 'task_13c700f151b3')).toBeUndefined();
  });

  it('the task-id fallback skips closed rows and prefers the newest', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.closeDelegation('ctx_8b685db09a47', 'failed');
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_retry' }));

    expect(store.inFlightByTaskId(THREAD, 'task_13c700f151b3')?.dispatchId).toBe('ctx_retry');
  });

  it('lists a thread’s in-flight rows and the threads needing a watcher', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_2' }));
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_3', threadTs: '1751970099.000900' }));
    store.closeDelegation('ctx_2', 'completed');

    expect(store.listInFlightForThread(THREAD).map((row) => row.dispatchId)).toEqual([
      'ctx_8b685db09a47',
    ]);
    expect(store.threadsWithInFlight()).toEqual([
      { threadTs: THREAD, channelId: CHANNEL },
      { threadTs: '1751970099.000900', channelId: CHANNEL },
    ]);

    store.closeDelegation('ctx_8b685db09a47', 'completed');
    store.closeDelegation('ctx_3', 'failed');
    expect(store.threadsWithInFlight()).toEqual([]);
  });
});

describe('DelegationStore — mailboxes', () => {
  it('remembers a thread mailbox handle across lookups', () => {
    const store = openStore();

    expect(store.getMailbox(THREAD)).toBeUndefined();
    store.setMailbox(THREAD, CHANNEL, 'term_mailbox_1');

    expect(store.getMailbox(THREAD)).toBe('term_mailbox_1');
  });

  it('replaces a stale handle for the same thread', () => {
    const store = openStore();

    store.setMailbox(THREAD, CHANNEL, 'term_mailbox_1');
    store.setMailbox(THREAD, CHANNEL, 'term_mailbox_2');

    expect(store.getMailbox(THREAD)).toBe('term_mailbox_2');
  });

  it('keeps mailboxes per thread', () => {
    const store = openStore();

    store.setMailbox(THREAD, CHANNEL, 'term_mailbox_1');

    expect(store.getMailbox('1751970099.000900')).toBeUndefined();
  });
});

const gateRow = (overrides: Partial<Parameters<DelegationStore['recordGate']>[0]> = {}) => ({
  msgId: 'msg_6a8c14d55c7d',
  threadTs: THREAD,
  taskId: 'task_13c700f151b3',
  dispatchId: 'ctx_8b685db09a47',
  workerHandle: 'term_300035ab',
  worktreeName: 'scratch-21-bench',
  kind: 'decision_gate' as const,
  question: 'Which lint config is authoritative for CI?',
  options: ['root', 'app/', 'merge both'],
  relayTs: '1751970002.000300',
  ...overrides,
});

describe('DelegationStore — pending_gates registry (issue #21)', () => {
  it('records a relayed gate and reads it back pending, options intact', () => {
    const store = openStore();

    expect(store.recordGate(gateRow())).toBe(true);

    expect(store.getGate('msg_6a8c14d55c7d')).toEqual({
      ...gateRow(),
      status: 'pending',
      supersededBy: null,
      relayedAt: '2026-07-08T12:00:00.000Z',
      answeredAt: null,
    });
  });

  it('first relay wins — a replayed gate neither duplicates nor resets', () => {
    const store = openStore();

    store.recordGate(gateRow());
    store.answerGate('msg_6a8c14d55c7d');

    expect(store.recordGate(gateRow({ question: 'rewritten?' }))).toBe(false);
    expect(store.getGate('msg_6a8c14d55c7d')).toMatchObject({
      question: 'Which lint config is authoritative for CI?',
      status: 'answered',
    });
  });

  it('answers a gate exactly once — the second flip reports it lost', () => {
    const store = openStore();
    store.recordGate(gateRow());

    expect(store.answerGate('msg_6a8c14d55c7d')).toBe(true);
    expect(store.answerGate('msg_6a8c14d55c7d')).toBe(false);
    expect(store.answerGate('msg_unknown')).toBe(false);

    expect(store.getGate('msg_6a8c14d55c7d')?.answeredAt).toBe('2026-07-08T12:00:01.000Z');
  });

  it('lists a thread’s gates oldest first, pending view filtered', () => {
    const store = openStore();
    store.recordGate(gateRow({ msgId: 'msg_1' }));
    store.recordGate(gateRow({ msgId: 'msg_2', kind: 'escalation', options: [] }));
    store.recordGate(gateRow({ msgId: 'msg_other', threadTs: '1751970099.000900' }));
    store.answerGate('msg_1');

    expect(store.listGatesForThread(THREAD).map((gate) => gate.msgId)).toEqual([
      'msg_1',
      'msg_2',
    ]);
    expect(store.listPendingGates(THREAD).map((gate) => gate.msgId)).toEqual(['msg_2']);
  });

  it('degrades unreadable options to an empty list instead of throwing', () => {
    const store = openStore();
    store.recordGate(gateRow({ options: [] }));

    expect(store.getGate('msg_6a8c14d55c7d')?.options).toEqual([]);
  });
});

describe('DelegationStore — stall_alerts registry (issue #22)', () => {
  const stallRow = (overrides: Partial<Parameters<DelegationStore['recordStall']>[0]> = {}) => ({
    dispatchId: 'ctx_8b685db09a47',
    threadTs: THREAD,
    workerHandle: 'term_300035ab',
    worktreeName: 'scratch-21-bench',
    lastOutput: '? Overwrite existing bench.json? (y/N)',
    fingerprint: '1783528800000',
    relayTs: '1751970003.000400',
    ...overrides,
  });

  it('records a posted alert and reads it back pending', () => {
    const store = openStore();

    store.recordStall(stallRow());

    expect(store.getStall('ctx_8b685db09a47')).toEqual({
      ...stallRow(),
      status: 'pending',
      alertedAt: '2026-07-08T12:00:00.000Z',
      answeredAt: null,
    });
  });

  it('a new stall state replaces the old alert wholesale — back to pending', () => {
    const store = openStore();
    store.recordStall(stallRow());
    store.answerStall('ctx_8b685db09a47');

    store.recordStall(stallRow({ fingerprint: '1783529900000', lastOutput: '? again (y/N)' }));

    expect(store.getStall('ctx_8b685db09a47')).toMatchObject({
      fingerprint: '1783529900000',
      lastOutput: '? again (y/N)',
      status: 'pending',
      answeredAt: null,
    });
    expect(store.listStallsForThread(THREAD)).toHaveLength(1);
  });

  it('answers a stall exactly once — the second flip reports it lost', () => {
    const store = openStore();
    store.recordStall(stallRow());

    expect(store.answerStall('ctx_8b685db09a47')).toBe(true);
    expect(store.answerStall('ctx_8b685db09a47')).toBe(false);
    expect(store.answerStall('ctx_unknown')).toBe(false);

    expect(store.getStall('ctx_8b685db09a47')?.answeredAt).toBe('2026-07-08T12:00:01.000Z');
  });

  it('lists a thread’s stalls oldest first, pending view filtered, thread-scoped', () => {
    const store = openStore();
    store.recordStall(stallRow({ dispatchId: 'ctx_1' }));
    store.recordStall(stallRow({ dispatchId: 'ctx_2' }));
    store.recordStall(stallRow({ dispatchId: 'ctx_other', threadTs: '1751970099.000900' }));
    store.answerStall('ctx_1');

    expect(store.listStallsForThread(THREAD).map((stall) => stall.dispatchId)).toEqual([
      'ctx_1',
      'ctx_2',
    ]);
    expect(store.listPendingStalls(THREAD).map((stall) => stall.dispatchId)).toEqual(['ctx_2']);
  });

  it('closing the delegation settles its pending stall alert — the worker reported after all', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordStall(stallRow());

    store.closeDelegation('ctx_8b685db09a47', 'completed');

    expect(store.getStall('ctx_8b685db09a47')?.status).toBe('answered');
    expect(store.listPendingStalls(THREAD)).toEqual([]);
  });

  it('lists every in-flight delegation across threads — the sweep’s inspection set', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_2', threadTs: '1751970099.000900' }));
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_3' }));
    store.closeDelegation('ctx_3', 'failed');

    expect(store.listInFlight().map((row) => row.dispatchId)).toEqual([
      'ctx_8b685db09a47',
      'ctx_2',
    ]);
  });
});

describe('DelegationStore — the asking-handle fallback (issue #21)', () => {
  it('finds the thread’s newest in-flight row by worker handle, never a closed one', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_old', workerHandle: 'term_w' }));
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_new', workerHandle: 'term_w' }));
    store.recordDispatch(
      dispatchRow({ dispatchId: 'ctx_other', workerHandle: 'term_w', threadTs: '1751970099.000900' }),
    );

    expect(store.inFlightByWorkerHandle(THREAD, 'term_w')?.dispatchId).toBe('ctx_new');
    expect(store.inFlightByWorkerHandle(THREAD, 'term_unknown')).toBeUndefined();

    store.closeDelegation('ctx_new', 'completed');
    expect(store.inFlightByWorkerHandle(THREAD, 'term_w')?.dispatchId).toBe('ctx_old');
  });
});

describe('DelegationStore — reconciliation fingerprints (issue #25)', () => {
  it('remembers the last posted fingerprint per thread', () => {
    const store = openStore();

    expect(store.getReconcileFingerprint(THREAD)).toBeUndefined();

    store.setReconcileFingerprint(THREAD, 'ctx_a=in-flight');
    expect(store.getReconcileFingerprint(THREAD)).toBe('ctx_a=in-flight');
    expect(store.getReconcileFingerprint('1751970099.000900')).toBeUndefined();
  });

  it('replaces the fingerprint on a state change instead of stacking rows', () => {
    const store = openStore();

    store.setReconcileFingerprint(THREAD, 'ctx_a=in-flight');
    store.setReconcileFingerprint(THREAD, 'ctx_a=stalled');

    expect(store.getReconcileFingerprint(THREAD)).toBe('ctx_a=stalled');
  });
});

describe('DelegationStore — any-status task lookup (issue #25)', () => {
  it('finds the thread’s newest row for a task even after it closed', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.closeDelegation('ctx_8b685db09a47', 'completed');

    expect(store.latestByTaskId(THREAD, 'task_13c700f151b3')?.dispatchId).toBe('ctx_8b685db09a47');
    expect(store.latestByTaskId('1751970099.000900', 'task_13c700f151b3')).toBeUndefined();
    expect(store.latestByTaskId(THREAD, 'task_none')).toBeUndefined();
  });
});

describe('DelegationStore — gate registry hygiene (issue #46)', () => {
  it('supersedes a pending gate exactly once, remembering its successor', () => {
    const store = openStore();
    store.recordGate(gateRow());

    expect(store.supersedeGate('msg_6a8c14d55c7d', 'msg_reask')).toBe(true);
    expect(store.supersedeGate('msg_6a8c14d55c7d', 'msg_other')).toBe(false);

    expect(store.getGate('msg_6a8c14d55c7d')).toMatchObject({
      status: 'superseded',
      supersededBy: 'msg_reask',
    });
  });

  it('never supersedes an answered gate — its reply already went down', () => {
    const store = openStore();
    store.recordGate(gateRow());
    store.answerGate('msg_6a8c14d55c7d');

    expect(store.supersedeGate('msg_6a8c14d55c7d', 'msg_reask')).toBe(false);
    expect(store.getGate('msg_6a8c14d55c7d')).toMatchObject({
      status: 'answered',
      supersededBy: null,
    });
  });

  it('the pending view is the LIVE set — superseded and closed gates drop out', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordGate(gateRow({ msgId: 'msg_stale' }));
    store.recordGate(gateRow({ msgId: 'msg_live' }));
    store.supersedeGate('msg_stale', 'msg_live');
    store.recordGate(
      gateRow({ msgId: 'msg_moot', dispatchId: 'ctx_done', taskId: 'task_done', workerHandle: 'term_done' }),
    );
    store.recordDispatch(
      dispatchRow({ dispatchId: 'ctx_done', taskId: 'task_done', workerHandle: 'term_done' }),
    );
    store.closeDelegation('ctx_done', 'completed');

    expect(store.listPendingGates(THREAD).map((gate) => gate.msgId)).toEqual(['msg_live']);
    // The full ledger view still shows every row — history is never erased.
    expect(store.listGatesForThread(THREAD).map((gate) => gate.msgId)).toEqual([
      'msg_stale',
      'msg_live',
      'msg_moot',
    ]);
  });

  it('closing a delegation closes its still-pending gates — by dispatch id or identity fallback', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    // Three attribution shapes, all this delegation's: the full id, a
    // taskId-only row, a handle-only row (the migrated pre-#46 shape).
    store.recordGate(gateRow({ msgId: 'msg_by_dispatch' }));
    store.recordGate(gateRow({ msgId: 'msg_by_task', dispatchId: null, workerHandle: null }));
    store.recordGate(gateRow({ msgId: 'msg_by_handle', dispatchId: null, taskId: null }));
    // A sibling's gate and an already-answered gate must both survive.
    store.recordGate(
      gateRow({ msgId: 'msg_sibling', dispatchId: 'ctx_s', taskId: 'task_s', workerHandle: 'term_s' }),
    );
    store.recordGate(gateRow({ msgId: 'msg_answered' }));
    store.answerGate('msg_answered');

    expect(store.closeDelegation('ctx_8b685db09a47', 'completed')).toBe(true);

    expect(store.getGate('msg_by_dispatch')?.status).toBe('closed');
    expect(store.getGate('msg_by_task')?.status).toBe('closed');
    expect(store.getGate('msg_by_handle')?.status).toBe('closed');
    expect(store.getGate('msg_sibling')?.status).toBe('pending');
    expect(store.getGate('msg_answered')?.status).toBe('answered');
  });

  it('a duplicate close touches no gates — a retry’s fresh ask stays live', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.closeDelegation('ctx_8b685db09a47', 'failed');
    store.recordGate(gateRow({ msgId: 'msg_retry_ask', dispatchId: 'ctx_retry' }));

    expect(store.closeDelegation('ctx_8b685db09a47', 'completed')).toBe(false);
    expect(store.getGate('msg_retry_ask')?.status).toBe('pending');
  });

  it('never closes another thread’s gates, whatever their identity', () => {
    const store = openStore();
    store.recordDispatch(dispatchRow());
    store.recordGate(gateRow({ msgId: 'msg_elsewhere', threadTs: '1751970099.000900' }));

    store.closeDelegation('ctx_8b685db09a47', 'completed');

    expect(store.getGate('msg_elsewhere')?.status).toBe('pending');
  });

  it('migrates a pre-#46 pending_gates table in place — rows survive, new statuses work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-gates-'));
    const dbPath = join(dir, 'orchestrator.db');
    try {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE pending_gates (
          msg_id        TEXT PRIMARY KEY,
          thread_ts     TEXT NOT NULL,
          task_id       TEXT,
          worker_handle TEXT,
          worktree_name TEXT,
          kind          TEXT NOT NULL
                        CHECK (kind IN ('decision_gate', 'escalation')),
          question      TEXT NOT NULL,
          options       TEXT NOT NULL,
          relay_ts      TEXT,
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'answered')),
          relayed_at    TEXT NOT NULL,
          answered_at   TEXT
        ) STRICT;
      `);
      legacy
        .prepare(
          `INSERT INTO pending_gates
             (msg_id, thread_ts, task_id, worker_handle, worktree_name,
              kind, question, options, relay_ts, status, relayed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .run(
          'msg_d658da142a94',
          THREAD,
          'task_old',
          'term_old',
          'scratch-2-report',
          'decision_gate',
          'which format should the report file use?',
          '[]',
          '1751970002.000300',
          '2026-07-09T12:31:04.000Z',
        );
      legacy.close();

      const store = new DelegationStore(dbPath);
      expect(store.getGate('msg_d658da142a94')).toMatchObject({
        question: 'which format should the report file use?',
        status: 'pending',
        dispatchId: null,
        supersededBy: null,
      });
      expect(store.supersedeGate('msg_d658da142a94', 'msg_reask')).toBe(true);
      expect(store.recordGate(gateRow())).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

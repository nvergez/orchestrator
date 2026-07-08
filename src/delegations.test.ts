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

    expect(store.countForThread(THREAD)).toBe(1);
    expect(store.listForThread(THREAD)[0]?.issueNumber).toBeNull();
  });

  it('scopes thread counts to the thread', () => {
    const store = openStore();

    store.recordDispatch(dispatchRow());
    store.recordDispatch(dispatchRow({ dispatchId: 'ctx_2', threadTs: '1751970099.000900' }));

    expect(store.countForThread(THREAD)).toBe(1);
    expect(store.countForThread('1751970099.000900')).toBe(1);
    expect(store.countForThread('1751970098.000000')).toBe(0);
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

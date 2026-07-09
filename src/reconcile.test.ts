import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { DelegationStore } from './delegations.ts';
import { BootReconciler } from './reconcile.ts';
import type { WatcherSurface } from './watcher.ts';
import type { CommandRunner } from './orca.ts';

const THREAD = '1751970000.000100';
const THREAD_B = '1751970001.000200';
const CHANNEL = 'C0ASJR3LAE6';
const MAILBOX = 'term_mb1';
const NOW = Date.parse('2026-07-08T12:30:00.000Z');

/** The orca CLI `--json` envelope, as captured from the real runtime. */
const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

const checkOut = (...messages: object[]): string =>
  envelope({ messages, count: messages.length });

const workerDone = (over: Partial<Record<string, unknown>> = {}): object => ({
  id: 'msg_a8f37bac632f',
  from_handle: 'term_w1',
  to_handle: MAILBOX,
  subject: 'bench harness shipped',
  body: 'Opened https://github.com/nvergez/scratch/pull/22 with the harness. Tests green.',
  type: 'worker_done',
  priority: 'normal',
  payload: JSON.stringify({ taskId: 'task_3f81', dispatchId: 'ctx_d1' }),
  read: false,
  ...over,
});

const taskListOut = (...tasks: object[]): string => envelope({ tasks });

const psWorktree = (over: Partial<Record<string, unknown>> = {}): object => ({
  worktreeId: 'wt-1',
  path: '/home/dev/orca/workspaces/scratch/scratch-21-bench',
  isArchived: false,
  liveTerminalCount: 2,
  lastOutputAt: NOW - 4 * 60_000,
  ...over,
});

const psOut = (...worktrees: object[]): string => envelope({ worktrees });

const REPO_LIST_OUT = envelope({
  repos: [
    {
      id: 'repo-scratch',
      displayName: 'scratch',
      gitRemoteIdentity: { canonicalKey: 'github.com/nvergez/scratch' },
    },
  ],
});

class FakeSurface implements WatcherSurface {
  posts: Array<{ threadTs: string; text: string }> = [];
  updates: Array<{ ts: string; text: string }> = [];
  reactions: Array<{ ts: string; name: string }> = [];
  removed: Array<{ ts: string; name: string }> = [];
  failPosts = false;
  private counter = 0;

  post(threadTs: string, text: string): Promise<string> {
    if (this.failPosts) return Promise.reject(new Error('slack down'));
    this.posts.push({ threadTs, text });
    this.counter += 1;
    return Promise.resolve(`msg-ts-${this.counter}`);
  }

  update(ts: string, text: string): Promise<void> {
    this.updates.push({ ts, text });
    return Promise.resolve();
  }

  react(ts: string, name: string): Promise<void> {
    this.reactions.push({ ts, name });
    return Promise.resolve();
  }

  unreact(ts: string, name: string): Promise<void> {
    this.removed.push({ ts, name });
    return Promise.resolve();
  }
}

interface RunnerScript {
  /** `orchestration task-list --json` stdout, or a failure. */
  taskList?: string | Error;
  /** `worktree ps --json` stdout, or a failure. */
  ps?: string | Error;
  /** `repo list --json` stdout, or a failure. */
  repoList?: string | Error;
  /** `orchestration check --all` stdout per `--terminal` handle. */
  checks?: Record<string, string | Error>;
  /** `worktree rm --json` stdout, or a refusal; default: a clean removal. */
  worktreeRm?: string | Error;
}

/** Dispatches on the orca subcommand — reconciliation's read-only calls,
 * plus the one write: the success cleanup's `worktree rm` (issue #43). */
const makeRunner = (script: RunnerScript) => {
  const calls: string[][] = [];
  const answer = (value: string | Error | undefined, what: string): Promise<{ stdout: string }> => {
    if (value === undefined) return Promise.reject(new Error(`unscripted ${what}`));
    return value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value });
  };
  const run: CommandRunner = (_command, args) => {
    calls.push(args);
    if (args[0] === 'orchestration' && args[1] === 'task-list') {
      return answer(script.taskList, 'task-list');
    }
    if (args[0] === 'worktree' && args[1] === 'ps') return answer(script.ps, 'worktree ps');
    if (args[0] === 'worktree' && args[1] === 'rm') {
      return answer(script.worktreeRm ?? envelope({ removed: true }), 'worktree rm');
    }
    if (args[0] === 'repo' && args[1] === 'list') {
      return answer(script.repoList ?? REPO_LIST_OUT, 'repo list');
    }
    if (args[0] === 'orchestration' && args[1] === 'check') {
      const terminal = args[args.indexOf('--terminal') + 1] ?? '';
      return answer(script.checks?.[terminal] ?? checkOut(), 'check');
    }
    return Promise.reject(new Error(`unexpected orca call: ${args.join(' ')}`));
  };
  return { run, calls };
};

const seedDispatch = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordDispatch']>[0]> = {},
): void => {
  store.recordDispatch({
    taskId: 'task_3f81',
    dispatchId: 'ctx_d1',
    worktreeId: 'wt-1',
    worktreeName: 'scratch-21-bench',
    worktreePath: '/home/dev/orca/workspaces/scratch/scratch-21-bench',
    repo: 'scratch',
    issueNumber: 21,
    agent: 'claude',
    workerHandle: 'term_w1',
    threadTs: THREAD,
    channelId: CHANNEL,
    cardTs: 'card-ts-1',
    title: 'bench harness',
    ...over,
  });
};

const makeReconciler = (
  store: DelegationStore,
  script: RunnerScript,
  opts: { stallAfterMs?: number } = {},
) => {
  const surface = new FakeSurface();
  const { run, calls } = makeRunner(script);
  const reconciler = new BootReconciler({
    store,
    surface,
    logger: createLogger('silent'),
    run,
    now: () => new Date(NOW),
    ...opts,
  });
  return { reconciler, surface, calls };
};

const restartPosts = (surface: FakeSurface): string[] =>
  surface.posts.filter((post) => post.text.startsWith('⚠️ Restarted')).map((post) => post.text);

describe('BootReconciler — completions missed during the outage', () => {
  it('closes the row, flips the card and reports ✅ from a peeked worker_done', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface, calls } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut(workerDone()) },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    // The outage completion gets the same success cleanup as the live path
    // (issue #43) — silently, since the removal succeeded.
    expect(calls.filter((args) => args[1] === 'rm')).toEqual([
      ['worktree', 'rm', '--worktree', 'id:wt-1', '--json'],
    ]);
    // The card flipped to its final ✅ state with the report's PR link.
    expect(surface.updates).toHaveLength(1);
    expect(surface.updates[0]?.ts).toBe('card-ts-1');
    expect(surface.updates[0]?.text).toContain('✅ *scratch#21 — bench harness');
    expect(surface.updates[0]?.text).toContain('https://github.com/nvergez/scratch/pull/22');
    // Exactly one ⚠️ line, truthful about the completion.
    const notices = restartPosts(surface);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      '⚠️ Restarted — `scratch#21` was in flight: ✅ completed during the outage ' +
        '(details in the card ⤴). Reply to resume supervision.',
    );
    // Root reaction flips to ✅ — nothing else is in flight.
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'white_check_mark' }]);
  });

  it('reads a "Failed:" subject as a failure — row closed failed, card ❌', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: {
        [MAILBOX]: checkOut(workerDone({ subject: 'Failed: bench deps will not install' })),
      },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('failed');
    expect(surface.updates[0]?.text).toContain('❌ *scratch#21 — bench harness');
    expect(surface.updates[0]?.text).toContain('Failed: bench deps will not install');
    expect(restartPosts(surface)[0]).toContain(
      '❌ failed during the outage — Failed: bench deps will not install',
    );
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'x' }]);
  });

  it('falls back to the task list when the worker_done never reached the mailbox', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(restartPosts(surface)[0]).toContain('✅ completed during the outage');
  });

  it('closes a task the runtime marked failed', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'failed' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('failed');
    expect(restartPosts(surface)[0]).toContain('❌ failed during the outage');
  });

  it('never cleans up a failed closure — the worktree is the debugging evidence', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, calls } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'failed' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(calls.filter((args) => args[1] === 'rm')).toEqual([]);
  });

  it('a cleanup refusal keeps the worktree, posts the 🧹 line, and never blocks the ⚠️ notice', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut(workerDone()) },
      worktreeRm: new Error('orca down'),
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(
      surface.posts.some((post) => post.text.includes('🧹 Could not clean up worktree `scratch-21-bench`')),
    ).toBe(true);
    expect(restartPosts(surface)).toHaveLength(1);
  });

  it('keeps the mailbox peek read-only — check runs with --all, never --unread', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, calls } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    const check = calls.find((args) => args[1] === 'check');
    expect(check).toContain('--all');
    expect(check).not.toContain('--unread');
    expect(check).not.toContain('--wait');
  });
});

describe('BootReconciler — workers still out there', () => {
  it('reports the mock verbatim for a live in-flight worker and keeps the row open', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(surface)).toEqual([
      '⚠️ Restarted — `scratch#21` was in flight: still in progress (last sign 4 min ago). ' +
        'Reply to resume supervision.',
    ]);
    // No card edit, no reaction change — the worker was never touched.
    expect(surface.updates).toEqual([]);
    expect(surface.reactions).toEqual([]);
  });

  it('reads a long-quiet worktree as stalled, truthfully aged', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree({ lastOutputAt: NOW - 40 * 60_000 })),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(surface)[0]).toContain('seems stalled — no sign for 40 min');
  });

  it('reads a worktree with no live terminal as stalled, not failed', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree({ liveTerminalCount: 0 })),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(surface)[0]).toContain('seems stalled — its worker terminal is gone');
  });

  it('reports a vanished worktree truthfully but never closes on absent evidence', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(surface)[0]).toContain('its worktree is no longer listed — presumed dead');
    expect(surface.reactions).toEqual([]);
  });

  it('reads an archived worktree without a completion as presumed dead, row kept open', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree({ isArchived: true })),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(surface)[0]).toContain('archived without a completion');
  });

  it('honors a custom stall threshold through the stallAfterMs seam', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(
      store,
      {
        taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
        ps: psOut(psWorktree({ lastOutputAt: NOW - 2 * 60_000 })),
        checks: { [MAILBOX]: checkOut() },
      },
      { stallAfterMs: 60_000 },
    );

    await reconciler.reconcile();

    expect(restartPosts(surface)[0]).toContain('seems stalled — no sign for 2 min');
  });

  it('keeps an unobservable delegation open instead of inventing a failure', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store, { worktreeId: null, worktreeName: null, worktreePath: null });
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      // The task is not in the task list either — nothing observable at all.
      taskList: taskListOut(),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(surface)[0]).toContain('state unknown');
  });
});

describe('BootReconciler — one ⚠️ per thread, idempotence', () => {
  it('groups several delegations of one thread into a single ⚠️ message', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    seedDispatch(store, {
      taskId: 'task_9c22',
      dispatchId: 'ctx_d2',
      worktreeId: 'wt-2',
      worktreeName: 'scratch-22-docs',
      worktreePath: '/home/dev/orca/workspaces/scratch/scratch-22-docs',
      issueNumber: 22,
      cardTs: 'card-ts-2',
      title: 'docs pass',
    });
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut(
        { id: 'task_3f81', status: 'completed' },
        { id: 'task_9c22', status: 'dispatched' },
      ),
      ps: psOut(psWorktree({ worktreeId: 'wt-2', path: '/home/dev/orca/workspaces/scratch/scratch-22-docs' })),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    const notices = restartPosts(surface);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      [
        '⚠️ Restarted — 2 delegations were in flight:',
        '• `scratch#21` — ✅ completed during the outage (details in the card ⤴)',
        '• `scratch#22` — still in progress (last sign 4 min ago)',
        'Reply to resume supervision.',
      ].join('\n'),
    );
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(store.getByDispatchId('ctx_d2')?.status).toBe('dispatched');
    // A sibling still runs — the root must keep saying 👀, not flip to ✅.
    expect(surface.reactions).toEqual([]);
  });

  it('posts nothing on a second restart with unchanged state', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const script: RunnerScript = {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    };

    const first = makeReconciler(store, script);
    await first.reconciler.reconcile();
    expect(restartPosts(first.surface)).toHaveLength(1);

    const second = makeReconciler(store, script);
    await second.reconciler.reconcile();
    expect(restartPosts(second.surface)).toHaveLength(0);

    // The state moved (in flight → stalled): the third restart reports again.
    const third = makeReconciler(store, {
      ...script,
      ps: psOut(psWorktree({ lastOutputAt: NOW - 40 * 60_000 })),
    });
    await third.reconciler.reconcile();
    expect(restartPosts(third.surface)).toHaveLength(1);
    expect(restartPosts(third.surface)[0]).toContain('seems stalled');
  });

  it('reports a completion even when the previous restart already reported in-flight', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);

    const first = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });
    await first.reconciler.reconcile();

    const second = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut(workerDone()) },
    });
    await second.reconciler.reconcile();

    expect(restartPosts(second.surface)).toHaveLength(1);
    expect(restartPosts(second.surface)[0]).toContain('✅ completed during the outage');
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');

    // And a third restart — the thread has nothing in flight — stays silent.
    const third = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: { [MAILBOX]: checkOut(workerDone()) },
    });
    await third.reconciler.reconcile();
    expect(restartPosts(third.surface)).toHaveLength(0);
  });

  it('retries the ⚠️ post on the next restart when Slack was down', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const script: RunnerScript = {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    };

    const first = makeReconciler(store, script);
    first.surface.failPosts = true;
    await first.reconciler.reconcile();
    expect(first.surface.posts).toEqual([]);

    const second = makeReconciler(store, script);
    await second.reconciler.reconcile();
    expect(restartPosts(second.surface)).toHaveLength(1);
  });

  it('leaves unaffected threads alone', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_done', threadTs: THREAD_B, cardTs: 'card-b' });
    store.closeDelegation('ctx_done', 'completed');
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(surface.posts.every((post) => post.threadTs === THREAD)).toBe(true);
  });
});

describe('BootReconciler — degraded runtimes', () => {
  it('says state unknown when Orca is unreachable — rows untouched, no crash-loop spam', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const script: RunnerScript = {
      taskList: new Error('orca down'),
      ps: new Error('orca down'),
    };

    const first = makeReconciler(store, script);
    await first.reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(restartPosts(first.surface)).toEqual([
      '⚠️ Restarted — `scratch#21` was in flight: state unknown (Orca runtime unavailable). ' +
        'Reply to resume supervision.',
    ]);

    // systemd Restart=always with Orca still down must not re-post.
    const second = makeReconciler(store, script);
    await second.reconciler.reconcile();
    expect(second.surface.posts).toEqual([]);

    // Orca back up with the worker alive — the state changed, so it posts.
    const third = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree()),
      checks: { [MAILBOX]: checkOut() },
    });
    await third.reconciler.reconcile();
    expect(restartPosts(third.surface)[0]).toContain('still in progress');
  });

  it('reconciles from task state alone when the mailbox peek fails', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      checks: { [MAILBOX]: new Error('check exploded') },
    });

    await reconciler.reconcile();

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(restartPosts(surface)[0]).toContain('✅ completed during the outage');
  });

  it('degrades to plain references when the registry lookup fails', async () => {
    const store = new DelegationStore(':memory:');
    seedDispatch(store);
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'completed' }),
      ps: psOut(),
      repoList: new Error('orca hiccup'),
      checks: { [MAILBOX]: checkOut(workerDone()) },
    });

    await reconciler.reconcile();

    expect(surface.updates[0]?.text).toContain('• issue: scratch#21');
    expect(restartPosts(surface)).toHaveLength(1);
  });
});

describe('BootReconciler — worktree matching', () => {
  it('borrows the path fallback only for rows that never learned their worktree id', async () => {
    const store = new DelegationStore(':memory:');
    // Folder-repo shape: the recorded worktree id vanished, but a sibling
    // workspace (the folder's main entry) still lives at the same path.
    seedDispatch(store, { worktreePath: '/home/dev/scratch' });
    store.setMailbox(THREAD, CHANNEL, MAILBOX);
    const { reconciler, surface } = makeReconciler(store, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree({ worktreeId: 'wt-main-folder', path: '/home/dev/scratch' })),
      checks: { [MAILBOX]: checkOut() },
    });

    await reconciler.reconcile();

    expect(restartPosts(surface)[0]).toContain('its worktree is no longer listed — presumed dead');

    // An id-less row at the same path does borrow the path match.
    const store2 = new DelegationStore(':memory:');
    seedDispatch(store2, { worktreeId: null, worktreePath: '/home/dev/scratch' });
    store2.setMailbox(THREAD, CHANNEL, MAILBOX);
    const second = makeReconciler(store2, {
      taskList: taskListOut({ id: 'task_3f81', status: 'dispatched' }),
      ps: psOut(psWorktree({ worktreeId: 'wt-main-folder', path: '/home/dev/scratch' })),
      checks: { [MAILBOX]: checkOut() },
    });
    await second.reconciler.reconcile();
    expect(restartPosts(second.surface)[0]).toContain('still in progress');
  });
});

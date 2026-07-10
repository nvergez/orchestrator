import { describe, expect, it } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { DelegationStore } from './delegations.ts';
import { isFailureSubject, ThreadSurface, type Surface } from './thread-surface.ts';
import type { CommandRunner } from '../kernel/orca.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0EXAMPLE123';

/** The orca CLI `--json` envelope, as captured from the real runtime. */
const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

/** Recording Slack adapter; each failure mode mimics the Web API's usual error. */
class FakeSurface implements Surface {
  posts: Array<{ threadTs: string; text: string }> = [];
  updates: Array<{ ts: string; text: string }> = [];
  reactions: Array<{ ts: string; name: string }> = [];
  removed: Array<{ ts: string; name: string }> = [];
  failPosts = false;
  failUpdates = false;
  failAdd = false;
  failRemove = false;
  private counter = 0;

  post(threadTs: string, text: string): Promise<string> {
    if (this.failPosts) return Promise.reject(new Error('slack down'));
    this.posts.push({ threadTs, text });
    this.counter += 1;
    return Promise.resolve(`msg-ts-${this.counter}`);
  }

  update(ts: string, text: string): Promise<void> {
    if (this.failUpdates) return Promise.reject(new Error('slack down'));
    this.updates.push({ ts, text });
    return Promise.resolve();
  }

  react(ts: string, name: string): Promise<void> {
    if (this.failAdd) return Promise.reject(new Error('already_reacted'));
    this.reactions.push({ ts, name });
    return Promise.resolve();
  }

  unreact(ts: string, name: string): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error('no_reaction'));
    this.removed.push({ ts, name });
    return Promise.resolve();
  }
}

const seedDispatch = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordDispatch']>[0]> = {},
): void => {
  store.recordDispatch({
    taskId: 'task_3f81',
    dispatchId: 'ctx_d1',
    worktreeId: 'wt-1',
    worktreeName: 'webapp-84-csv-export',
    worktreePath: '/home/op/orca/workspaces/webapp/webapp-84-csv-export',
    repo: 'webapp',
    issueNumber: 84,
    agent: 'claude',
    workerHandle: 'term_w1',
    threadTs: THREAD,
    channelId: CHANNEL,
    cardTs: 'card-ts-1',
    title: 'CSV export of send metrics',
    ...over,
  });
};

const seedGate = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordGate']>[0]> = {},
): void => {
  store.recordGate({
    msgId: 'msg_g1',
    threadTs: THREAD,
    taskId: 'task_3f81',
    dispatchId: 'ctx_d1',
    workerHandle: 'term_w1',
    worktreeName: 'webapp-84-csv-export',
    kind: 'decision_gate',
    question: 'push the branch?',
    options: [],
    relayTs: 'msg-ts-1',
    ...over,
  });
};

const seedStall = (store: DelegationStore, dispatchId = 'ctx_d1'): void => {
  store.recordStall({
    dispatchId,
    threadTs: THREAD,
    workerHandle: 'term_w1',
    worktreeName: 'webapp-84-csv-export',
    lastOutput: '? proceed (y/N)',
    fingerprint: '1751970000000',
    relayTs: 'alert-ts-1',
  });
};

const makeThreadSurface = (options: { rmResult?: string | Error } = {}) => {
  const store = new DelegationStore(':memory:');
  const surface = new FakeSurface();
  const rmCalls: string[] = [];
  const run: CommandRunner = (_command, args) => {
    if (args[0] === 'worktree' && args[1] === 'rm') {
      rmCalls.push(args.join(' '));
      const result = options.rmResult ?? envelope({ removed: true });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ stdout: result });
    }
    return Promise.reject(new Error(`unscripted orca call: ${args.join(' ')}`));
  };
  const threadSurface = new ThreadSurface({
    surface,
    store,
    logger: createLogger('silent'),
    run,
  });
  return { threadSurface, store, surface, rmCalls };
};

describe('ackWorking — the add-only 👀 (issue #49)', () => {
  it('adds 👀 on the root and nothing else — no stale-reaction sweep', async () => {
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.ackWorking(THREAD);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'eyes' }]);
    // Add-only: a pending ❓/🚨 or an earlier ✅/❌ must survive the ack —
    // the settle/done flips own every coarse-state transition.
    expect(surface.removed).toEqual([]);
  });

  it('swallows a failed add (already_reacted) — the ack never fails a turn', async () => {
    const { threadSurface, surface } = makeThreadSurface();
    surface.failAdd = true;

    await expect(threadSurface.ackWorking(THREAD)).resolves.toBeUndefined();
  });
});

describe('settleTurnEnd — the remove-only 👀 (issue #49)', () => {
  it('removes the 👀 when nothing is in flight and nothing is pending', async () => {
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.settleTurnEnd(THREAD);

    expect(surface.removed).toEqual([{ ts: THREAD, name: 'eyes' }]);
    expect(surface.reactions).toEqual([]);
  });

  it('leaves the root untouched while a delegation is in flight', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.settleTurnEnd(THREAD);

    expect(surface.removed).toEqual([]);
    expect(surface.reactions).toEqual([]);
  });

  it('leaves the root untouched while a gate is pending', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedGate(store);

    await threadSurface.settleTurnEnd(THREAD);

    expect(surface.removed).toEqual([]);
  });

  it('leaves the root untouched while a stall alert is pending', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedStall(store);

    await threadSurface.settleTurnEnd(THREAD);

    expect(surface.removed).toEqual([]);
  });

  it('leaves the root untouched while a created-but-undispatched worktree waits', async () => {
    // The create→dispatch window has no ledger row yet — only the
    // coordinator knows, and its signal must keep the milestone 👀 on.
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.settleTurnEnd(THREAD, true);

    expect(surface.removed).toEqual([]);
  });

  it('a closed delegation no longer pins the 👀 — only in-flight work counts', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);
    store.closeDelegation('ctx_d1', 'completed');

    await threadSurface.settleTurnEnd(THREAD);

    expect(surface.removed).toEqual([{ ts: THREAD, name: 'eyes' }]);
  });

  it('swallows a failed removal (no_reaction) — the settle never fails a turn', async () => {
    const { threadSurface, surface } = makeThreadSurface();
    surface.failRemove = true;

    await expect(threadSurface.settleTurnEnd(THREAD)).resolves.toBeUndefined();
  });
});

describe('settleRoot — 🚨 outranks ❓ outranks 👀 (spec §8)', () => {
  it('settles to 👀 when nothing pends, sweeping the other managed reactions off', async () => {
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.settleRoot(THREAD);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'eyes' }]);
    expect(surface.removed.map((reaction) => reaction.name).sort()).toEqual([
      'question',
      'rotating_light',
      'white_check_mark',
      'x',
    ]);
  });

  it('settles to ❓ while only questions pend', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedGate(store);

    await threadSurface.settleRoot(THREAD);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'question' }]);
  });

  it('settles to 🚨 while an escalation pends, even alongside a question', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedGate(store);
    seedGate(store, { msgId: 'msg_esc', kind: 'escalation', question: 'main is broken' });

    await threadSurface.settleRoot(THREAD);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
  });

  it('settles to 🚨 while a watchdog stall alert pends', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedStall(store);

    await threadSurface.settleRoot(THREAD);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
  });

  it('never throws when the Slack adapter fails both ways — reactions are ambient', async () => {
    const { threadSurface, surface } = makeThreadSurface();
    surface.failAdd = true;
    surface.failRemove = true;

    await expect(threadSurface.settleRoot(THREAD)).resolves.toBeUndefined();
  });
});

describe('settleWorkerDone — the live close (spec §8)', () => {
  it('a failure lands ❌ immediately, even with siblings still in flight', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.settleWorkerDone(THREAD, true);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'x' }]);
  });

  it('a success flips to ✅ once nothing is left in flight', async () => {
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.settleWorkerDone(THREAD, false);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'white_check_mark' }]);
  });

  it('a success with a sibling still out settles back to 👀 — never a premature ✅', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.settleWorkerDone(THREAD, false);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'eyes' }]);
  });

  it('a success keeps 🚨 while a sibling’s stall alert pends', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);
    seedStall(store);

    await threadSurface.settleWorkerDone(THREAD, false);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
  });
});

describe('settleReconciled — the boot batch close (issue #25)', () => {
  it('any failed closure surfaces as ❌', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.settleReconciled(THREAD, ['completed', 'failed']);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'x' }]);
  });

  it('all-clear flips to ✅ when the closures left nothing in flight', async () => {
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.settleReconciled(THREAD, ['completed']);

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'white_check_mark' }]);
  });

  it('a completed closure with a sibling still open leaves the root alone', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.settleReconciled(THREAD, ['completed']);

    expect(surface.reactions).toEqual([]);
    expect(surface.removed).toEqual([]);
  });

  it('no closures leave the root alone', async () => {
    const { threadSurface, surface } = makeThreadSurface();

    await threadSurface.settleReconciled(THREAD, []);

    expect(surface.reactions).toEqual([]);
    expect(surface.removed).toEqual([]);
  });
});

describe('finishCard — the ✅/❌ flip', () => {
  const cardOpts = {
    durationMs: 27 * 60_000,
    issueUrl: 'https://github.com/acme/webapp/issues/84',
    reportText: 'Opened https://github.com/acme/webapp/pull/87 with the export endpoint.',
  };

  const row = (store: DelegationStore) => {
    const found = store.getByDispatchId('ctx_d1');
    if (found === undefined) throw new Error('seed the dispatch first');
    return found;
  };

  it('flips the existing card to ✅ with the durable links', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.finishCard(row(store), cardOpts);

    expect(surface.posts).toEqual([]);
    expect(surface.updates).toHaveLength(1);
    const card = surface.updates[0];
    expect(card?.ts).toBe('card-ts-1');
    expect(card?.text).toContain('✅ *webapp#84 — CSV export of send metrics — delivered in 27 min*');
    expect(card?.text).toContain('• PR: <https://github.com/acme/webapp/pull/87|webapp#87>');
    expect(card?.text).toContain('• issue: <https://github.com/acme/webapp/issues/84|webapp#84>');
    expect(card?.text).toContain('• worktree: `/home/op/orca/workspaces/webapp/webapp-84-csv-export`');
  });

  it('posts a fresh final card when no ⚙️ card ever landed', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store, { cardTs: null });

    await threadSurface.finishCard(row(store), cardOpts);

    expect(surface.updates).toEqual([]);
    expect(surface.posts.some((post) => post.text.startsWith('✅ *webapp#84'))).toBe(true);
  });

  it('renders ❌ with the reason when a failureReason rides along', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.finishCard(row(store), {
      ...cardOpts,
      reportText: '',
      failureReason: 'Failed: e2e tests break on main',
    });

    const card = surface.updates[0]?.text ?? '';
    expect(card).toContain('❌ *webapp#84 — CSV export of send metrics — failed after 27 min*');
    expect(card).toContain('• reason: Failed: e2e tests break on main');
  });

  it('swallows a failed card edit — the flip is cosmetics, never a crash', async () => {
    const { threadSurface, store, surface } = makeThreadSurface();
    seedDispatch(store);
    surface.failUpdates = true;

    await expect(threadSurface.finishCard(row(store), cardOpts)).resolves.toBeUndefined();
  });
});

describe('cleanupDeliveredWorktree (issue #43)', () => {
  const row = (store: DelegationStore) => {
    const found = store.getByDispatchId('ctx_d1');
    if (found === undefined) throw new Error('seed the dispatch first');
    return found;
  };

  it('removes the delivered worktree, silently', async () => {
    const { threadSurface, store, surface, rmCalls } = makeThreadSurface();
    seedDispatch(store);

    await threadSurface.cleanupDeliveredWorktree(row(store));

    expect(rmCalls).toEqual(['worktree rm --worktree id:wt-1 --json']);
    expect(surface.posts).toEqual([]);
  });

  it('a row with no worktree id skips cleanup silently', async () => {
    const { threadSurface, store, surface, rmCalls } = makeThreadSurface();
    seedDispatch(store, { worktreeId: null, worktreeName: null, worktreePath: null });

    await threadSurface.cleanupDeliveredWorktree(row(store));

    expect(rmCalls).toEqual([]);
    expect(surface.posts).toEqual([]);
  });

  it('a dirty-tree refusal keeps the worktree and posts the 🧹 line with the runtime’s reason', async () => {
    const refusal = Object.assign(new Error('Command failed: orca'), {
      stdout: JSON.stringify({
        id: 'x',
        ok: false,
        error: {
          code: 'runtime_error',
          message:
            'Failed to delete worktree at /home/op/orca/workspaces/webapp/webapp-84-csv-export. ?? notes.md',
        },
      }),
    });
    const { threadSurface, store, surface } = makeThreadSurface({ rmResult: refusal });
    seedDispatch(store);

    await threadSurface.cleanupDeliveredWorktree(row(store));

    expect(surface.posts).toEqual([
      {
        threadTs: THREAD,
        text:
          '🧹 Could not clean up worktree `webapp-84-csv-export` — kept for inspection.\n' +
          '> Failed to delete worktree at /home/op/orca/workspaces/webapp/webapp-84-csv-export. ?? notes.md',
      },
    ]);
  });

  it('a failed 🧹 post after a refusal is still never a crash', async () => {
    const { threadSurface, store, surface } = makeThreadSurface({
      rmResult: new Error('rm refused'),
    });
    seedDispatch(store);
    surface.failPosts = true;

    await expect(threadSurface.cleanupDeliveredWorktree(row(store))).resolves.toBeUndefined();
  });
});

describe('isFailureSubject — the worker_done failure contract (issue #20)', () => {
  it.each(['Failed: e2e tests break on main', '  failed — gave up', 'FAILURE'])(
    'reads "%s" as a failure',
    (subject) => {
      expect(isFailureSubject(subject)).toBe(true);
    },
  );

  it.each(['CSV export shipped', 'Done: the failing test now passes'])(
    'reads "%s" as a success',
    (subject) => {
      expect(isFailureSubject(subject)).toBe(false);
    },
  );
});

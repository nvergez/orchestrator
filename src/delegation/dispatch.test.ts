import { describe, expect, it } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { DelegationStore } from './delegations.ts';
import { DelegationCoordinator } from './dispatch.ts';
import { ThreadSurface, type Surface } from './thread-surface.ts';
import type { CommandRunner } from '../kernel/orca.ts';

const THREAD = '1751970000.000100';
const THREAD_B = '1751970001.000200';
const CHANNEL = 'C0EXAMPLE123';
const DAEMON_WT = '/home/op/projects/orchestrator';

const CREATE_CMD =
  'orca worktree create --repo id:repo-fwd --name webapp-84-csv-export ' +
  '--agent claude --issue 84 --no-parent --json';
const DISPATCH_CMD = 'orca orchestration dispatch --task task_3f81 --to term_w1 --inject --json';

/** The orca CLI `--json` envelope, as captured from the real runtime. */
const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

const WT_CREATE_OUT = envelope({
  worktree: {
    id: 'wt-1',
    repoId: 'repo-fwd',
    path: '/home/op/orca/workspaces/webapp/webapp-84-csv-export',
    displayName: 'webapp-84-csv-export',
    linkedIssue: 84,
  },
});
const TERMINAL_LIST_OUT = envelope({
  terminals: [{ handle: 'term_w1', worktreeId: 'wt-1', title: '✳ worker' }],
});
const TASK_CREATE_OUT = envelope({
  task: { id: 'task_3f81', task_title: 'CSV export of send metrics', display_name: 'webapp#84' },
});
const DISPATCH_OUT = envelope({
  dispatch: { id: 'ctx_d1', task_id: 'task_3f81', assignee_handle: 'term_w1' },
  injected: true,
});
const REPO_LIST_OUT = envelope({
  repos: [
    {
      id: 'repo-fwd',
      displayName: 'webapp',
      gitRemoteIdentity: { canonicalKey: 'github.com/acme/webapp' },
    },
    { id: 'repo-sandbox', displayName: 'sandbox' },
  ],
});

class FakeSurface implements Surface {
  posts: Array<{ threadTs: string; text: string }> = [];
  updates: Array<{ ts: string; text: string }> = [];
  reactions: Array<{ ts: string; name: string }> = [];
  removed: Array<{ ts: string; name: string }> = [];
  failPosts = false;
  failReactions = false;
  private counter = 0;

  post(threadTs: string, text: string): Promise<string> {
    if (this.failPosts) return Promise.reject(new Error('slack down'));
    this.posts.push({ threadTs, text });
    this.counter += 1;
    return Promise.resolve(`card-ts-${this.counter}`);
  }

  update(ts: string, text: string): Promise<void> {
    this.updates.push({ ts, text });
    return Promise.resolve();
  }

  react(ts: string, name: string): Promise<void> {
    if (this.failReactions) return Promise.reject(new Error('already_reacted'));
    this.reactions.push({ ts, name });
    return Promise.resolve();
  }

  unreact(ts: string, name: string): Promise<void> {
    this.removed.push({ ts, name });
    return Promise.resolve();
  }
}

/** Prefix-scripted CommandRunner recording every daemon-side orca call. */
const makeRunner = (script: Record<string, string | Error> = {}) => {
  const calls: string[] = [];
  const table: Record<string, string | Error> = {
    'repo list --json': REPO_LIST_OUT,
    'terminal list --json': envelope({ terminals: [] }),
    'terminal create': envelope({ terminal: { handle: 'term_mb1' } }),
    ...script,
  };
  const run: CommandRunner = (_command, args) => {
    const key = args.join(' ');
    calls.push(key);
    for (const [prefix, out] of Object.entries(table)) {
      if (key.startsWith(prefix)) {
        return out instanceof Error ? Promise.reject(out) : Promise.resolve({ stdout: out });
      }
    }
    return Promise.reject(new Error(`no script for: ${key}`));
  };
  return { run, calls };
};

const makeCoordinator = (
  options: {
    workerCap?: number;
    store?: DelegationStore;
    surface?: FakeSurface;
    script?: Record<string, string | Error>;
    onDispatched?: (threadTs: string) => void;
  } = {},
) => {
  const store = options.store ?? new DelegationStore(':memory:');
  const surface = options.surface ?? new FakeSurface();
  const runner = makeRunner(options.script);
  const coordinator = new DelegationCoordinator({
    store,
    surface: new ThreadSurface({ surface, store, logger: createLogger('silent'), run: runner.run }),
    channelId: CHANNEL,
    workerCap: options.workerCap ?? 3,
    mailboxWorktreePath: DAEMON_WT,
    ...(options.onDispatched !== undefined && { onDispatched: options.onDispatched }),
    logger: createLogger('silent'),
    run: runner.run,
    now: () => new Date(2026, 6, 8, 14, 4),
  });
  return { coordinator, store, surface, runner };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const WAIT_CMD = 'orca terminal wait --terminal term_w1 --for tui-idle --timeout-ms 60000 --json';

/** Walks the §5 order up to the dispatch: the tracker knows and awaited term_w1. */
const primeWorker = async (coordinator: DelegationCoordinator, threadTs = THREAD): Promise<void> => {
  await coordinator.observe(threadTs, 'orca terminal list --worktree id:wt-1 --json', TERMINAL_LIST_OUT);
  await coordinator.observe(threadTs, WAIT_CMD, envelope({ satisfied: true }));
};

describe('prepare — pass-through and the #4 invariants', () => {
  it('passes unrelated commands through untouched', async () => {
    const { coordinator, runner } = makeCoordinator();
    const command = 'orca worktree ps --json';
    await expect(coordinator.prepare(THREAD, command)).resolves.toEqual({
      action: 'proceed',
      command,
    });
    expect(runner.calls).toEqual([]);
  });

  it('refuses a create chained to anything else — one delegation step per call', async () => {
    const { coordinator } = makeCoordinator();
    const verdict = await coordinator.prepare(THREAD, `${CREATE_CMD} && echo done`);
    expect(verdict).toMatchObject({ action: 'deny' });
  });

  it('refuses a create-time --prompt — the brief travels with the injection', async () => {
    const { coordinator } = makeCoordinator();
    const verdict = await coordinator.prepare(
      THREAD,
      `${CREATE_CMD} --prompt "do the thing"`,
    );
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('--inject');
  });

  it.each(['--json', '--issue 84', '--agent claude', '--no-parent'])(
    'refuses a create missing %s',
    async (required) => {
      const { coordinator } = makeCoordinator();
      const gutted = CREATE_CMD.replace(` ${required}`, '');
      const verdict = await coordinator.prepare(THREAD, gutted);
      expect(verdict).toMatchObject({ action: 'deny' });
    },
  );

  it('refuses a worktree name that does not carry the issue number', async () => {
    const { coordinator } = makeCoordinator();
    const verdict = await coordinator.prepare(
      THREAD,
      CREATE_CMD.replace('webapp-84-csv-export', 'csv-export'),
    );
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('<repo>-<issue#>-<slug>');
  });

  it('refuses a dispatch that carries its own --from', async () => {
    const { coordinator } = makeCoordinator();
    const verdict = await coordinator.prepare(THREAD, `${DISPATCH_CMD} --from term_rogue`);
    expect(verdict).toMatchObject({ action: 'deny' });
  });

  it('refuses a dispatch without --inject — the worker needs the preamble', async () => {
    const { coordinator } = makeCoordinator();
    const verdict = await coordinator.prepare(
      THREAD,
      DISPATCH_CMD.replace(' --inject', ''),
    );
    expect(verdict).toMatchObject({ action: 'deny' });
  });

  it('refuses a dispatch to a handle the thread never listed — §5 order', async () => {
    const { coordinator } = makeCoordinator();
    const verdict = await coordinator.prepare(THREAD, DISPATCH_CMD);
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('terminal list');
  });

  it('refuses a dispatch to a listed handle never awaited to tui-idle', async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.observe(THREAD, 'orca terminal list --worktree id:wt-1 --json', TERMINAL_LIST_OUT);
    const verdict = await coordinator.prepare(THREAD, DISPATCH_CMD);
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('tui-idle');
  });

  it('a timed-out tui-idle wait does not clear the handle for injection', async () => {
    const { coordinator } = makeCoordinator();
    await coordinator.observe(THREAD, 'orca terminal list --worktree id:wt-1 --json', TERMINAL_LIST_OUT);
    // The wait failed: PostToolUseFailure reports empty output.
    await coordinator.observe(THREAD, WAIT_CMD, '');
    const verdict = await coordinator.prepare(THREAD, DISPATCH_CMD);
    expect(verdict).toMatchObject({ action: 'deny' });
  });

  it('refuses shell variables in a dispatch — the rewrite would quote them literal', async () => {
    const { coordinator } = makeCoordinator();
    await primeWorker(coordinator);
    const verdict = await coordinator.prepare(
      THREAD,
      'orca orchestration dispatch --task $TASK_ID --to term_w1 --inject --json',
    );
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('literal');
  });
});

describe('prepare — the thread mailbox (issue #9)', () => {
  it('lazily creates the mailbox, persists it, and rewrites the dispatch --from', async () => {
    const { coordinator, store, runner } = makeCoordinator();
    await primeWorker(coordinator);

    const verdict = await coordinator.prepare(THREAD, DISPATCH_CMD);

    expect(verdict).toEqual({ action: 'proceed', command: `${DISPATCH_CMD} --from term_mb1` });
    expect(store.getMailbox(THREAD)).toBe('term_mb1');
    expect(runner.calls).toContain(
      `terminal create --worktree path:${DAEMON_WT} --title slack-${THREAD} --json`,
    );
  });

  it('reuses a live persisted mailbox instead of creating another', async () => {
    const { coordinator, runner } = makeCoordinator({
      script: {
        'terminal list --json': envelope({ terminals: [{ handle: 'term_mb1' }] }),
      },
    });

    await primeWorker(coordinator);
    await coordinator.prepare(THREAD, DISPATCH_CMD);
    await coordinator.prepare(THREAD, DISPATCH_CMD);

    expect(runner.calls.filter((call) => call.startsWith('terminal create'))).toHaveLength(1);
  });

  it('recreates a mailbox whose handle no longer exists on the runtime', async () => {
    const store = new DelegationStore(':memory:');
    store.setMailbox(THREAD, CHANNEL, 'term_dead');
    const { coordinator } = makeCoordinator({ store });
    await primeWorker(coordinator);

    const verdict = await coordinator.prepare(THREAD, DISPATCH_CMD);

    expect(verdict).toEqual({ action: 'proceed', command: `${DISPATCH_CMD} --from term_mb1` });
    expect(store.getMailbox(THREAD)).toBe('term_mb1');
  });

  it('creates one mailbox per thread, each titled slack-<thread_ts>', async () => {
    const { coordinator, runner } = makeCoordinator();
    await primeWorker(coordinator);
    await primeWorker(coordinator, THREAD_B);

    await coordinator.prepare(THREAD, DISPATCH_CMD);
    await coordinator.prepare(THREAD_B, DISPATCH_CMD);

    const creates = runner.calls.filter((call) => call.startsWith('terminal create'));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain(`--title slack-${THREAD}`);
    expect(creates[1]).toContain(`--title slack-${THREAD_B}`);
  });

  it('Orca down → ⚠️ line in the thread, dispatch denied, daemon alive', async () => {
    const { coordinator, surface } = makeCoordinator({
      script: {
        'terminal list --json': new Error('connect ECONNREFUSED'),
        'terminal create': new Error('connect ECONNREFUSED'),
      },
    });
    await primeWorker(coordinator);

    const verdict = await coordinator.prepare(THREAD, DISPATCH_CMD);

    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('Orca runtime unavailable');
    expect(surface.posts).toEqual([
      {
        threadTs: THREAD,
        text: '⚠️ Orca runtime unavailable — the thread mailbox terminal could not be reached, so nothing was dispatched.',
      },
    ]);
  });
});

describe('the worker cap — waves (spec §5)', () => {
  /** An in-flight ledger row — a worker already out there holding a slot. */
  const seedInFlight = (store: DelegationStore, dispatchId: string): void => {
    store.recordDispatch({
      taskId: dispatchId.replace('ctx', 'task'),
      dispatchId,
      worktreeId: null,
      worktreeName: null,
      worktreePath: null,
      repo: null,
      issueNumber: null,
      agent: null,
      workerHandle: null,
      threadTs: THREAD,
      channelId: CHANNEL,
      cardTs: null,
      title: null,
    });
  };

  /** What production does when a worker finishes: the watcher closes the
   * ledger row, then tells the coordinator a slot freed. */
  const closeDelegation = (
    store: DelegationStore,
    coordinator: DelegationCoordinator,
    dispatchId: string,
  ): void => {
    store.closeDelegation(dispatchId, 'completed');
    coordinator.onDelegationClosed();
  };

  it('lets creates through silently under the cap', async () => {
    const { coordinator, surface } = makeCoordinator({ workerCap: 2 });
    await expect(coordinator.prepare(THREAD, CREATE_CMD)).resolves.toEqual({
      action: 'proceed',
      command: CREATE_CMD,
    });
    expect(surface.posts).toEqual([]);
  });

  it('holds an over-cap create with a ⏳ line until a delegation closes', async () => {
    const store = new DelegationStore(':memory:');
    seedInFlight(store, 'ctx_old');
    const { coordinator, surface } = makeCoordinator({ workerCap: 1, store });

    let resolved = false;
    const waiting = coordinator.prepare(THREAD_B, CREATE_CMD).then((verdict) => {
      resolved = true;
      return verdict;
    });
    await settle();
    expect(resolved).toBe(false);
    expect(surface.posts).toEqual([
      {
        threadTs: THREAD_B,
        text: '⏳ Worker cap reached (1 worker in flight) — this delegation waits for a free slot.',
      },
    ]);

    closeDelegation(store, coordinator, 'ctx_old');
    await expect(waiting).resolves.toEqual({ action: 'proceed', command: CREATE_CMD });
  });

  it('a reservation in the create→dispatch window holds a slot too', async () => {
    const { coordinator, surface } = makeCoordinator({ workerCap: 1 });
    await coordinator.prepare(THREAD, CREATE_CMD);

    let resolved = false;
    const waiting = coordinator.prepare(THREAD_B, CREATE_CMD).then((verdict) => {
      resolved = true;
      return verdict;
    });
    await settle();
    expect(resolved).toBe(false);
    expect(surface.posts[0]?.text).toContain('⏳ Worker cap reached');

    // The reserved create fails — its slot admits the waiting wave.
    await coordinator.observe(THREAD, CREATE_CMD, '');
    await expect(waiting).resolves.toEqual({ action: 'proceed', command: CREATE_CMD });
  });

  it('counts ledger rows already in flight at boot toward the cap', async () => {
    const store = new DelegationStore(':memory:');
    seedInFlight(store, 'ctx_old');
    const { coordinator, surface } = makeCoordinator({ workerCap: 1, store });

    let resolved = false;
    void coordinator.prepare(THREAD_B, CREATE_CMD).then(() => {
      resolved = true;
    });
    await settle();

    expect(resolved).toBe(false);
    expect(surface.posts[0]?.text).toContain('⏳ Worker cap reached');
  });

  it('after a cap decrease, over-cap workers must drain below the new cap first', async () => {
    const store = new DelegationStore(':memory:');
    for (const n of [1, 2, 3]) seedInFlight(store, `ctx_${n}`);
    // WORKER_CAP lowered to 1 while 3 workers are still in flight.
    const { coordinator } = makeCoordinator({ workerCap: 1, store });

    let resolved = false;
    const waiting = coordinator.prepare(THREAD_B, CREATE_CMD).then((verdict) => {
      resolved = true;
      return verdict;
    });
    await settle();

    closeDelegation(store, coordinator, 'ctx_1');
    closeDelegation(store, coordinator, 'ctx_2');
    await settle();
    expect(resolved).toBe(false);

    closeDelegation(store, coordinator, 'ctx_3');
    await expect(waiting).resolves.toEqual({ action: 'proceed', command: CREATE_CMD });
  });

  it('a dispatch after abandonThread is still counted — the ledger, not slot bookkeeping, is the cap', async () => {
    const { coordinator, store } = makeCoordinator({ workerCap: 1 });
    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);
    // The session died; its reservation went back to the pool…
    coordinator.abandonThread(THREAD);
    // …but a cold-resumed session still dispatches the worktree it created.
    await primeWorker(coordinator);
    const prepared = await coordinator.prepare(THREAD, DISPATCH_CMD);
    expect(prepared.action).toBe('proceed');
    await coordinator.observe(THREAD, DISPATCH_CMD, DISPATCH_OUT);
    expect(store.inFlightCount()).toBe(1);

    // The dispatched worker holds the only slot — the next create waits.
    let resolved = false;
    void coordinator.prepare(THREAD_B, CREATE_CMD).then(() => {
      resolved = true;
    });
    await settle();
    expect(resolved).toBe(false);
  });

  it('a turn abort while waiting denies cleanly and leaves the queue intact', async () => {
    const { coordinator } = makeCoordinator({ workerCap: 1 });
    await coordinator.prepare(THREAD, CREATE_CMD);

    const abort = new AbortController();
    const waiting = coordinator.prepare(THREAD_B, CREATE_CMD, abort.signal);
    await settle();
    abort.abort();

    const verdict = await waiting;
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('interrupted');
  });

  it('a failed create hands its slot back — the next wave is not starved', async () => {
    const { coordinator } = makeCoordinator({ workerCap: 1 });
    await coordinator.prepare(THREAD, CREATE_CMD);
    // The command ran and failed: the PostToolUseFailure hook reports empty output.
    await coordinator.observe(THREAD, CREATE_CMD, '');

    await expect(coordinator.prepare(THREAD_B, CREATE_CMD)).resolves.toEqual({
      action: 'proceed',
      command: CREATE_CMD,
    });
  });

  it('abandonThread releases slots of never-dispatched delegations', async () => {
    const { coordinator } = makeCoordinator({ workerCap: 1 });
    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);

    coordinator.abandonThread(THREAD);

    await expect(coordinator.prepare(THREAD_B, CREATE_CMD)).resolves.toEqual({
      action: 'proceed',
      command: CREATE_CMD,
    });
  });
});

describe('observe — the card, the 👀 and the ledger', () => {
  const runSequence = async (coordinator: DelegationCoordinator): Promise<void> => {
    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);
    await coordinator.observe(THREAD, 'orca terminal list --worktree id:wt-1 --json', TERMINAL_LIST_OUT);
    await coordinator.observe(THREAD, WAIT_CMD, envelope({ satisfied: true }));
    await coordinator.observe(
      THREAD,
      'orca orchestration task-create --spec "brief" --task-title "CSV export of send metrics" --display-name "webapp#84" --json',
      TASK_CREATE_OUT,
    );
    const prepared = await coordinator.prepare(THREAD, DISPATCH_CMD);
    expect(prepared.action).toBe('proceed');
    await coordinator.observe(THREAD, DISPATCH_CMD, DISPATCH_OUT);
  };

  it('posts the card at worktree-ready with the mock format, 👀 on the root', async () => {
    const { coordinator, surface } = makeCoordinator();

    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);

    expect(surface.posts).toEqual([
      {
        threadTs: THREAD,
        text:
          '⚙️ *webapp#84 — csv export*\n' +
          '`webapp-84-csv-export` · claude · issue ' +
          '<https://github.com/acme/webapp/issues/84|webapp#84>\n' +
          '• 14:04 — issue linked, worktree ready',
      },
    ]);
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'eyes' }]);
  });

  it('edits the card at hand-off — real title, task id milestone — and ledgers everything', async () => {
    const { coordinator, surface, store } = makeCoordinator();

    await runSequence(coordinator);

    expect(surface.updates).toEqual([
      {
        ts: 'card-ts-1',
        text:
          '⚙️ *webapp#84 — CSV export of send metrics*\n' +
          '`webapp-84-csv-export` · claude · issue ' +
          '<https://github.com/acme/webapp/issues/84|webapp#84>\n' +
          '• 14:04 — issue linked, worktree ready\n' +
          '• 14:04 — brief handed off (task `task_3f81`)',
      },
    ]);
    expect(store.listForThread(THREAD)).toEqual([
      {
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
        status: 'dispatched',
        dispatchedAt: expect.any(String) as string,
        lastBusAt: null,
        closedAt: null,
      },
    ]);
  });

  it('fires onDispatched once the row is ledgered — the gate watcher’s arming seam (#20)', async () => {
    const armed: string[] = [];
    const { coordinator, store } = makeCoordinator({
      onDispatched: (threadTs) => armed.push(threadTs),
    });

    await runSequence(coordinator);

    expect(armed).toEqual([THREAD]);
    // The row is already in flight when the callback fires.
    expect(store.listInFlightForThread(THREAD)).toHaveLength(1);
  });

  it('degrades to plain repo#n when the repo has no GitHub remote', async () => {
    const { coordinator, surface } = makeCoordinator();
    const sandboxCreate =
      'orca worktree create --repo id:repo-sandbox --name sandbox-21-bench ' +
      '--agent claude --issue 21 --no-parent --json';

    await coordinator.prepare(THREAD, sandboxCreate);
    await coordinator.observe(
      THREAD,
      sandboxCreate,
      envelope({
        worktree: {
          id: 'wt-2',
          repoId: 'repo-sandbox',
          path: '/home/op/sandbox',
          displayName: 'sandbox-21-bench',
          linkedIssue: 21,
        },
      }),
    );

    expect(surface.posts[0]?.text).toContain('issue sandbox#21');
    expect(surface.posts[0]?.text).not.toContain('<https://');
  });

  it('still identifies the repo from the worktree name when the registry is down', async () => {
    const { coordinator, surface } = makeCoordinator({
      script: { 'repo list --json': new Error('connect ECONNREFUSED') },
    });

    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);

    expect(surface.posts[0]?.text).toContain('⚙️ *webapp#84 — csv export*');
    expect(surface.posts[0]?.text).not.toContain('<https://');
  });

  it('catches the card up at dispatch when the ready-post failed', async () => {
    const { coordinator, surface, store } = makeCoordinator();
    surface.failPosts = true;
    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);
    expect(surface.posts).toEqual([]);

    surface.failPosts = false;
    await primeWorker(coordinator);
    await coordinator.prepare(THREAD, DISPATCH_CMD);
    await coordinator.observe(THREAD, DISPATCH_CMD, DISPATCH_OUT);

    expect(surface.posts.at(-1)?.text).toContain('brief handed off (task `task_3f81`)');
    expect(store.listForThread(THREAD)[0]?.cardTs).toBe('card-ts-1');
  });

  it('a failed 👀 reaction never blocks the card or the ledger', async () => {
    const { coordinator, surface } = makeCoordinator();
    surface.failReactions = true;

    await coordinator.prepare(THREAD, CREATE_CMD);
    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);

    expect(surface.posts).toHaveLength(1);
  });

  it('ledgers a dispatch it could not associate — nulls and a warning, no crash', async () => {
    const { coordinator, store } = makeCoordinator();

    await coordinator.observe(THREAD, DISPATCH_CMD, DISPATCH_OUT);

    const rows = store.listForThread(THREAD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: 'task_3f81',
      dispatchId: 'ctx_d1',
      workerHandle: 'term_w1',
      worktreeId: null,
      repo: null,
    });
  });

  it('shrugs off garbage output — the observer never throws', async () => {
    const { coordinator } = makeCoordinator();
    await expect(coordinator.observe(THREAD, DISPATCH_CMD, 'not json')).resolves.toBeUndefined();
    await expect(coordinator.observe(THREAD, 'orca terminal list --json', '{}')).resolves.toBeUndefined();
  });
});

describe('created-but-undispatched worktrees (issue #49)', () => {
  it('hasUndispatched covers exactly the create→dispatch window', async () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.hasUndispatched(THREAD)).toBe(false);

    await coordinator.observe(THREAD, CREATE_CMD, WT_CREATE_OUT);
    expect(coordinator.hasUndispatched(THREAD)).toBe(true);

    await primeWorker(coordinator);
    await coordinator.observe(THREAD, DISPATCH_CMD, DISPATCH_OUT);
    expect(coordinator.hasUndispatched(THREAD)).toBe(false);
  });

  it('a failed create leaves nothing behind — no phantom undispatched work', async () => {
    const { coordinator } = makeCoordinator();

    await coordinator.observe(THREAD, CREATE_CMD, envelope({ error: 'boom' }));

    expect(coordinator.hasUndispatched(THREAD)).toBe(false);
  });
});

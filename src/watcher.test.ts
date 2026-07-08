import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';
import { DelegationStore } from './delegations.ts';
import { GateWatcher, type WakeResult, type WatcherSurface } from './watcher.ts';
import type { CommandRunner } from './orca.ts';

const THREAD = '1751970000.000100';
const THREAD_B = '1751970001.000200';
const CHANNEL = 'C0ASJR3LAE6';
const MAILBOX = 'term_mb1';

/** The orca CLI `--json` envelope, as captured from the real runtime. */
const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

/** A `check` result carrying the given bus messages (shape from the live runtime). */
const checkOut = (...messages: object[]): string =>
  envelope({ messages, count: messages.length });

const busMessage = (over: Partial<Record<string, unknown>> = {}): object => ({
  id: 'msg_a8f37bac632f',
  from_handle: 'term_w1',
  to_handle: MAILBOX,
  subject: 'CSV export shipped',
  body:
    'Opened https://github.com/lemlist/forwardly/pull/87 with the export endpoint. ' +
    'Tests green. Nothing left.',
  type: 'worker_done',
  priority: 'normal',
  payload: JSON.stringify({ taskId: 'task_3f81', dispatchId: 'ctx_d1' }),
  ...over,
});

const REPO_LIST_OUT = envelope({
  repos: [
    {
      id: 'repo-fwd',
      displayName: 'forwardly',
      gitRemoteIdentity: { canonicalKey: 'github.com/lemlist/forwardly' },
    },
    { id: 'repo-scratch', displayName: 'scratch' },
  ],
});

class FakeSurface implements WatcherSurface {
  posts: Array<{ threadTs: string; text: string }> = [];
  updates: Array<{ ts: string; text: string }> = [];
  reactions: Array<{ ts: string; name: string }> = [];
  removed: Array<{ ts: string; name: string }> = [];
  private counter = 0;

  post(threadTs: string, text: string): Promise<string> {
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
    if (name === 'eyes') return Promise.reject(new Error('no_reaction'));
    this.removed.push({ ts, name });
    return Promise.resolve();
  }
}

/**
 * FIFO-scripted check child: each call consumes one response; when the
 * script runs dry the window parks (a never-settling promise), like a real
 * `check --wait` blocking on an empty mailbox.
 */
const makeCheckRunner = (responses: Array<string | Error>) => {
  const calls: string[] = [];
  const run: CommandRunner = (_command, args) => {
    calls.push(args.join(' '));
    const next = responses.shift();
    if (next === undefined) return new Promise(() => undefined);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve({ stdout: next });
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
    worktreeName: 'forwardly-84-csv-export',
    worktreePath: '/home/dev/orca/workspaces/forwardly/forwardly-84-csv-export',
    repo: 'forwardly',
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

interface HarnessOptions {
  checks?: Array<string | Error>;
  wakeResult?: WakeResult;
  registryDown?: boolean;
}

const makeWatcher = (options: HarnessOptions = {}) => {
  // Dispatch at 14:04, worker_done handled at 14:31 — the mock's 27 min.
  const store = new DelegationStore(':memory:', () => '2026-07-08T14:04:00.000Z');
  store.setMailbox(THREAD, CHANNEL, MAILBOX);
  const surface = new FakeSurface();
  const checkRunner = makeCheckRunner(options.checks ?? []);
  const wakes: Array<{ threadTs: string; channelId: string; text: string }> = [];
  let closed = 0;
  const watcher = new GateWatcher({
    store,
    surface,
    channelId: CHANNEL,
    wake: (threadTs, channelId, text) => {
      wakes.push({ threadTs, channelId, text });
      return options.wakeResult ?? 'turn';
    },
    onDelegationClosed: () => {
      closed += 1;
    },
    logger: createLogger('silent'),
    windowMs: 900_000,
    retryDelayMs: 0,
    runCheck: checkRunner.run,
    run: options.registryDown === true
      ? () => Promise.reject(new Error('orca down'))
      : () => Promise.resolve({ stdout: REPO_LIST_OUT }),
    now: () => new Date('2026-07-08T14:31:00.000Z'),
  });
  return { watcher, store, surface, checkRunner, wakes, slotsFreed: () => closed };
};

const stopped = (watcher: GateWatcher, threadTs = THREAD) =>
  vi.waitFor(() => {
    expect(watcher.isArmed(threadTs)).toBe(false);
  });

describe('worker_done — the happy path', () => {
  it('closes the row, flips the card to ✅ with durable links, swaps 👀 for ✅, wakes the session', async () => {
    const { watcher, store, surface, checkRunner, wakes, slotsFreed } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls[0]).toBe(
      `orchestration check --wait --terminal ${MAILBOX} ` +
        '--types worker_done,escalation,decision_gate --timeout-ms 900000 --json',
    );

    const row = store.getByDispatchId('ctx_d1');
    expect(row?.status).toBe('completed');
    expect(row?.closedAt).not.toBeNull();
    expect(slotsFreed()).toBe(1);

    // The card became the durable home for links (mock scenario A end).
    expect(surface.updates).toHaveLength(1);
    const card = surface.updates[0];
    expect(card?.ts).toBe('card-ts-1');
    expect(card?.text).toContain('✅ *forwardly#84 — CSV export of send metrics — delivered in 27 min*');
    expect(card?.text).toContain('• PR: <https://github.com/lemlist/forwardly/pull/87|forwardly#87>');
    expect(card?.text).toContain('• issue: <https://github.com/lemlist/forwardly/issues/84|forwardly#84>');
    expect(card?.text).toContain('• worktree: `/home/dev/orca/workspaces/forwardly/forwardly-84-csv-export`');

    // Root reaction 👀 → ✅ (the add, plus best-effort removal of the rest).
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'white_check_mark' }]);

    // The wake rides the human-message pipe; the session writes the summary,
    // so the daemon posts nothing itself.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ threadTs: THREAD, channelId: CHANNEL });
    expect(wakes[0]?.text).toContain('worker_done');
    expect(wakes[0]?.text).toContain('forwardly#84');
    expect(wakes[0]?.text).toContain('https://github.com/lemlist/forwardly/pull/87');
    expect(wakes[0]?.text).toContain('✅ Delivered');
    expect(surface.posts).toEqual([]);
  });

  it('matches on the task id when the payload lost the dispatch id', async () => {
    const { watcher, store } = makeWatcher({
      checks: [checkOut(busMessage({ payload: JSON.stringify({ taskId: 'task_3f81' }) }))],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
  });

  it('posts a fresh final card when no ⚙️ card ever landed', async () => {
    const { watcher, store, surface } = makeWatcher({ checks: [checkOut(busMessage())] });
    seedDispatch(store, { cardTs: null });

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(surface.updates).toEqual([]);
    expect(surface.posts.some((post) => post.text.startsWith('✅ *forwardly#84'))).toBe(true);
  });

  it('degrades the issue link to plain repo#n when the registry is unreachable', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage())],
      registryDown: true,
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(surface.updates[0]?.text).toContain('• issue: forwardly#84');
    expect(surface.updates[0]?.text).not.toContain('issues/84');
  });

  it('posts the fallback summary itself when no session takes the wake', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage())],
      wakeResult: 'skipped',
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(surface.posts).toEqual([
      { threadTs: THREAD, text: '✅ Delivered — CSV export shipped. Details in the card ⤴' },
    ]);
  });

  it('keeps 👀 while a sibling delegation is still in flight, and keeps watching', async () => {
    const { watcher, store, surface, checkRunner } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_9999' });

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    });

    expect(surface.reactions).toEqual([]);
    // The second window parked on the still-armed watcher.
    expect(watcher.isArmed(THREAD)).toBe(true);
    expect(checkRunner.calls).toHaveLength(2);
  });

  it('ignores a duplicated worker_done — one close, one freed slot, one wake', async () => {
    const { watcher, store, wakes, slotsFreed } = makeWatcher({
      checks: [checkOut(busMessage(), busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(slotsFreed()).toBe(1);
    expect(wakes).toHaveLength(1);
  });

  it('surfaces an unmatched completion raw — never lost, nothing closed', async () => {
    const { watcher, store, surface, slotsFreed } = makeWatcher({
      checks: [
        checkOut(
          busMessage({ payload: JSON.stringify({ taskId: 'task_unknown', dispatchId: 'ctx_unknown' }) }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });

    expect(surface.posts[0]?.text).toContain('matches no delegation');
    expect(surface.posts[0]?.text).toContain('CSV export shipped');
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(slotsFreed()).toBe(0);
  });
});

describe('worker_done — failure', () => {
  it('closes as failed: ❌ card with the reason, ❌ root reaction, failure wake', async () => {
    const { watcher, store, surface, wakes } = makeWatcher({
      checks: [
        checkOut(
          busMessage({
            subject: 'Failed: e2e tests break on main',
            body: 'The suite fails before my changes. Stopping here.',
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('failed');
    const card = surface.updates[0]?.text ?? '';
    expect(card).toContain('❌ *forwardly#84 — CSV export of send metrics — failed after 27 min*');
    expect(card).toContain('• reason: Failed: e2e tests break on main');
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'x' }]);
    expect(wakes[0]?.text).toContain('FAILED');
    expect(wakes[0]?.text).toContain('❌ Failed');
  });

  it('surfaces a failure as ❌ even while siblings are still in flight', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage({ subject: 'Failed: broke' }))],
    });
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_9999' });

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.reactions).toEqual([{ ts: THREAD, name: 'x' }]);
    });
  });
});

describe('decision_gate / escalation — the crude pre-#21 surface', () => {
  it.each([
    ['decision_gate', '❓', 'question'],
    ['escalation', '🚨', 'rotating_light'],
  ] as const)('%s posts the verbatim payload, sets %s, wakes with relay instructions', async (kind, emoji, reaction) => {
    const { watcher, store, surface, wakes, slotsFreed } = makeWatcher({
      checks: [
        checkOut(
          busMessage({
            type: kind,
            subject: 'Which lint config is authoritative?',
            body: 'Two configs coexist. 1. root 2. app/',
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });

    const post = surface.posts[0]?.text ?? '';
    expect(post).toContain(emoji);
    expect(post).toContain('`forwardly-84-csv-export`');
    expect(post).toContain('> Which lint config is authoritative?');
    expect(post).toContain('> Two configs coexist. 1. root 2. app/');
    expect(post).toContain('orca orchestration reply --id msg_a8f37bac632f');
    expect(surface.reactions).toEqual([{ ts: THREAD, name: reaction }]);

    // Best-effort wake with the relay instructions; nothing closes.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toContain('orca orchestration reply --id msg_a8f37bac632f');
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(slotsFreed()).toBe(0);
    expect(watcher.isArmed(THREAD)).toBe(true);
  });
});

describe('rolling windows', () => {
  it('a timeout ({count:0}) is a checkpoint — the window respawns silently', async () => {
    const { watcher, store, surface, checkRunner } = makeWatcher({
      checks: [checkOut(), checkOut(), checkOut(busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls).toHaveLength(3);
    expect(surface.posts).toEqual([]);
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
  });

  it('a failed check retries after the pause instead of dying', async () => {
    const { watcher, store, checkRunner, surface } = makeWatcher({
      checks: [new Error('orca runtime restarting'), checkOut(busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls).toHaveLength(2);
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(surface.posts).toEqual([]);
  });

  it('an unreadable envelope counts as a failed window, not a crash', async () => {
    const { watcher, store } = makeWatcher({
      checks: ['not json at all', checkOut(busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
  });
});

describe('arming and stopping', () => {
  it('never spawns a check for a thread with no in-flight work', async () => {
    const { watcher, checkRunner } = makeWatcher();

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls).toEqual([]);
  });

  it('arm is idempotent — one loop per thread', async () => {
    const { watcher, store, checkRunner } = makeWatcher();
    seedDispatch(store);

    watcher.arm(THREAD);
    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(checkRunner.calls).toHaveLength(1);
    });
    expect(watcher.isArmed(THREAD)).toBe(true);
  });

  it('stops when the mailbox is missing instead of spinning', async () => {
    const store = new DelegationStore(':memory:');
    const checkRunner = makeCheckRunner([]);
    const watcher = new GateWatcher({
      store,
      surface: new FakeSurface(),
      channelId: CHANNEL,
      wake: () => 'turn',
      onDelegationClosed: () => undefined,
      logger: createLogger('silent'),
      retryDelayMs: 0,
      runCheck: checkRunner.run,
      run: () => Promise.resolve({ stdout: REPO_LIST_OUT }),
    });
    store.recordDispatch({
      taskId: 'task_x',
      dispatchId: 'ctx_x',
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

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls).toEqual([]);
  });
});

describe('boot re-arm', () => {
  it('re-arms one watcher per thread the ledger shows in flight', async () => {
    const { watcher, store, checkRunner } = makeWatcher();
    store.setMailbox(THREAD_B, CHANNEL, 'term_mb2');
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_b1', taskId: 'task_b', threadTs: THREAD_B });
    // A closed delegation alone must not re-arm its thread.
    store.closeDelegation('ctx_b1', 'completed');

    expect(watcher.rearmFromStore()).toBe(1);
    await vi.waitFor(() => {
      expect(checkRunner.calls).toHaveLength(1);
    });
    expect(checkRunner.calls[0]).toContain(MAILBOX);
    expect(watcher.isArmed(THREAD)).toBe(true);
    expect(watcher.isArmed(THREAD_B)).toBe(false);
  });

  it('a completion sent while the daemon was down lands after the re-arm', async () => {
    const { watcher, store } = makeWatcher({ checks: [checkOut(busMessage())] });
    seedDispatch(store);

    watcher.rearmFromStore();
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
  });
});

import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { DelegationStore } from './delegations.ts';
import { Watchdog, truncateTail } from './watchdog.ts';
import type { WatcherSurface } from './watcher.ts';
import type { CommandRunner } from './orca.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0ASJR3LAE6';
const WORKER = 'term_w1';
const WORKTREE_ID = 'repo-scratch::/home/dev/orca/workspaces/scratch/scratch-21-bench';

/** The sweep runs at 16:20; the mock's stall has been silent since 15:55. */
const NOW = new Date('2026-07-08T16:20:00.000Z');
const STALE_25_MIN = NOW.getTime() - 25 * 60_000;
const FRESH_1_MIN = NOW.getTime() - 60_000;
const STALL_AFTER_MS = 10 * 60_000;

const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

const psOut = (...worktrees: object[]): string => envelope({ worktrees });

const worktreeEntry = (over: Partial<Record<string, unknown>> = {}): object => ({
  worktreeId: WORKTREE_ID,
  lastOutputAt: STALE_25_MIN,
  agents: [],
  ...over,
});

const READ_OUT = envelope({
  terminal: { handle: WORKER, tail: ['? Overwrite existing bench.json? (y/N)'] },
});

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

interface HarnessOptions {
  /** Scripted `worktree ps` responses, one per sweep; the last one repeats. */
  ps?: Array<string | Error>;
  read?: string | Error;
  repoList?: string | Error;
  stallAfterMs?: number;
}

const makeWatchdog = (options: HarnessOptions = {}) => {
  const store = new DelegationStore(':memory:', () => '2026-07-08T14:00:00.000Z');
  const surface = new FakeSurface();
  const calls: string[][] = [];
  const psResponses = [...(options.ps ?? [psOut(worktreeEntry())])];
  const run: CommandRunner = (_command, args) => {
    calls.push(args);
    const respond = (response: string | Error): Promise<{ stdout: string }> =>
      response instanceof Error ? Promise.reject(response) : Promise.resolve({ stdout: response });
    if (args[0] === 'worktree' && args[1] === 'ps') {
      const next = psResponses.length > 1 ? psResponses.shift() : psResponses[0];
      return respond(next ?? new Error('unscripted ps'));
    }
    if (args[0] === 'terminal' && args[1] === 'read') {
      return respond(options.read ?? READ_OUT);
    }
    if (args[0] === 'repo' && args[1] === 'list') {
      return respond(options.repoList ?? REPO_LIST_OUT);
    }
    return Promise.reject(new Error(`unscripted orca call: ${args.join(' ')}`));
  };
  const watchdog = new Watchdog({
    store,
    surface,
    stallAfterMs: options.stallAfterMs ?? STALL_AFTER_MS,
    logger: createLogger('silent'),
    run,
    now: () => NOW,
  });
  return { watchdog, store, surface, calls };
};

const seedDispatch = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordDispatch']>[0]> = {},
): void => {
  store.recordDispatch({
    taskId: 'task_bench',
    dispatchId: 'ctx_w1',
    worktreeId: WORKTREE_ID,
    worktreeName: 'scratch-21-bench',
    worktreePath: '/home/dev/orca/workspaces/scratch/scratch-21-bench',
    repo: 'scratch',
    issueNumber: 21,
    agent: 'claude',
    workerHandle: WORKER,
    threadTs: THREAD,
    channelId: CHANNEL,
    cardTs: 'card-ts-1',
    title: 'bench harness',
    ...over,
  });
};

describe('the sweep — only in-flight worktrees get inspected', () => {
  it('does nothing — not even an orca call — without in-flight delegations', async () => {
    const { watchdog, calls } = makeWatchdog();

    expect(await watchdog.sweep()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a closed delegation is out of the inspection set', async () => {
    const { watchdog, store, calls } = makeWatchdog();
    seedDispatch(store);
    store.closeDelegation('ctx_w1', 'completed');

    expect(await watchdog.sweep()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('a healthy worker with recent output never alerts', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [psOut(worktreeEntry({ lastOutputAt: FRESH_1_MIN }))],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });

  it('a fresh agent state clock counts as liveness even without terminal output', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [
        psOut(
          worktreeEntry({
            lastOutputAt: null,
            agents: [{ state: 'working', stateStartedAt: STALE_25_MIN, updatedAt: FRESH_1_MIN }],
          }),
        ),
      ],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });

  it('an unreachable Orca runtime is a skipped sweep, never a crash or an alert', async () => {
    const { watchdog, store, surface } = makeWatchdog({ ps: [new Error('orca down')] });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });

  it('a worktree missing from `worktree ps` is skipped, not alerted', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [psOut(worktreeEntry({ worktreeId: 'someone::else' }))],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });
});

describe('a stall → the ⚠️ alert (mock scenario "Stalled worker")', () => {
  it('posts the mock message verbatim: who, silence span, last output, reply instruction', async () => {
    const { watchdog, store, surface, calls } = makeWatchdog();
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);

    expect(surface.posts).toEqual([
      {
        threadTs: THREAD,
        text:
          '⚠️ *`scratch-21-bench`* (<https://github.com/nvergez/scratch/issues/21|scratch#21>) seems stalled —\n' +
          'no sign for 25 min, without having asked a question. Last output:\n' +
          '\n' +
          '> `? Overwrite existing bench.json? (y/N)`\n' +
          '\n' +
          "Tell me what to answer, I'll relay it to its terminal.",
      },
    ]);
    // The tail came from the worker terminal, bounded.
    expect(calls).toContainEqual([
      'terminal',
      'read',
      '--terminal',
      WORKER,
      '--limit',
      '40',
      '--json',
    ]);
    // Root reaction 👀 → 🚨 (the mock's coarse state).
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
    // The registry row anchors the reply route and the fingerprint.
    const stall = store.getStall('ctx_w1');
    expect(stall).toMatchObject({
      threadTs: THREAD,
      workerHandle: WORKER,
      worktreeName: 'scratch-21-bench',
      lastOutput: '? Overwrite existing bench.json? (y/N)',
      fingerprint: String(STALE_25_MIN),
      relayTs: 'msg-ts-1',
      status: 'pending',
    });
  });

  it('alerts exactly once per stall state — the same fingerprint never re-posts', async () => {
    const { watchdog, store, surface } = makeWatchdog();
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(await watchdog.sweep()).toBe(0);
    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toHaveLength(1);
  });

  it('the answered alert stays quiet too — until the worker stalls ANEW', async () => {
    const later = STALE_25_MIN + 10 * 60_000; // moved, then went silent again
    const { watchdog, store, surface } = makeWatchdog({
      ps: [psOut(worktreeEntry()), psOut(worktreeEntry({ lastOutputAt: later }))],
    });
    seedDispatch(store);

    await watchdog.sweep();
    store.answerStall('ctx_w1');
    expect(await watchdog.sweep()).toBe(1);

    expect(surface.posts).toHaveLength(2);
    expect(store.getStall('ctx_w1')).toMatchObject({
      fingerprint: String(later),
      status: 'pending',
      relayTs: 'msg-ts-2',
    });
  });

  it('never alerts on a worker whose pending gate this thread already relayed — it DID ask', async () => {
    const { watchdog, store, surface } = makeWatchdog();
    seedDispatch(store);
    store.recordGate({
      msgId: 'msg_gate',
      threadTs: THREAD,
      taskId: 'task_bench',
      dispatchId: 'ctx_w1',
      workerHandle: WORKER,
      worktreeName: 'scratch-21-bench',
      kind: 'decision_gate',
      question: 'Overwrite bench.json?',
      options: [],
      relayTs: null,
    });

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);

    // The gate answered, the worker still silent: now the watchdog's turn.
    store.answerGate('msg_gate');
    expect(await watchdog.sweep()).toBe(1);
  });

  it('with no runtime signal at all, the dispatch time is the floor — one alert, not silence', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [psOut(worktreeEntry({ lastOutputAt: null, agents: [] }))],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    // 14:00 dispatch → 16:20 sweep.
    expect(surface.posts[0]?.text).toContain('no sign for 2 h 20 min');
    expect(await watchdog.sweep()).toBe(0);
  });

  it('an unreadable worker terminal still alerts, owning up to the missing output', async () => {
    const { watchdog, store, surface } = makeWatchdog({ read: new Error('terminal gone') });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[0]?.text).toContain('> (no recent output could be read)');
  });

  it('a failed Slack post still writes the registry row, and the next sweep retries the post', async () => {
    const { watchdog, store, surface } = makeWatchdog();
    surface.failPosts = true;
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(store.getStall('ctx_w1')).toMatchObject({ status: 'pending', relayTs: null });

    // Nobody saw the alert and nobody answered it — Slack recovering means
    // the same stall state posts after all, exactly once.
    surface.failPosts = false;
    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts).toHaveLength(1);
    expect(store.getStall('ctx_w1')).toMatchObject({ status: 'pending', relayTs: 'msg-ts-1' });
    expect(await watchdog.sweep()).toBe(0);
  });

  it('an unseen alert answered through the turn context stops retrying', async () => {
    const { watchdog, store, surface } = makeWatchdog();
    surface.failPosts = true;
    seedDispatch(store);

    await watchdog.sweep();
    store.answerStall('ctx_w1');

    surface.failPosts = false;
    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });

  it('a worker_done racing the alert leaves no pending row and never re-stamps the root', async () => {
    const { watchdog, store, surface } = makeWatchdog();
    seedDispatch(store);
    // The delegation closes while the ⚠️ post is in flight.
    const post = surface.post.bind(surface);
    surface.post = (threadTs, text) => {
      store.closeDelegation('ctx_w1', 'completed');
      return post(threadTs, text);
    };

    await watchdog.sweep();

    expect(store.getStall('ctx_w1')).toBeUndefined();
    expect(surface.reactions).toEqual([]);
  });

  it('degrades the issue link to plain repo#n on a folder repo, and survives a down registry', async () => {
    const folderRepo = makeWatchdog({
      repoList: envelope({ repos: [{ id: 'repo-scratch', displayName: 'scratch' }] }),
    });
    seedDispatch(folderRepo.store);
    await folderRepo.watchdog.sweep();
    expect(folderRepo.surface.posts[0]?.text).toContain('*`scratch-21-bench`* (scratch#21) seems stalled');

    const registryDown = makeWatchdog({ repoList: new Error('orca down') });
    seedDispatch(registryDown.store);
    await registryDown.watchdog.sweep();
    expect(registryDown.surface.posts[0]?.text).toContain('(scratch#21) seems stalled');
  });
});

describe('truncateTail — what the alert quotes', () => {
  it('strips ANSI, drops trailing blank lines, keeps the tail end', () => {
    expect(
      truncateTail(['\u001b[32m? Overwrite existing bench.json? (y/N)\u001b[0m', '', '  ']),
    ).toBe('? Overwrite existing bench.json? (y/N)');
  });

  it('keeps only the last lines, owning up to the cut with a leading …', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const truncated = truncateTail(lines);
    expect(truncated.startsWith('…\nline 5')).toBe(true);
    expect(truncated.endsWith('line 12')).toBe(true);
    expect(truncated).not.toContain('line 4');
  });

  it('caps the character count from the front', () => {
    const truncated = truncateTail(['x'.repeat(500), 'y'.repeat(500)]);
    expect(truncated.startsWith('…\n')).toBe(true);
    expect(truncated).toContain('y'.repeat(500));
    expect(truncated).not.toContain('x'.repeat(500));
  });
});

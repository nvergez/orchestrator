import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { DelegationStore } from './delegations.ts';
import { Watchdog, truncateTail } from './watchdog.ts';
import type { WatcherSurface } from './watcher.ts';
import type { CommandRunner } from './orca.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0EXAMPLE123';
const WORKER = 'term_w1';
const WORKTREE_ID = 'repo-sandbox::/home/op/orca/workspaces/sandbox/sandbox-21-bench';

/** The sweep runs at 16:20; the mock's stall has been silent since 15:55. */
const NOW = new Date('2026-07-08T16:20:00.000Z');
const STALE_25_MIN = NOW.getTime() - 25 * 60_000;
const FRESH_1_MIN = NOW.getTime() - 60_000;
const STALL_AFTER_MS = 10 * 60_000;
const MAX_INFLIGHT_MS = 30 * 60_000;
/** Dispatch happens at 14:00 — 2 h 20 min before the sweep, so a bus that
 * never spoke is far past the in-flight threshold (issue #48). */
const DISPATCHED_AT = '2026-07-08T14:00:00.000Z';
/** A bus stamp the in-flight check reads as recent (5 min before NOW). */
const BUS_FRESH_ISO = '2026-07-08T16:15:00.000Z';

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
      id: 'repo-sandbox',
      displayName: 'sandbox',
      gitRemoteIdentity: { canonicalKey: 'github.com/acme/sandbox' },
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
  maxInflightMs?: number;
}

const makeWatchdog = (options: HarnessOptions = {}) => {
  // Both clocks are settable mid-test: the store's stamps recordBusActivity
  // and answerStall at chosen instants; the watchdog's moves the sweep.
  let storeNow = DISPATCHED_AT;
  let sweepNow = NOW;
  const store = new DelegationStore(':memory:', () => storeNow);
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
    maxInflightMs: options.maxInflightMs ?? MAX_INFLIGHT_MS,
    logger: createLogger('silent'),
    run,
    now: () => sweepNow,
  });
  return {
    watchdog,
    store,
    surface,
    calls,
    setStoreNow: (iso: string) => {
      storeNow = iso;
    },
    setSweepNow: (date: Date) => {
      sweepNow = date;
    },
  };
};

const seedDispatch = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordDispatch']>[0]> = {},
): void => {
  store.recordDispatch({
    taskId: 'task_bench',
    dispatchId: 'ctx_w1',
    worktreeId: WORKTREE_ID,
    worktreeName: 'sandbox-21-bench',
    worktreePath: '/home/op/orca/workspaces/sandbox/sandbox-21-bench',
    repo: 'sandbox',
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

  it('a healthy worker — recent output, live bus — never alerts', async () => {
    const { watchdog, store, surface, setStoreNow } = makeWatchdog({
      ps: [psOut(worktreeEntry({ lastOutputAt: FRESH_1_MIN }))],
    });
    seedDispatch(store);
    setStoreNow(BUS_FRESH_ISO);
    store.recordBusActivity('ctx_w1');

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });

  it('a fresh agent state clock counts as liveness even without terminal output', async () => {
    const { watchdog, store, surface, setStoreNow } = makeWatchdog({
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
    setStoreNow(BUS_FRESH_ISO);
    store.recordBusActivity('ctx_w1');

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
          '⚠️ *`sandbox-21-bench`* (<https://github.com/acme/sandbox/issues/21|sandbox#21>) seems stalled —\n' +
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
      worktreeName: 'sandbox-21-bench',
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
      worktreeName: 'sandbox-21-bench',
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
    const { watchdog, store, surface, setStoreNow } = makeWatchdog();
    surface.failPosts = true;
    seedDispatch(store);
    // The worker's bus stays live throughout — only the silence signal is
    // in play here; a mute bus would raise the #48 alert on its own.
    setStoreNow(BUS_FRESH_ISO);
    store.recordBusActivity('ctx_w1');

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
      repoList: envelope({ repos: [{ id: 'repo-sandbox', displayName: 'sandbox' }] }),
    });
    seedDispatch(folderRepo.store);
    await folderRepo.watchdog.sweep();
    expect(folderRepo.surface.posts[0]?.text).toContain('*`sandbox-21-bench`* (sandbox#21) seems stalled');

    const registryDown = makeWatchdog({ repoList: new Error('orca down') });
    seedDispatch(registryDown.store);
    await registryDown.watchdog.sweep();
    expect(registryDown.surface.posts[0]?.text).toContain('(sandbox#21) seems stalled');
  });
});

describe('a live-but-mute worker → the in-flight ⚠️ alert (issue #48)', () => {
  const DISPATCH_MS = Date.parse(DISPATCHED_AT);
  const ROOT_CAUSE = 'Exit code 1 / The Orca runtime closed the connection before responding.';

  /** The incident's shape: a TUI spinner keeps every worktree clock fresh —
   * the silence signal can never fire — while the bus hears nothing. */
  const spinnerEntry = (over: Partial<Record<string, unknown>> = {}): object =>
    worktreeEntry({
      lastOutputAt: FRESH_1_MIN,
      agents: [
        {
          state: 'working',
          stateStartedAt: STALE_25_MIN,
          updatedAt: FRESH_1_MIN,
          lastAssistantMessage: ROOT_CAUSE,
        },
      ],
      ...over,
    });

  it('posts the ⚠️ with agent state and last assistant message, and registers the row', async () => {
    const { watchdog, store, surface } = makeWatchdog({ ps: [psOut(spinnerEntry())] });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);

    expect(surface.posts).toEqual([
      {
        threadTs: THREAD,
        text:
          '⚠️ *`sandbox-21-bench`* (<https://github.com/acme/sandbox/issues/21|sandbox#21>) needs attention —\n' +
          'in flight for 2 h 20 min without a word on the bus (agent state: `working`). Last assistant message:\n' +
          '\n' +
          `> \`${ROOT_CAUSE}\`\n` +
          '\n' +
          "Tell me what to answer, I'll relay it to its terminal.",
      },
    ]);
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
    expect(store.getStall('ctx_w1')).toMatchObject({
      threadTs: THREAD,
      workerHandle: WORKER,
      worktreeName: 'sandbox-21-bench',
      lastOutput: ROOT_CAUSE,
      fingerprint: `inflight:${DISPATCH_MS}`,
      relayTs: 'msg-ts-1',
      status: 'pending',
    });
  });

  it('alerts exactly once per mute state — no repeat every sweep while the fingerprint holds', async () => {
    const { watchdog, store, surface } = makeWatchdog({ ps: [psOut(spinnerEntry())] });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(await watchdog.sweep()).toBe(0);
    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toHaveLength(1);
  });

  it('a recent bus message resets the clock — no alert while the worker keeps speaking', async () => {
    const { watchdog, store, surface, setStoreNow } = makeWatchdog({
      ps: [psOut(spinnerEntry())],
    });
    seedDispatch(store);
    setStoreNow(BUS_FRESH_ISO);
    store.recordBusActivity('ctx_w1');

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);
  });

  it('a bus message after the alert clears it; a NEW mute window alerts anew', async () => {
    const at1649 = Date.parse('2026-07-08T16:49:00.000Z');
    const { watchdog, store, surface, setStoreNow, setSweepNow } = makeWatchdog({
      ps: [psOut(spinnerEntry()), psOut(spinnerEntry({ lastOutputAt: at1649 }))],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);

    // The worker's heartbeat lands: the watcher stamps the bus clock and
    // settles the pending alert (issue #48's reset-or-clear contract).
    setStoreNow(BUS_FRESH_ISO);
    store.recordBusActivity('ctx_w1');
    store.answerStall('ctx_w1');
    expect(await watchdog.sweep()).toBe(0);

    // …then the bus goes mute again, past the threshold: a new state.
    setSweepNow(new Date('2026-07-08T16:50:00.000Z'));
    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts).toHaveLength(2);
    expect(store.getStall('ctx_w1')).toMatchObject({
      fingerprint: `inflight:${Date.parse(BUS_FRESH_ISO)}`,
      status: 'pending',
    });
  });

  it('stays quiet while a silence alert is already up — one live ⚠️ per delegation', async () => {
    const { watchdog, store, surface } = makeWatchdog();
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[0]?.text).toContain('seems stalled');

    expect(await watchdog.sweep()).toBe(0);
    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toHaveLength(1);
  });

  it('an answered silence alert whose nudge went long unheeded gives way to the mute-bus ⚠️', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [psOut(worktreeEntry()), psOut(spinnerEntry())],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    // Answered at 14:00 — the nudge is 2 h 20 min old and the bus still mute.
    store.answerStall('ctx_w1');

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[1]?.text).toContain('needs attention');
  });

  it('a fully dead worker never ping-pongs: one follow-up ⚠️ per answer, not an alternation', async () => {
    // Worktree stale AND bus mute throughout; the silence alert is answered
    // through the turn context, so no clock ever moves. The mute-bus ⚠️
    // follows once — and the silence signal must NOT re-post its already-
    // answered state just because the registry row now holds the other
    // signal's fingerprint.
    const { watchdog, store, surface } = makeWatchdog();
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[0]?.text).toContain('seems stalled');
    store.answerStall('ctx_w1');

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[1]?.text).toContain('needs attention');

    expect(await watchdog.sweep()).toBe(0);
    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toHaveLength(2);
  });

  it('a just-nudged worker gets a fresh window before the mute-bus signal fires', async () => {
    const { watchdog, store, surface, setStoreNow } = makeWatchdog({
      ps: [psOut(worktreeEntry()), psOut(spinnerEntry())],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    setStoreNow(BUS_FRESH_ISO);
    store.answerStall('ctx_w1');

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toHaveLength(1);
  });

  it('never alerts on a worker whose pending gate this thread already relayed — it DID ask', async () => {
    const { watchdog, store, surface } = makeWatchdog({ ps: [psOut(spinnerEntry())] });
    seedDispatch(store);
    store.recordGate({
      msgId: 'msg_gate',
      threadTs: THREAD,
      taskId: 'task_bench',
      dispatchId: 'ctx_w1',
      workerHandle: WORKER,
      worktreeName: 'sandbox-21-bench',
      kind: 'decision_gate',
      question: 'Overwrite bench.json?',
      options: [],
      relayTs: null,
    });

    expect(await watchdog.sweep()).toBe(0);
    expect(surface.posts).toEqual([]);

    store.answerGate('msg_gate');
    expect(await watchdog.sweep()).toBe(1);
  });

  it('quotes the NEWEST agent pane — the one whose clocks moved last', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [
        psOut(
          spinnerEntry({
            agents: [
              {
                state: 'done',
                stateStartedAt: STALE_25_MIN,
                updatedAt: STALE_25_MIN,
                lastAssistantMessage: 'old news from a finished sibling',
              },
              {
                state: 'working',
                stateStartedAt: STALE_25_MIN,
                updatedAt: FRESH_1_MIN,
                lastAssistantMessage: ROOT_CAUSE,
              },
            ],
          }),
        ),
      ],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[0]?.text).toContain('agent state: `working`');
    expect(surface.posts[0]?.text).toContain(ROOT_CAUSE);
    expect(surface.posts[0]?.text).not.toContain('old news');
  });

  it('degrades without agent info: unknown state, no readable message — still alerts', async () => {
    const { watchdog, store, surface } = makeWatchdog({
      ps: [psOut(spinnerEntry({ agents: [] }))],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[0]?.text).toContain('(agent state: `unknown`)');
    expect(surface.posts[0]?.text).toContain('> (no assistant message could be read)');
    expect(store.getStall('ctx_w1')?.lastOutput).toBe('');
  });

  it('quotes a long assistant message from its tail, owning up to the cut', async () => {
    const longMessage = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const { watchdog, store, surface } = makeWatchdog({
      ps: [
        psOut(
          spinnerEntry({
            agents: [
              {
                state: 'working',
                stateStartedAt: STALE_25_MIN,
                updatedAt: FRESH_1_MIN,
                lastAssistantMessage: longMessage,
              },
            ],
          }),
        ),
      ],
    });
    seedDispatch(store);

    expect(await watchdog.sweep()).toBe(1);
    expect(surface.posts[0]?.text).toContain('> `…`');
    expect(surface.posts[0]?.text).toContain('line 12');
    expect(surface.posts[0]?.text).not.toContain('line 4');
    expect(store.getStall('ctx_w1')?.lastOutput.startsWith('…')).toBe(true);
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

import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { buildRuntime, type ProcessSeams } from './runtime.ts';
import { buildCanUseTool } from './permissions.ts';
import type { Config } from '../kernel/config.ts';
import type { RepoHint } from '../kernel/routing.ts';
import type { Surface } from '../delegation/thread-surface.ts';
import type { DelegationStore } from '../delegation/delegations.ts';
import type { CommandRunner } from '../kernel/orca.ts';

/**
 * Composition tests: the REAL graph — GateKeeper, RepoAllowList, GateRelay,
 * DelegationCoordinator, ThreadSurface, GateWatcher, BootReconciler,
 * Watchdog, in-memory SQLite stores — wired by buildRuntime exactly as
 * production wires it, faked only at the pre-existing seams (the raw Slack
 * Surface, the CommandRunner, the process factory, the interval timer).
 * permissions.test.ts pins the canUseTool pipeline against scriptable
 * stand-ins; this file pins that the real composition behaves the same.
 */

const THREAD = '1751970000.000100';
const THREAD_B = '1751970001.000200';
const CHANNEL = 'C0EXAMPLE123';
const CHANNEL_B = 'C0SECOND456';
const USER = 'U0ALLOWED';
const DAEMON_WT = '/home/op/projects/orchestrator';

const CREATE_CMD =
  'orca worktree create --repo name:webapp --name webapp-84-csv-export ' +
  '--agent claude --issue 84 --no-parent --json';

const HINTS: RepoHint[] = [
  { name: 'webapp', description: 'The web app.', aliases: [], keywords: ['csv'] },
];

const CONFIG: Config = {
  slackBotToken: 'xoxb-test',
  slackAppToken: 'xapp-test',
  slackChannelIds: [CHANNEL],
  slackAllowedUserIds: [USER],
  claudeCodeOauthToken: 'token',
  logLevel: 'silent',
  dbPath: ':memory:',
  warmTtlMs: 60_000,
  costWarnThresholdsUsd: [5, 10],
  liveSessionCap: 5,
  workerCap: 3,
  watchWindowMs: 60_000,
  watchdogSweepIntervalMs: 120_000,
  watchdogStallAfterMs: 600_000,
  watchdogMaxInflightMs: 1_800_000,
  autoCloseAfterMs: 7 * 24 * 3_600_000,
  sweepIntervalMs: 3_600_000,
};

/** The orca CLI `--json` envelope, as captured from the real runtime. */
const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

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
  posts: Array<{ channelId: string; threadTs: string; text: string }> = [];
  updates: Array<{ channelId: string; ts: string; text: string }> = [];
  reactions: Array<{ channelId: string; ts: string; name: string }> = [];
  removed: Array<{ channelId: string; ts: string; name: string }> = [];
  private counter = 0;

  post(channelId: string, threadTs: string, text: string): Promise<string> {
    this.posts.push({ channelId, threadTs, text });
    this.counter += 1;
    return Promise.resolve(`msg-ts-${this.counter}`);
  }

  update(channelId: string, ts: string, text: string): Promise<void> {
    this.updates.push({ channelId, ts, text });
    return Promise.resolve();
  }

  react(channelId: string, ts: string, name: string): Promise<void> {
    this.reactions.push({ channelId, ts, name });
    return Promise.resolve();
  }

  unreact(channelId: string, ts: string, name: string): Promise<void> {
    this.removed.push({ channelId, ts, name });
    return Promise.resolve();
  }
}

/**
 * Prefix-scripted CommandRunner, plus the watcher's blocking `check --wait`
 * flavor: scripted windows are served in order, then the window stays open
 * forever — how a real quiet mailbox looks to the loop. Both record into ONE
 * ordered call log, which is what the boot-ordering pins read.
 */
const makeRunner = (
  opts: {
    script?: Record<string, string | Error>;
    windows?: string[];
    /** Per-mailbox scripted windows (issue #93) — two same-ts threads in
     * different channels watch different mailboxes, so the shared FIFO
     * cannot express which one a message lands on. */
    windowsByMailbox?: Record<string, string[]>;
  } = {},
) => {
  const calls: string[] = [];
  const windows = [...(opts.windows ?? [])];
  const byMailbox = Object.fromEntries(
    Object.entries(opts.windowsByMailbox ?? {}).map(([handle, list]) => [handle, [...list]]),
  );
  const table: Record<string, string | Error> = {
    'repo list --json': REPO_LIST_OUT,
    'terminal list --json': envelope({ terminals: [] }),
    'terminal create': envelope({ terminal: { handle: 'term_mb1' } }),
    ...opts.script,
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
  const runCheck: CommandRunner = (_command, args) => {
    calls.push(args.join(' '));
    const mailbox = args[args.indexOf('--terminal') + 1];
    const next =
      (mailbox !== undefined ? byMailbox[mailbox]?.shift() : undefined) ?? windows.shift();
    if (next !== undefined) return Promise.resolve({ stdout: next });
    return new Promise(() => {
      // an open --wait window: nothing arrives before the test ends
    });
  };
  return { calls, run, runCheck };
};

const makeRuntime = (
  opts: {
    workerCap?: number;
    script?: Record<string, string | Error>;
    windows?: string[];
    windowsByMailbox?: Record<string, string[]>;
  } = {},
) => {
  const surface = new FakeSurface();
  const runner = makeRunner(opts);
  const intervals: number[] = [];
  let seams: ProcessSeams | undefined;
  const runtime = buildRuntime({
    config: { ...CONFIG, ...(opts.workerCap !== undefined && { workerCap: opts.workerCap }) },
    hints: HINTS,
    surface,
    createProcesses: (wired) => {
      seams = wired;
      return () => ({
        runTurn: () => Promise.resolve({ status: 'process_ended' as const }),
        end: () => Promise.resolve(),
      });
    },
    mailboxWorktreePath: DAEMON_WT,
    logger: createLogger('silent'),
    run: runner.run,
    runCheck: runner.runCheck,
    every: (_task, intervalMs) => {
      intervals.push(intervalMs);
    },
  });
  if (seams === undefined) throw new Error('buildRuntime never asked for the process factory');
  return { runtime, surface, runner, intervals, seams };
};

/** The enforcement hook, built over the runtime's wired seams exactly as
 * claude.ts builds it for a session process. */
const canUseToolFor = (seams: ProcessSeams) =>
  buildCanUseTool({
    threadTs: THREAD,
    channelId: CHANNEL,
    gates: seams.gates,
    allowList: seams.allowList,
    delegations: seams.delegations,
    relay: seams.relay,
    logger: createLogger('silent'),
  });

const callOptions = (signal: AbortSignal = new AbortController().signal) => ({
  signal,
  toolUseID: 'toolu_01',
  requestId: 'req_01',
});

const seedDispatch = (
  store: DelegationStore,
  over: {
    threadTs?: string;
    channelId?: string;
    taskId?: string;
    dispatchId?: string;
    worktreeId?: string;
  } = {},
): void => {
  store.recordDispatch({
    taskId: over.taskId ?? 'task_1',
    dispatchId: over.dispatchId ?? 'ctx_1',
    worktreeId: over.worktreeId ?? 'wt-1',
    worktreeName: 'webapp-84-csv-export',
    worktreePath: '/home/op/orca/workspaces/webapp/webapp-84-csv-export',
    repo: 'webapp',
    issueNumber: 84,
    agent: 'claude',
    workerHandle: 'term_w1',
    threadTs: over.threadTs ?? THREAD,
    channelId: over.channelId ?? CHANNEL,
    cardTs: null,
    title: 'CSV export',
  });
};

const seedGate = (store: DelegationStore): void => {
  store.recordGate({
    msgId: 'msg_1',
    threadTs: THREAD,
    channelId: CHANNEL,
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    workerHandle: 'term_w1',
    worktreeName: 'webapp-84-csv-export',
    kind: 'decision_gate',
    question: 'Which directory should the export live in?',
    options: ['app/', 'lib/'],
    relayTs: '1751970002.000300',
  });
};

describe('buildRuntime — the enforcement pipeline behind one canUseTool', () => {
  it('suspends a CONFIRM command on the real 🚦 gate; the denial travels back verbatim', async () => {
    const { runtime, surface, runner, seams } = makeRuntime();
    const canUseTool = canUseToolFor(seams);

    const verdict = canUseTool('Bash', { command: 'git push --force-with-lease' }, callOptions());
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    expect(surface.posts[0]).toEqual({
      channelId: CHANNEL,
      threadTs: THREAD,
      text: '🚦 `git push --force-with-lease` — go?',
    });

    expect(runtime.gates.tryResolve(THREAD, CHANNEL, USER, 'no, rebase first')).toBe(true);
    const result = await verdict;
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('no, rebase first');
    // Neither the relay nor the coordinator seam left a trace for the
    // refused command — no daemon-side orca call ever ran.
    expect(runner.calls).toEqual([]);
  });

  it('releases the suspended call untouched on the human "go"', async () => {
    const { runtime, surface, seams } = makeRuntime();
    const canUseTool = canUseToolFor(seams);
    const input = { command: 'git push' };

    const verdict = canUseTool('Bash', input, callOptions());
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    expect(runtime.gates.tryResolve(THREAD, CHANNEL, USER, 'go')).toBe(true);
    expect(await verdict).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('runs a registry-sanctioned terminal send without the 🚦, option number down verbatim', async () => {
    const { runtime, surface, seams } = makeRuntime();
    seedDispatch(runtime.delegationStore);
    seedGate(runtime.delegationStore);
    const canUseTool = canUseToolFor(seams);

    const result = await canUseTool(
      'Bash',
      { command: 'orca terminal send --terminal term_w1 --text 2 --enter --json' },
      callOptions(),
    );
    // The real pending-gates registry vouched for the send (no 🚦 ever
    // posted) and the real relay rewrote the bare "2" to the option text —
    // fidelity through the same pipeline production runs.
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'orca terminal send --terminal term_w1 --text lib/ --enter --json' },
    });
    expect(surface.posts).toEqual([]);
  });

  it('keeps a send the registry cannot vouch for behind the 🚦', async () => {
    const { runtime, surface, seams } = makeRuntime();
    const canUseTool = canUseToolFor(seams);

    const verdict = canUseTool(
      'Bash',
      { command: 'orca terminal send --terminal term_w9 --text hello --json' },
      callOptions(),
    );
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    expect(surface.posts[0]?.text).toContain('🚦');
    runtime.gates.tryResolve(THREAD, CHANNEL, USER, 'no');
    expect(await verdict).toMatchObject({ behavior: 'deny' });
  });

  it('never reaches a coordinator seam for a command the 🚦 refused — no wave wait starts', async () => {
    // workerCap 0: had prepareCreate run, the ⏳ cap line would post and the
    // call would block on the wave; had the multi-segment guard run, the
    // denial would be the coordinator's wording, with no 🚦 ever posted.
    const { runtime, surface, runner, seams } = makeRuntime({ workerCap: 0 });
    const canUseTool = canUseToolFor(seams);

    const verdict = canUseTool('Bash', { command: `${CREATE_CMD} && git push` }, callOptions());
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    expect(surface.posts[0]?.text).toContain('🚦');
    runtime.gates.tryResolve(THREAD, CHANNEL, USER, 'no');

    const result = await verdict;
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('did not approve');
    // The only daemon-side call was the allow-list's registry read — it
    // checks before any tier is honored; the gate verdict then ended the
    // pipeline before either prepare seam ran.
    expect(runner.calls).toEqual(['repo list --json']);
    expect(surface.posts).toHaveLength(1);
  });

  it('does start the wave wait for an approved-tier create at the cap — the positive control', async () => {
    const { surface, seams } = makeRuntime({ workerCap: 0 });
    const canUseTool = canUseToolFor(seams);
    const abort = new AbortController();

    const verdict = canUseTool('Bash', { command: CREATE_CMD }, callOptions(abort.signal));
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    expect(surface.posts[0]?.text).toContain('⏳');

    abort.abort();
    const result = await verdict;
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('interrupted');
  });

  it('lets the relay speak before the coordinator — on a command both refuse, the relay word wins', async () => {
    const { runner, seams } = makeRuntime();
    const canUseTool = canUseToolFor(seams);

    const result = await canUseTool(
      'Bash',
      {
        command:
          'orca orchestration reply --id msg_9 --body 2 --json && ' +
          'orca orchestration dispatch --task task_1 --to term_w1 --inject --json',
      },
      callOptions(),
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('Relay refused');
    expect((result as { message: string }).message).toContain('as its own command');
    expect(runner.calls).toEqual([]);
  });

  it('refuses a reply aimed at a gate this thread never relayed — the real registry decides', async () => {
    const { surface, seams } = makeRuntime();
    const canUseTool = canUseToolFor(seams);

    const result = await canUseTool(
      'Bash',
      { command: 'orca orchestration reply --id msg_zzz --body done --json' },
      callOptions(),
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('not a gate relayed in this thread');
    expect(surface.posts).toEqual([]);
  });

  it('carries the relay fidelity rewrite of an in-registry reply out through updatedInput', async () => {
    const { runtime, surface, seams } = makeRuntime();
    seedDispatch(runtime.delegationStore);
    seedGate(runtime.delegationStore);
    const canUseTool = canUseToolFor(seams);

    const result = await canUseTool(
      'Bash',
      { command: 'orca orchestration reply --id msg_1 --body 2 --json' },
      callOptions(),
    );
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'orca orchestration reply --id msg_1 --body lib/ --json' },
    });
    // AUTO tier end to end: no 🚦 for a registry-anchored reply.
    expect(surface.posts).toEqual([]);
  });

  it('denies an off-list repo against the real allow-list and the scripted registry — never gated', async () => {
    const { surface, seams } = makeRuntime();
    const canUseTool = canUseToolFor(seams);

    const result = await canUseTool(
      'Bash',
      { command: CREATE_CMD.replace('name:webapp', 'name:sandbox') },
      callOptions(),
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('routing-hints.json');
    expect(surface.posts).toEqual([]);
  });
});

describe('buildRuntime — the boot sequence', () => {
  const bootScript = (worktrees: object[], tasks: object[]) => ({
    'orchestration task-list --json': envelope({ tasks }),
    'worktree ps': envelope({ worktrees }),
    'orchestration check --all': envelope({ messages: [] }),
    'worktree rm': envelope({ removed: true }),
  });

  const liveWorktree = (worktreeId: string, path: string) => ({
    worktreeId,
    path,
    isArchived: false,
    liveTerminalCount: 1,
    lastOutputAt: Date.now() - 60_000,
    agents: [],
  });

  it('reconciles BEFORE the watchers re-arm, and the cap counts the reconciled ledger', async () => {
    const { runtime, surface, runner, seams } = makeRuntime({
      workerCap: 2,
      script: bootScript(
        [liveWorktree('wt-b', '/w/b')],
        [
          { id: 'task_a', status: 'completed' },
          { id: 'task_b', status: 'running' },
        ],
      ),
    });
    const store = runtime.delegationStore;
    store.setMailbox(THREAD, CHANNEL, 'term_mb_a');
    store.setMailbox(THREAD_B, CHANNEL, 'term_mb_b');
    seedDispatch(store, { threadTs: THREAD, taskId: 'task_a', dispatchId: 'ctx_a', worktreeId: 'wt-a' });
    seedDispatch(store, { threadTs: THREAD_B, taskId: 'task_b', dispatchId: 'ctx_b', worktreeId: 'wt-b' });

    await runtime.boot();

    // Reconciliation closed the outage completion and left the live row.
    expect(store.listInFlightForThread(THREAD, CHANNEL)).toEqual([]);
    expect(store.listInFlightForThread(THREAD_B, CHANNEL)).toHaveLength(1);
    // Its worktree got the same success cleanup as a live worker_done.
    expect(runner.calls).toContain('worktree rm --worktree id:wt-a --json');

    // Re-arm saw the reconciled ledger: no watcher for the closed thread.
    expect(runtime.watcher.isArmed(THREAD, CHANNEL)).toBe(false);
    expect(runtime.watcher.isArmed(THREAD_B, CHANNEL)).toBe(true);
    const waits = runner.calls.filter((call) => call.startsWith('orchestration check --wait'));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toContain('term_mb_b');

    // The order itself: reconcile's reads all land before the first re-armed
    // window opens, which lands before the watchdog's boot sweep.
    const firstWait = runner.calls.findIndex((call) => call.startsWith('orchestration check --wait'));
    const taskList = runner.calls.indexOf('orchestration task-list --json');
    const watchdogPs = runner.calls.lastIndexOf('worktree ps --limit 1000 --json');
    expect(taskList).toBeGreaterThanOrEqual(0);
    expect(taskList).toBeLessThan(firstWait);
    expect(firstWait).toBeLessThan(watchdogPs);

    // The worker cap reads the ledger reconcile just cleaned: with cap 2 and
    // one survivor in flight, a new create proceeds with no ⏳ wave wait.
    const capPostsBefore = surface.posts.length;
    const result = await canUseToolFor(seams)('Bash', { command: CREATE_CMD }, callOptions());
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(surface.posts.slice(capPostsBefore).filter((post) => post.text.includes('⏳'))).toEqual([]);
  });

  it('arms the sweeps as steps: the watchdog interval at boot, the dormancy interval on demand', async () => {
    const { runtime, intervals } = makeRuntime();
    await runtime.boot();
    expect(intervals).toEqual([CONFIG.watchdogSweepIntervalMs]);
    runtime.startDormancySweep();
    expect(intervals).toEqual([CONFIG.watchdogSweepIntervalMs, CONFIG.sweepIntervalMs]);
  });

  it('two same-ts threads in different channels run independent watchers end to end (issue #93)', async () => {
    const workerDone = {
      id: 'msg_done_b',
      type: 'worker_done',
      subject: 'Delivered: the other channel’s work',
      body: 'PR: https://github.com/acme/webapp/pull/93',
      from_handle: 'term_w1',
      payload: JSON.stringify({ taskId: 'task_chan_b', dispatchId: 'ctx_chan_b' }),
    };
    const { runtime, surface, runner } = makeRuntime({
      script: bootScript(
        [liveWorktree('wt-a', '/w/a'), liveWorktree('wt-b', '/w/b')],
        [
          { id: 'task_chan_a', status: 'running' },
          { id: 'task_chan_b', status: 'running' },
        ],
      ),
      // Only channel B's mailbox has a message waiting; channel A's window
      // stays open — exactly one worker finished.
      windowsByMailbox: { term_mb_b: [envelope({ messages: [workerDone] })] },
    });
    const store = runtime.delegationStore;
    store.setMailbox(THREAD, CHANNEL, 'term_mb_a');
    store.setMailbox(THREAD, CHANNEL_B, 'term_mb_b');
    seedDispatch(store, { taskId: 'task_chan_a', dispatchId: 'ctx_chan_a', worktreeId: 'wt-a' });
    seedDispatch(store, {
      channelId: CHANNEL_B,
      taskId: 'task_chan_b',
      dispatchId: 'ctx_chan_b',
      worktreeId: 'wt-b',
    });

    await runtime.boot();

    // One watcher per (thread, channel) pair — the same ts armed twice.
    expect(runtime.watcher.isArmed(THREAD, CHANNEL)).toBe(true);
    expect(runtime.watcher.isArmed(THREAD, CHANNEL_B)).toBe(true);
    const waits = runner.calls.filter((call) => call.startsWith('orchestration check --wait'));
    expect(waits.some((call) => call.includes('term_mb_a'))).toBe(true);
    expect(waits.some((call) => call.includes('term_mb_b'))).toBe(true);

    // Channel B's completion closes ONLY channel B's row…
    await vi.waitFor(() => {
      expect(store.listInFlightForThread(THREAD, CHANNEL_B)).toEqual([]);
    });
    expect(store.listInFlightForThread(THREAD, CHANNEL)).toHaveLength(1);

    // …its ✅ fallback summary and root flip land in channel B alone…
    await vi.waitFor(() => {
      expect(
        surface.posts.some(
          (post) => post.channelId === CHANNEL_B && post.text.includes('Delivered: the other channel’s work'),
        ),
      ).toBe(true);
    });
    expect(
      surface.posts.filter((post) => post.channelId === CHANNEL && post.text.includes('✅')),
    ).toEqual([]);
    await vi.waitFor(() => {
      expect(surface.reactions).toContainEqual({
        channelId: CHANNEL_B,
        ts: THREAD,
        name: 'white_check_mark',
      });
    });
    expect(
      surface.reactions.filter(
        (reaction) => reaction.channelId === CHANNEL && reaction.name === 'white_check_mark',
      ),
    ).toEqual([]);

    // …and channel A's watcher keeps watching while B's wound down.
    await vi.waitFor(() => {
      expect(runtime.watcher.isArmed(THREAD, CHANNEL_B)).toBe(false);
    });
    expect(runtime.watcher.isArmed(THREAD, CHANNEL)).toBe(true);
    await vi.waitFor(() => {
      expect(runner.calls).toContain('worktree rm --worktree id:wt-b --json');
    });
    expect(runner.calls).not.toContain('worktree rm --worktree id:wt-a --json');
  });

  it('routes a worker_done from the re-armed watcher through ledger, card and cleanup', async () => {
    const workerDone = {
      id: 'msg_done_1',
      type: 'worker_done',
      subject: 'Delivered: CSV export',
      body: 'PR: https://github.com/acme/webapp/pull/12',
      from_handle: 'term_w1',
      payload: JSON.stringify({ taskId: 'task_b', dispatchId: 'ctx_b' }),
    };
    const { runtime, surface, runner } = makeRuntime({
      script: bootScript([liveWorktree('wt-b', '/w/b')], [{ id: 'task_b', status: 'running' }]),
      windows: [envelope({ messages: [workerDone] })],
    });
    const store = runtime.delegationStore;
    store.setMailbox(THREAD_B, CHANNEL, 'term_mb_b');
    seedDispatch(store, { threadTs: THREAD_B, taskId: 'task_b', dispatchId: 'ctx_b', worktreeId: 'wt-b' });

    await runtime.boot();
    await vi.waitFor(() => {
      expect(store.listInFlightForThread(THREAD_B, CHANNEL)).toEqual([]);
    });

    // The card flipped ✅ (posted fresh — the seeded row carried no cardTs),
    // the completion surfaced even with no session to wake, and the
    // delivered worktree was cleaned up.
    await vi.waitFor(() => {
      expect(surface.posts.some((post) => post.text.includes('Delivered: CSV export'))).toBe(true);
    });
    expect(surface.posts.some((post) => post.threadTs === THREAD_B && post.text.includes('✅'))).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(runner.calls).toContain('worktree rm --worktree id:wt-b --json');
    });
    // Nothing left in flight: the watcher loop wound itself down.
    await vi.waitFor(() => {
      expect(runtime.watcher.isArmed(THREAD_B, CHANNEL)).toBe(false);
    });
  });
});

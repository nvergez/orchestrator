import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { DelegationStore } from './delegations.ts';
import { GateWatcher, type WakeResult } from './watcher.ts';
import { ThreadSurface, type Surface } from './thread-surface.ts';
import type { CommandRunner } from '../kernel/orca.ts';

const THREAD = '1751970000.000100';
const THREAD_B = '1751970001.000200';
const CHANNEL = 'C0EXAMPLE123';
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
    'Opened https://github.com/acme/webapp/pull/87 with the export endpoint. ' +
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
  /** Fail only the next N posts — a transient Slack outage. */
  failNextPosts = 0;
  private counter = 0;

  post(threadTs: string, text: string): Promise<string> {
    if (this.failNextPosts > 0) {
      this.failNextPosts -= 1;
      return Promise.reject(new Error('slack down'));
    }
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

interface HarnessOptions {
  checks?: Array<string | Error>;
  wakeResult?: WakeResult;
  registryDown?: boolean;
  /** `worktree rm --json` stdout or a refusal; default: a clean removal. */
  rmResult?: string | Error;
}

const makeWatcher = (options: HarnessOptions = {}) => {
  // Dispatch at 14:04, worker_done handled at 14:31 — the mock's 27 min.
  const store = new DelegationStore(':memory:', () => '2026-07-08T14:04:00.000Z');
  store.setMailbox(THREAD, CHANNEL, MAILBOX);
  const surface = new FakeSurface();
  const checkRunner = makeCheckRunner(options.checks ?? []);
  const wakes: Array<{ threadTs: string; channelId: string; text: string }> = [];
  let closed = 0;
  // The short daemon-side runner, dispatched on the subcommand: the registry
  // lookup for issue links, and the success cleanup's `worktree rm` (#43).
  const rmCalls: string[] = [];
  const run: CommandRunner = (_command, args) => {
    if (options.registryDown === true) return Promise.reject(new Error('orca down'));
    if (args[0] === 'worktree' && args[1] === 'rm') {
      rmCalls.push(args.join(' '));
      const result = options.rmResult ?? envelope({ removed: true });
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ stdout: result });
    }
    return Promise.resolve({ stdout: REPO_LIST_OUT });
  };
  const watcher = new GateWatcher({
    store,
    surface: new ThreadSurface({ surface, store, logger: createLogger('silent'), run }),
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
    run,
    now: () => new Date('2026-07-08T14:31:00.000Z'),
  });
  return { watcher, store, surface, checkRunner, wakes, rmCalls, slotsFreed: () => closed };
};

const stopped = (watcher: GateWatcher, threadTs = THREAD) =>
  vi.waitFor(() => {
    expect(watcher.isArmed(threadTs, CHANNEL)).toBe(false);
  });

describe('worker_done — the happy path', () => {
  it('closes the row, flips the card to ✅ with durable links, swaps 👀 for ✅, wakes the session', async () => {
    const { watcher, store, surface, checkRunner, wakes, rmCalls, slotsFreed } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls[0]).toBe(
      `orchestration check --wait --terminal ${MAILBOX} ` +
        '--types worker_done,escalation,decision_gate,heartbeat,status --timeout-ms 900000 --json',
    );

    const row = store.getByDispatchId('ctx_d1');
    expect(row?.status).toBe('completed');
    expect(row?.closedAt).not.toBeNull();
    expect(slotsFreed()).toBe(1);

    // The card became the durable home for links (mock scenario A end).
    expect(surface.updates).toHaveLength(1);
    const card = surface.updates[0];
    expect(card?.ts).toBe('card-ts-1');
    expect(card?.text).toContain('✅ *webapp#84 — CSV export of send metrics — delivered in 27 min*');
    expect(card?.text).toContain('• PR: <https://github.com/acme/webapp/pull/87|webapp#87>');
    expect(card?.text).toContain('• issue: <https://github.com/acme/webapp/issues/84|webapp#84>');
    expect(card?.text).toContain('• worktree: `/home/op/orca/workspaces/webapp/webapp-84-csv-export`');

    // Root reaction 👀 → ✅ (the add, plus best-effort removal of the rest).
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'white_check_mark' }]);

    // The wake rides the human-message pipe; the session writes the summary,
    // so the daemon posts nothing itself.
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ threadTs: THREAD, channelId: CHANNEL });
    expect(wakes[0]?.text).toContain('worker_done');
    expect(wakes[0]?.text).toContain('webapp#84');
    expect(wakes[0]?.text).toContain('https://github.com/acme/webapp/pull/87');
    expect(wakes[0]?.text).toContain('✅ Delivered');
    expect(surface.posts).toEqual([]);

    // The delivered worktree went away, silently (issue #43).
    expect(rmCalls).toEqual(['worktree rm --worktree id:wt-1 --json']);
  });

  it('posts a fresh final card when no ⚙️ card ever landed', async () => {
    const { watcher, store, surface } = makeWatcher({ checks: [checkOut(busMessage())] });
    seedDispatch(store, { cardTs: null });

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(surface.updates).toEqual([]);
    expect(surface.posts.some((post) => post.text.startsWith('✅ *webapp#84'))).toBe(true);
  });

  it('degrades the issue link to plain repo#n when the registry is unreachable', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage())],
      registryDown: true,
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(surface.updates[0]?.text).toContain('• issue: webapp#84');
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

  it('settles back to 👀 while a sibling delegation is still in flight, and keeps watching', async () => {
    const { watcher, store, surface, checkRunner } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_9999' });

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    });

    // Never ✅ with work still out — the registries settle the honest state.
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'eyes' }]);
    // The second window parked on the still-armed watcher.
    expect(watcher.isArmed(THREAD, CHANNEL)).toBe(true);
    expect(checkRunner.calls).toHaveLength(2);
  });

  it('a sibling worker_done keeps 🚨 while another delegation’s stall alert is pending', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_9999' });
    store.recordStall({
      dispatchId: 'ctx_d2',
      threadTs: THREAD,
      workerHandle: 'term_stalled',
      worktreeName: 'sandbox-9-slug',
      lastOutput: '? proceed (y/N)',
      fingerprint: '1751970000000',
      relayTs: null,
    });

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    });

    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
  });

  it('ignores a duplicated worker_done — one close, one freed slot, one wake, one cleanup', async () => {
    const { watcher, store, wakes, rmCalls, slotsFreed } = makeWatcher({
      checks: [checkOut(busMessage(), busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(slotsFreed()).toBe(1);
    expect(wakes).toHaveLength(1);
    expect(rmCalls).toHaveLength(1);
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
    const { watcher, store, surface, wakes, rmCalls } = makeWatcher({
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
    expect(card).toContain('❌ *webapp#84 — CSV export of send metrics — failed after 27 min*');
    expect(card).toContain('• reason: Failed: e2e tests break on main');
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'x' }]);
    expect(wakes[0]?.text).toContain('FAILED');
    expect(wakes[0]?.text).toContain('❌ Failed');

    // The failure's worktree is the debugging evidence — never cleaned up.
    expect(rmCalls).toEqual([]);
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

describe('worker_done — worktree cleanup (issue #43)', () => {
  it('a dirty-tree refusal keeps the worktree and posts the 🧹 line with the runtime’s reason', async () => {
    const refusal = Object.assign(new Error('Command failed: orca'), {
      stdout: JSON.stringify({
        id: 'x',
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'Failed to delete worktree at /home/op/orca/workspaces/webapp/webapp-84-csv-export. ?? notes.md',
        },
      }),
    });
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage())],
      rmResult: refusal,
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    // The delegation still closed cleanly — cleanup is janitorial.
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(surface.posts).toEqual([
      {
        threadTs: THREAD,
        text:
          '🧹 Could not clean up worktree `webapp-84-csv-export` — kept for inspection.\n' +
          '> Failed to delete worktree at /home/op/orca/workspaces/webapp/webapp-84-csv-export. ?? notes.md',
      },
    ]);
  });

  it('an unreadable rm response is a refusal too — kept and surfaced, never a crash', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage())],
      rmResult: 'not json at all',
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(surface.posts[0]?.text).toContain('🧹 Could not clean up worktree');
  });

  it('a row with no worktree id skips cleanup silently', async () => {
    const { watcher, store, surface, rmCalls } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store, { worktreeId: null, worktreeName: null, worktreePath: null });

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    expect(rmCalls).toEqual([]);
    expect(surface.posts).toEqual([]);
  });
});

describe('decision_gate / escalation — the relay up (issue #21)', () => {
  // The real `ask` payload names NO task or dispatch id — the asking
  // terminal (from_handle) is the gate's only identity.
  const gateMessage = (over: Partial<Record<string, unknown>> = {}) =>
    busMessage({
      type: 'decision_gate',
      subject: 'Question',
      body: 'Which lint config is authoritative for CI?',
      payload: JSON.stringify({
        question: 'Which lint config is authoritative for CI?',
        options: ['root', 'app/', 'merge both'],
      }),
      ...over,
    });

  it('posts the fixed gate message, registers the pending gate, sets ❓ — and never wakes', async () => {
    const { watcher, store, surface, wakes, slotsFreed } = makeWatcher({
      checks: [checkOut(gateMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });

    expect(surface.posts[0]?.text).toBe(
      [
        '❓ *`webapp-84-csv-export`* (<https://github.com/acme/webapp/issues/84|webapp#84>) asks:',
        '',
        '> Which lint config is authoritative for CI?',
        '> *1.* root',
        '> *2.* app/',
        '> *3.* merge both',
        '',
        'Reply in this thread — a number or free text.',
      ].join('\n'),
    );
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'question' }]);

    // The registry row — spec §9, written by the daemon at relay time.
    expect(store.getGate('msg_a8f37bac632f')).toMatchObject({
      msgId: 'msg_a8f37bac632f',
      threadTs: THREAD,
      taskId: 'task_3f81',
      workerHandle: 'term_w1',
      worktreeName: 'webapp-84-csv-export',
      kind: 'decision_gate',
      question: 'Which lint config is authoritative for CI?',
      options: ['root', 'app/', 'merge both'],
      relayTs: 'msg-ts-1',
      status: 'pending',
    });

    // The session thinks at ANSWER time; the relay itself burns no turn.
    expect(wakes).toHaveLength(0);
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    expect(slotsFreed()).toBe(0);
    expect(watcher.isArmed(THREAD, CHANNEL)).toBe(true);
  });

  it('relays an escalation 🚨 from its body, without options or a number tail', async () => {
    const { watcher, store, surface, wakes } = makeWatcher({
      checks: [
        checkOut(
          busMessage({
            type: 'escalation',
            subject: 'Blocked',
            body: 'The e2e tests break on `main` — pausing.',
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
    expect(post).toContain('🚨 *`webapp-84-csv-export`*');
    expect(post).toContain('escalates:');
    expect(post).toContain('> The e2e tests break on `main` — pausing.');
    expect(post).toContain('Reply in this thread.');
    expect(post).not.toContain('a number or free text');
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'rotating_light' }]);
    expect(store.getGate('msg_a8f37bac632f')?.kind).toBe('escalation');
    expect(wakes).toHaveLength(0);
  });

  it('a ❓ arriving while a 🚨 is pending keeps the root at 🚨', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(
          busMessage({ id: 'msg_esc', type: 'escalation', body: 'main is broken' }),
          gateMessage({ id: 'msg_ask' }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(2);
    });
    expect(surface.reactions.map((reaction) => reaction.name)).toEqual([
      'rotating_light',
      'rotating_light',
    ]);
  });

  it('ignores a replayed gate event — one post, one registry row', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(gateMessage()), checkOut(gateMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    // Both windows consumed; the replay changed nothing.
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
      expect(store.listPendingGates(THREAD)).toHaveLength(1);
    });
  });

  it('still registers the gate when the Slack post fails — never lost', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(gateMessage())],
    });
    surface.failPosts = true;
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getGate('msg_a8f37bac632f')).toBeDefined();
    });
    expect(store.getGate('msg_a8f37bac632f')).toMatchObject({
      question: 'Which lint config is authoritative for CI?',
      relayTs: null,
      status: 'pending',
    });
  });

  it('relays an unmatched gate as "A worker", keeping the asking handle for the route back', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(
          gateMessage({
            from_handle: 'term_stray',
            payload: JSON.stringify({ question: 'Anyone there?' }),
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(1);
    });
    expect(surface.posts[0]?.text).toContain('❓ *A worker* asks:');
    expect(store.getGate('msg_a8f37bac632f')).toMatchObject({
      workerHandle: 'term_stray',
      worktreeName: null,
      taskId: null,
    });
  });
});

describe('re-asked questions and closed delegations — gate hygiene (issue #46)', () => {
  // The timeout re-ask shape from the live incident: the worker's `ask`
  // expired, it asked the SAME question again — a fresh msg_id each time.
  const ask = (id: string, over: Partial<Record<string, unknown>> = {}) =>
    busMessage({
      id,
      type: 'decision_gate',
      subject: 'Question',
      body: 'Which format should the report file use?',
      payload: JSON.stringify({
        question: 'Which format should the report file use?',
        options: ['markdown', 'json'],
      }),
      ...over,
    });

  it('a re-ask edits the ❓ relay in place — one message, one live gate', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(ask('msg_first')),
        checkOut(
          ask('msg_second', {
            payload: JSON.stringify({
              // Verbatim modulo case and whitespace — still the same question.
              question: 'which format should  the report file use?',
              options: ['markdown', 'json'],
            }),
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getGate('msg_first')?.status).toBe('superseded');
      expect(surface.reactions).toHaveLength(2);
    });

    // No second ❓ notification: the one relay got edited, with the newest
    // ask's verbatim wording.
    expect(surface.posts).toHaveLength(1);
    expect(surface.updates).toHaveLength(1);
    expect(surface.updates[0]?.ts).toBe('msg-ts-1');
    expect(surface.updates[0]?.text).toContain('> which format should  the report file use?');

    expect(store.getGate('msg_first')).toMatchObject({
      status: 'superseded',
      supersededBy: 'msg_second',
    });
    expect(store.getGate('msg_second')).toMatchObject({ status: 'pending', relayTs: 'msg-ts-1' });
    expect(store.listPendingGates(THREAD).map((gate) => gate.msgId)).toEqual(['msg_second']);
    // The coarse state never wavers — still one question waiting.
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'question' });
  });

  it('a distinct question from the same worker still relays separately — no over-dedup', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(ask('msg_q1')),
        checkOut(
          ask('msg_q2', {
            payload: JSON.stringify({ question: 'Should the report include raw timings?' }),
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(2);
    });

    expect(surface.updates).toEqual([]);
    expect(store.listPendingGates(THREAD).map((gate) => gate.msgId)).toEqual([
      'msg_q1',
      'msg_q2',
    ]);
  });

  it('an escalation wording a pending question identically never dedups across kinds', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(ask('msg_q')),
        checkOut(
          busMessage({
            id: 'msg_esc',
            type: 'escalation',
            subject: 'Blocked',
            body: 'Which format should the report file use?',
            payload: JSON.stringify({}),
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(surface.posts).toHaveLength(2);
    });

    expect(store.listPendingGates(THREAD).map((gate) => gate.msgId).sort()).toEqual([
      'msg_esc',
      'msg_q',
    ]);
  });

  it('a re-ask whose original relay never posted posts fresh — the human finally sees it', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(ask('msg_first')), checkOut(ask('msg_second'))],
    });
    surface.failNextPosts = 1;
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getGate('msg_first')?.status).toBe('superseded');
    });

    expect(surface.updates).toEqual([]);
    expect(surface.posts).toHaveLength(1);
    expect(store.getGate('msg_second')).toMatchObject({ status: 'pending', relayTs: 'msg-ts-1' });
  });

  it('worker_done leaves zero pending gates for that delegation', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(ask('msg_q')), checkOut(busMessage())],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await stopped(watcher);

    expect(store.getGate('msg_q')?.status).toBe('closed');
    expect(store.listPendingGates(THREAD)).toEqual([]);
    // The moot question no longer holds ❓ — the thread ends delivered.
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'white_check_mark' });
  });

  it('a sibling’s pending gate survives another delegation’s worker_done', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(
          ask('msg_q', {
            from_handle: 'term_w2',
            payload: JSON.stringify({ question: 'Deploy to staging first?' }),
          }),
        ),
        checkOut(busMessage()),
      ],
    });
    seedDispatch(store);
    seedDispatch(store, {
      dispatchId: 'ctx_d2',
      taskId: 'task_9999',
      workerHandle: 'term_w2',
      cardTs: 'card-ts-2',
    });

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
    });

    expect(store.getGate('msg_q')?.status).toBe('pending');
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'question' });
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
    expect(watcher.isArmed(THREAD, CHANNEL)).toBe(true);
  });

  it('re-arms for a dispatch landing right after a stop — un-arm is atomic with the stop', async () => {
    const second = busMessage({ payload: JSON.stringify({ taskId: 'task_9999', dispatchId: 'ctx_d2' }) });
    const { watcher, store, checkRunner } = makeWatcher({
      checks: [checkOut(busMessage()), checkOut(second)],
    });
    seedDispatch(store);
    watcher.arm(THREAD);
    await stopped(watcher);

    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_9999' });
    watcher.arm(THREAD);
    await stopped(watcher);

    expect(checkRunner.calls).toHaveLength(2);
    expect(store.getByDispatchId('ctx_d2')?.status).toBe('completed');
  });

  it('keeps watching when a new dispatch lands while an event is being handled', async () => {
    const { watcher, store, checkRunner, wakes } = makeWatcher({
      checks: [checkOut(busMessage())],
    });
    seedDispatch(store);
    // The wake fires mid-handling — a session turn dispatching again right
    // then must find the loop still alive for its next window.
    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(wakes).toHaveLength(1);
    });
    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_9999' });
    watcher.arm(THREAD); // what onDispatched does — must not double-loop
    await vi.waitFor(() => {
      expect(checkRunner.calls).toHaveLength(2);
    });
    expect(watcher.isArmed(THREAD, CHANNEL)).toBe(true);
  });

  it('stops when the mailbox is missing instead of spinning', async () => {
    const store = new DelegationStore(':memory:');
    const checkRunner = makeCheckRunner([]);
    const watcher = new GateWatcher({
      store,
      surface: new ThreadSurface({
        surface: new FakeSurface(),
        store,
        logger: createLogger('silent'),
      }),
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
    expect(watcher.isArmed(THREAD, CHANNEL)).toBe(true);
    expect(watcher.isArmed(THREAD_B, CHANNEL)).toBe(false);
  });

  it('a completion sent while the daemon was down lands after the re-arm', async () => {
    const { watcher, store } = makeWatcher({ checks: [checkOut(busMessage())] });
    seedDispatch(store);

    watcher.rearmFromStore();
    await stopped(watcher);

    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
  });
});

describe('worker_done after boot reconciliation (issue #25)', () => {
  it('lands a taskId-only replay for an already-closed row on the duplicate guard', async () => {
    const { watcher, store, surface, wakes, slotsFreed } = makeWatcher({
      checks: [
        checkOut(
          busMessage({ payload: JSON.stringify({ taskId: 'task_3f81' }) }),
          busMessage({
            id: 'msg_sibling',
            subject: 'sibling shipped',
            payload: JSON.stringify({ taskId: 'task_s1', dispatchId: 'ctx_d2' }),
          }),
        ),
      ],
    });
    seedDispatch(store);
    seedDispatch(store, { dispatchId: 'ctx_d2', taskId: 'task_s1', cardTs: 'card-ts-2' });
    // Boot reconciliation closed the first delegation during the outage.
    store.closeDelegation('ctx_d1', 'completed');

    watcher.arm(THREAD);
    await stopped(watcher);

    // The replayed completion neither surfaces raw nor wakes anyone; only
    // the live sibling's close counts.
    expect(surface.posts).toEqual([]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toContain('sibling shipped');
    expect(slotsFreed()).toBe(1);
    expect(store.getByDispatchId('ctx_d1')?.status).toBe('completed');
  });
});

describe('heartbeats — the bus clock and alert reset (issue #48)', () => {
  const pendingStall = (store: DelegationStore): void => {
    store.recordStall({
      dispatchId: 'ctx_d1',
      threadTs: THREAD,
      workerHandle: 'term_w1',
      worktreeName: 'webapp-84-csv-export',
      lastOutput: 'Exit code 1 / Orca is not running.',
      fingerprint: 'inflight:1751970240000',
      relayTs: 'alert-ts-1',
    });
  };

  it.each(['heartbeat', 'status'])(
    'a %s message stamps the bus clock and settles the pending ⚠️ — no post, no wake',
    async (type) => {
      const { watcher, store, surface, checkRunner, wakes } = makeWatcher({
        checks: [checkOut(busMessage({ type, subject: 'alive', body: '' }))],
      });
      seedDispatch(store);
      pendingStall(store);

      watcher.arm(THREAD);
      await vi.waitFor(() => {
        expect(store.getByDispatchId('ctx_d1')?.lastBusAt).not.toBeNull();
      });

      expect(store.getStall('ctx_d1')?.status).toBe('answered');
      // The window listens for liveness types alongside the gate trio.
      expect(checkRunner.calls[0]).toContain(
        '--types worker_done,escalation,decision_gate,heartbeat,status',
      );
      // The alert cleared, so the root settles back to 👀.
      expect(surface.reactions).toContainEqual({ ts: THREAD, name: 'eyes' });
      // The message IS the signal — nothing relays, nobody wakes.
      expect(surface.posts).toEqual([]);
      expect(wakes).toEqual([]);
      // The delegation stays in flight.
      expect(store.getByDispatchId('ctx_d1')?.status).toBe('dispatched');
    },
  );

  it('a heartbeat with no pending alert stamps the clock and touches nothing else', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [checkOut(busMessage({ type: 'heartbeat', subject: 'alive', body: '' }))],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getByDispatchId('ctx_d1')?.lastBusAt).not.toBeNull();
    });

    expect(surface.posts).toEqual([]);
    expect(surface.reactions).toEqual([]);
  });

  it('a heartbeat matching no ledger row is ignored quietly', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(
          busMessage({
            type: 'heartbeat',
            subject: 'alive',
            body: '',
            payload: JSON.stringify({ taskId: 'task_ghost', dispatchId: 'ctx_ghost' }),
            from_handle: undefined,
          }),
        ),
      ],
    });
    seedDispatch(store);

    watcher.arm(THREAD);
    // The next (dry) window parks — give the handled message a beat to land.
    await vi.waitFor(() => {
      expect(watcher.isArmed(THREAD, CHANNEL)).toBe(true);
    });

    expect(store.getByDispatchId('ctx_d1')?.lastBusAt).toBeNull();
    expect(surface.posts).toEqual([]);
  });

  it('an ask is bus liveness too: stamps the clock and supersedes the pending ⚠️', async () => {
    const { watcher, store, surface } = makeWatcher({
      checks: [
        checkOut(
          busMessage({
            id: 'msg_ask1',
            type: 'decision_gate',
            subject: 'Question',
            body: '',
            payload: JSON.stringify({ question: 'Overwrite bench.json?', options: ['yes', 'no'] }),
          }),
        ),
      ],
    });
    seedDispatch(store);
    pendingStall(store);

    watcher.arm(THREAD);
    await vi.waitFor(() => {
      expect(store.getByDispatchId('ctx_d1')?.lastBusAt).not.toBeNull();
    });

    expect(store.getStall('ctx_d1')?.status).toBe('answered');
    // The gate relay owns the thread's attention now: ❓ posted and set.
    expect(surface.posts).toHaveLength(1);
    expect(surface.posts[0]?.text).toContain('Overwrite bench.json?');
    expect(surface.reactions).toContainEqual({ ts: THREAD, name: 'question' });
  });
});

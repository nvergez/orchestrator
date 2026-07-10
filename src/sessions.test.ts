import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';
import { SessionStore } from './db.ts';
import type { ClosingDelegation } from './messages.ts';
import {
  SessionManager,
  type Notifier,
  type OrchestratorProcess,
  type TurnEvents,
  type TurnOutcome,
} from './sessions.ts';

const THREAD = '1751970000.000100';
const THREAD_2 = '1751970001.000200';
const THREAD_3 = '1751970002.000300';
const CHANNEL = 'C0EXAMPLE123';
const USER = 'U0EXAMPLE456';
const TTL = 30 * 60_000;
const DAY = 24 * 60 * 60_000;

/** A scriptable stand-in for the Claude subprocess behind one thread. */
class FakeProcess implements OrchestratorProcess {
  turns: Array<{ text: string; events: TurnEvents; resolve: (o: TurnOutcome) => void }> = [];
  ended = false;
  private readonly script?: (text: string, events: TurnEvents) => TurnOutcome;

  constructor(script?: (text: string, events: TurnEvents) => TurnOutcome) {
    this.script = script;
  }

  runTurn(text: string, events: TurnEvents): Promise<TurnOutcome> {
    if (this.script) return Promise.resolve(this.script(text, events));
    return new Promise((resolve) => this.turns.push({ text, events, resolve }));
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

class FakeVoice {
  streamed = '';
  finalized = false;
  fallback: string | undefined;

  append(delta: string): void {
    this.streamed += delta;
  }

  finalize(fallback?: string): Promise<void> {
    this.finalized = true;
    this.fallback = fallback;
    return Promise.resolve();
  }
}

interface Harness {
  manager: SessionManager;
  store: SessionStore;
  spawns: Array<{ resumeSessionId: string | null; proc: FakeProcess }>;
  voices: FakeVoice[];
  notices: Array<{ threadTs: string; text: string }>;
  turnStarts: string[];
  turnEnds: string[];
}

const makeHarness = (
  script?: (text: string, events: TurnEvents) => TurnOutcome,
  options: {
    store?: SessionStore;
    notify?: Notifier;
    cap?: number;
    autoCloseMs?: number;
    listDelegations?: (threadTs: string) => Promise<ClosingDelegation[]>;
    onTurnStart?: (threadTs: string) => Promise<void>;
    onTurnEnd?: (threadTs: string) => Promise<void>;
  } = {},
): Harness => {
  const store = options.store ?? new SessionStore(':memory:');
  const spawns: Harness['spawns'] = [];
  const voices: FakeVoice[] = [];
  const notices: Harness['notices'] = [];
  const turnStarts: string[] = [];
  const turnEnds: string[] = [];
  const manager = new SessionManager({
    store,
    spawn: ({ resumeSessionId }) => {
      const proc = new FakeProcess(script);
      spawns.push({ resumeSessionId, proc });
      return proc;
    },
    voiceFor: () => {
      const voice = new FakeVoice();
      voices.push(voice);
      return voice;
    },
    notify:
      options.notify ??
      ((threadTs, text) => {
        notices.push({ threadTs, text });
        return Promise.resolve();
      }),
    costThresholdsUsd: [5, 10],
    warmTtlMs: TTL,
    liveSessionCap: options.cap ?? 5,
    autoCloseAfterMs: options.autoCloseMs ?? 7 * DAY,
    listDelegations: options.listDelegations ?? (() => Promise.resolve([])),
    onTurnStart:
      options.onTurnStart ??
      ((threadTs) => {
        turnStarts.push(threadTs);
        return Promise.resolve();
      }),
    onTurnEnd:
      options.onTurnEnd ??
      ((threadTs) => {
        turnEnds.push(threadTs);
        return Promise.resolve();
      }),
    logger: createLogger('silent'),
  });
  return { manager, store, spawns, voices, notices, turnStarts, turnEnds };
};

const chattyScript = (sessionId: string) => (text: string, events: TurnEvents) => {
  events.onSessionId(sessionId);
  events.onDelta(`echo: ${text}`);
  return { status: 'success', resultText: `echo: ${text}`, costUsd: 0 } as const;
};

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('open registers the thread, streams the voice, and persists the session_id', async () => {
    const { manager, store, spawns, voices } = makeHarness(chattyScript('sess-1'));

    manager.open(THREAD, CHANNEL, USER, 'hello there');
    await flush();

    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.resumeSessionId).toBeNull();
    expect(voices[0]?.streamed).toBe('echo: hello there');
    expect(voices[0]?.finalized).toBe(true);
    const row = store.get(THREAD, CHANNEL);
    expect(row?.sessionId).toBe('sess-1');
    expect(row?.turnCount).toBe(1);
  });

  it('reply in an unregistered thread does nothing — never a ghost resume', async () => {
    const { manager, spawns } = makeHarness(chattyScript('sess-1'));

    const result = manager.reply(THREAD, CHANNEL, 'sneaky resume');
    await flush();

    expect(result).toBe('unregistered');
    expect(spawns).toHaveLength(0);
  });

  it('reply within the warmth TTL reuses the live process', async () => {
    const { manager, spawns } = makeHarness(chattyScript('sess-1'));
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();

    const result = manager.reply(THREAD, CHANNEL, 'second');
    await flush();

    expect(result).toBe('turn');
    expect(spawns).toHaveLength(1);
    expect(manager.liveProcessCount()).toBe(1);
  });

  it('after the TTL the process is ended; the next reply cold-resumes with the persisted session_id', async () => {
    const { manager, spawns } = makeHarness(chattyScript('sess-1'));
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();

    await vi.advanceTimersByTimeAsync(TTL);
    expect(spawns[0]?.proc.ended).toBe(true);
    expect(manager.liveProcessCount()).toBe(0);

    manager.reply(THREAD, CHANNEL, 'welcome back');
    await flush();

    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.resumeSessionId).toBe('sess-1');
  });

  it('a second message during a turn queues — FIFO, one turn in flight per thread', async () => {
    const { manager, spawns } = makeHarness();
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.reply(THREAD, CHANNEL, 'second');
    await flush();

    const proc = spawns[0]!.proc;
    expect(proc.turns).toHaveLength(1);
    expect(proc.turns[0]?.text).toBe('first');

    proc.turns[0]!.events.onSessionId('sess-1');
    proc.turns[0]!.resolve({ status: 'success', resultText: 'ok', costUsd: 0 });
    await flush();

    expect(proc.turns).toHaveLength(2);
    expect(proc.turns[1]?.text).toBe('second');
  });

  it('threads run independently — a busy thread does not block another', async () => {
    const { manager, spawns } = makeHarness();
    manager.open(THREAD, CHANNEL, USER, 'slow one');
    await flush();

    manager.open('1751970099.000900', CHANNEL, USER, 'other thread');
    await flush();

    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.proc.turns[0]?.text).toBe('other thread');
  });

  it('constructing the manager over existing rows wakes nothing — the boot rule', () => {
    const store = new SessionStore(':memory:');
    store.register(THREAD, CHANNEL, USER);
    store.setSessionId(THREAD, CHANNEL, 'sess-survivor');
    let spawned = 0;

    const manager = new SessionManager({
      store,
      spawn: () => {
        spawned += 1;
        return new FakeProcess();
      },
      voiceFor: () => new FakeVoice(),
      notify: () => Promise.resolve(),
      costThresholdsUsd: [5, 10],
      warmTtlMs: TTL,
      liveSessionCap: 5,
      autoCloseAfterMs: 7 * DAY,
      listDelegations: () => Promise.resolve([]),
      onTurnStart: () => Promise.resolve(),
      onTurnEnd: () => Promise.resolve(),
      logger: createLogger('silent'),
    });

    expect(spawned).toBe(0);
    expect(manager.liveProcessCount()).toBe(0);
  });

  it('a failed turn tells the thread, drops the process, and does not count the turn', async () => {
    const { manager, store, spawns, voices } = makeHarness((_text, events) => {
      events.onSessionId('sess-1');
      return { status: 'error', errors: ['boom'] };
    });

    manager.open(THREAD, CHANNEL, USER, 'explode');
    await flush();

    expect(voices[0]?.streamed).toContain('⚠️');
    expect(voices[0]?.finalized).toBe(true);
    expect(store.get(THREAD, CHANNEL)?.turnCount).toBe(0);
    expect(store.get(THREAD, CHANNEL)?.costUsdTotal).toBe(0);
    expect(spawns[0]?.proc.ended).toBe(true);
    expect(manager.liveProcessCount()).toBe(0);
  });

  it('a turn whose process dies mid-flight surfaces a warning and goes dormant', async () => {
    const { manager, spawns, voices } = makeHarness(() => ({ status: 'process_ended' }));

    manager.open(THREAD, CHANNEL, USER, 'die');
    await flush();

    expect(voices[0]?.streamed).toContain('⚠️');
    expect(manager.liveProcessCount()).toBe(0);
    expect(spawns).toHaveLength(1);
  });

  it('uses the result text as the voice fallback when no deltas streamed', async () => {
    const { manager, voices } = makeHarness(() => ({
      status: 'success',
      resultText: 'quiet but done',
      costUsd: 0,
    }));

    manager.open(THREAD, CHANNEL, USER, 'silent turn');
    await flush();

    expect(voices[0]?.streamed).toBe('');
    expect(voices[0]?.fallback).toBe('quiet but done');
  });
});

describe('SessionManager cost ledger (spec §7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Each turn costs the next amount from `costs` — the demo's long conversation. */
  const costlyScript = (costs: number[]) => (_text: string, events: TurnEvents) => {
    events.onSessionId('sess-cost');
    return { status: 'success', resultText: 'ok', costUsd: costs.shift() ?? 0 } as const;
  };

  it('every completed turn accumulates its SDK-reported cost into the ledger', async () => {
    const { manager, store, notices } = makeHarness(costlyScript([1.25, 1.25]));

    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.reply(THREAD, CHANNEL, 'second');
    await flush();

    expect(store.get(THREAD, CHANNEL)?.costUsdTotal).toBeCloseTo(2.5);
    expect(notices).toHaveLength(0);
  });

  it('crossing $5 posts the 💸 mock verbatim exactly once — no repeat on later turns', async () => {
    const { manager, notices } = makeHarness(costlyScript([4.2, 0.83, 2]));

    manager.open(THREAD, CHANNEL, USER, 'turn 1');
    await flush();
    expect(notices).toHaveLength(0);

    manager.reply(THREAD, CHANNEL, 'turn 2');
    await flush();
    expect(notices).toHaveLength(1);
    // The verbatim itself is pinned once, in messages.test.ts (scenario D).
    expect(notices[0]?.threadTs).toBe(THREAD);
    expect(notices[0]?.text).toContain('*$5.03* ($5 threshold crossed)');
    expect(notices[0]?.text).toContain('Next warning at $10.');

    manager.reply(THREAD, CHANNEL, 'turn 3');
    await flush();
    expect(notices).toHaveLength(1);
  });

  it('crossing $10 posts its own one-shot warning, with no further threshold to announce', async () => {
    const { manager, notices } = makeHarness(costlyScript([6, 5]));

    manager.open(THREAD, CHANNEL, USER, 'turn 1');
    await flush();
    manager.reply(THREAD, CHANNEL, 'turn 2');
    await flush();

    expect(notices).toHaveLength(2);
    expect(notices[1]?.text).toContain('($10 threshold crossed)');
    expect(notices[1]?.text).not.toContain('Next warning');
  });

  it('a single expensive turn that jumps both thresholds warns for each, in order', async () => {
    const { manager, notices } = makeHarness(costlyScript([12]));

    manager.open(THREAD, CHANNEL, USER, 'big turn');
    await flush();

    expect(notices.map((n) => n.text)).toEqual([
      expect.stringContaining('*$12.00* ($5 threshold crossed)'),
      expect.stringContaining('*$12.00* ($10 threshold crossed)'),
    ]);
    // $10 fired in the same turn, so neither line may promise it as "next".
    expect(notices[0]?.text).not.toContain('Next warning');
    expect(notices[1]?.text).not.toContain('Next warning');
  });

  it('warnings are one-shot across restarts — the persisted total suppresses re-firing', async () => {
    const store = new SessionStore(':memory:');
    store.register(THREAD, CHANNEL, USER);
    store.setSessionId(THREAD, CHANNEL, 'sess-cost');
    store.recordTurn(THREAD, CHANNEL, 6.5); // $5 already warned before the restart

    const { manager, notices } = makeHarness(costlyScript([1, 3]), { store });

    manager.reply(THREAD, CHANNEL, 'after restart'); // total 7.5 — between thresholds
    await flush();
    expect(notices).toHaveLength(0);

    manager.reply(THREAD, CHANNEL, 'keeps going'); // total 10.5 — crosses $10 only
    await flush();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('($10 threshold crossed)');
  });

  it('measure-only: a failed warning post never blocks or fails the turn', async () => {
    const { manager, store, voices } = makeHarness(costlyScript([7]), {
      notify: () => Promise.reject(new Error('slack down')),
    });

    manager.open(THREAD, CHANNEL, USER, 'expensive turn');
    await flush();

    expect(voices[0]?.finalized).toBe(true);
    const row = store.get(THREAD, CHANNEL);
    expect(row?.turnCount).toBe(1);
    expect(row?.costUsdTotal).toBeCloseTo(7);
  });
});

describe('SessionManager live-session cap (spec §3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Every thread gets its own session_id so cold-resumes are traceable. */
  const perThreadScript = (text: string, events: TurnEvents): TurnOutcome => {
    events.onSessionId(`sess-${text}`);
    return { status: 'success', resultText: `echo: ${text}`, costUsd: 0 };
  };

  it('at the cap, silently reaps the coldest finished-turn session to make room', async () => {
    const { manager, spawns, notices } = makeHarness(perThreadScript, { cap: 2 });

    manager.open(THREAD, CHANNEL, USER, 'one');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    manager.open(THREAD_2, CHANNEL, USER, 'two');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);

    manager.open(THREAD_3, CHANNEL, USER, 'three');
    await flush();

    expect(spawns).toHaveLength(3);
    expect(spawns[0]?.proc.ended).toBe(true); // the coldest — reaped
    expect(spawns[1]?.proc.ended).toBe(false); // warmer — kept
    expect(manager.liveProcessCount()).toBe(2);
    expect(notices).toHaveLength(0); // reaping is silent, no ⏳
  });

  it('a reaped session cold-resumes from its persisted session_id — nothing lost', async () => {
    const { manager, spawns } = makeHarness(perThreadScript, { cap: 2 });
    manager.open(THREAD, CHANNEL, USER, 'one');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    manager.open(THREAD_2, CHANNEL, USER, 'two');
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    manager.open(THREAD_3, CHANNEL, USER, 'three'); // reaps THREAD
    await flush();
    await vi.advanceTimersByTimeAsync(1000);

    manager.reply(THREAD, CHANNEL, 'back again'); // reaps the next-coldest
    await flush();

    expect(spawns).toHaveLength(4);
    expect(spawns[3]?.resumeSessionId).toBe('sess-one');
    expect(manager.liveProcessCount()).toBe(2);
  });

  it('never reaps a mid-turn session: the message queues with the ⏳ line, then runs when the turn ends', async () => {
    // A mid-turn session may be suspended on a 🚦 gate (spec §7) — reaping
    // it would kill the gate under the human's feet. cap=1, one busy thread.
    const { manager, spawns, notices } = makeHarness(undefined, { cap: 1 });
    manager.open(THREAD, CHANNEL, USER, 'busy');
    await flush();

    manager.open(THREAD_2, CHANNEL, USER, 'waiting');
    await flush();

    expect(spawns).toHaveLength(1); // no reap, no spawn
    expect(spawns[0]?.proc.ended).toBe(false);
    expect(notices).toEqual([
      {
        threadTs: THREAD_2,
        text: "⏳ Queued (1 active session) — I'll get to it as soon as a slot frees up.",
      },
    ]);

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'done', costUsd: 0 });
    await flush();

    expect(spawns).toHaveLength(2); // slot freed → the queued message ran
    expect(spawns[0]?.proc.ended).toBe(true); // by reaping the now-idle thread
    expect(spawns[1]?.proc.turns[0]?.text).toBe('waiting');
  });

  it('queued messages dequeue FIFO, in arrival order, and none is ever dropped', async () => {
    const { manager, spawns, notices } = makeHarness(undefined, { cap: 1 });
    manager.open(THREAD, CHANNEL, USER, 'busy');
    await flush();
    manager.open(THREAD_2, CHANNEL, USER, 'second');
    await flush();
    manager.open(THREAD_3, CHANNEL, USER, 'third');
    await flush();

    expect(notices.filter((n) => n.text.startsWith('⏳'))).toHaveLength(2);

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'ok', costUsd: 0 });
    await flush();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.proc.turns[0]?.text).toBe('second');

    spawns[1]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'ok', costUsd: 0 });
    await flush();
    expect(spawns).toHaveLength(3);
    expect(spawns[2]?.proc.turns[0]?.text).toBe('third');
  });

  it('a failed ⏳ post still leaves the message queued — it runs when a slot frees', async () => {
    const { manager, spawns } = makeHarness(undefined, {
      cap: 1,
      notify: () => Promise.reject(new Error('slack down')),
    });
    manager.open(THREAD, CHANNEL, USER, 'busy');
    await flush();
    manager.open(THREAD_2, CHANNEL, USER, 'waiting');
    await flush();

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'ok', costUsd: 0 });
    await flush();

    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.proc.turns[0]?.text).toBe('waiting');
  });
});

describe('SessionManager close (spec §3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const costedScript = (text: string, events: TurnEvents): TurnOutcome => {
    events.onSessionId('sess-1');
    return { status: 'success', resultText: `echo: ${text}`, costUsd: 1.25 };
  };

  it('explicit close posts the 🔚 summary from the ledger row and finalizes the session', async () => {
    const { manager, store, spawns, notices } = makeHarness(costedScript);
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.reply(THREAD, CHANNEL, 'second');
    await flush();

    const result = manager.close(THREAD, CHANNEL);
    await flush();

    expect(result).toBe('closing');
    expect(notices.at(-1)).toEqual({
      threadTs: THREAD,
      text:
        '🔚 Session closed.\n' +
        '• no delegations\n' +
        '• thread cost: $2.50 · 2 turns\n' +
        'Mention me on a new root message to start again.',
    });
    expect(store.get(THREAD, CHANNEL)?.status).toBe('closed');
    expect(spawns[0]?.proc.ended).toBe(true);
    expect(manager.liveProcessCount()).toBe(0);
  });

  it('the 🔚 summary names each ledger delegation with its outcome (issue #51)', async () => {
    const { manager, notices } = makeHarness(costedScript, {
      listDelegations: (threadTs) =>
        Promise.resolve(
          threadTs === THREAD
            ? ([
                {
                  repo: 'webapp',
                  issueNumber: 84,
                  worktreeName: 'webapp-84-csv-export',
                  taskId: 'task_a1',
                  status: 'completed',
                  issueUrl: 'https://github.com/acme/webapp/issues/84',
                },
                {
                  repo: 'notes',
                  issueNumber: 7,
                  worktreeName: null,
                  taskId: 'task_b2',
                  status: 'dispatched',
                },
              ] satisfies ClosingDelegation[])
            : [],
        ),
    });
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();

    manager.close(THREAD, CHANNEL);
    await flush();

    expect(notices.at(-1)?.text).toContain(
      '• ✅ <https://github.com/acme/webapp/issues/84|webapp#84>\n',
    );
    expect(notices.at(-1)?.text).toContain('• ⚙️ notes#7 — still in flight\n');
  });

  it('a failing outcome read never blocks the close', async () => {
    const { manager, store } = makeHarness(costedScript, {
      listDelegations: () => Promise.reject(new Error('orca down')),
    });
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();

    manager.close(THREAD, CHANNEL);
    await flush();

    expect(store.get(THREAD, CHANNEL)?.status).toBe('closed');
  });

  it('close during a turn waits for the turn to finish — never a mid-turn kill', async () => {
    const { manager, store, spawns, notices } = makeHarness();
    manager.open(THREAD, CHANNEL, USER, 'working');
    await flush();

    expect(manager.close(THREAD, CHANNEL)).toBe('closing');
    await flush();

    expect(store.get(THREAD, CHANNEL)?.status).toBe('open'); // turn still running
    expect(spawns[0]?.proc.ended).toBe(false);
    expect(notices).toHaveLength(0);

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'done', costUsd: 0 });
    await flush();

    expect(store.get(THREAD, CHANNEL)?.status).toBe('closed');
    expect(notices.at(-1)?.text).toContain('🔚 Session closed.');
    expect(spawns[0]?.proc.ended).toBe(true);
  });

  it('reply in a closed thread gets the fixed line — no resume, no state change', async () => {
    const { manager, store, spawns, notices } = makeHarness(costedScript);
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.close(THREAD, CHANNEL);
    await flush();
    const before = store.get(THREAD, CHANNEL);

    const result = manager.reply(THREAD, CHANNEL, 'and an XML version?');
    await flush();

    expect(result).toBe('closed');
    expect(notices.at(-1)).toEqual({
      threadTs: THREAD,
      text: 'Session closed. Mention me on a new root message to start again.',
    });
    expect(spawns).toHaveLength(1); // never a resume
    expect(store.get(THREAD, CHANNEL)).toEqual(before); // no state change
  });

  it('close on an already-closed thread posts the fixed line, nothing else', async () => {
    const { manager, notices } = makeHarness(costedScript);
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.close(THREAD, CHANNEL);
    await flush();
    const noticesBefore = notices.length;

    const result = manager.close(THREAD, CHANNEL);
    await flush();

    expect(result).toBe('closed');
    expect(notices).toHaveLength(noticesBefore + 1);
    expect(notices.at(-1)?.text).toBe(
      'Session closed. Mention me on a new root message to start again.',
    );
  });

  it('close in an unregistered thread does nothing', async () => {
    const { manager, notices } = makeHarness(costedScript);

    const result = manager.close(THREAD, CHANNEL);
    await flush();

    expect(result).toBe('unregistered');
    expect(notices).toHaveLength(0);
  });

  it('messages queued behind a close get one fixed line and never run', async () => {
    const { manager, spawns, notices } = makeHarness();
    manager.open(THREAD, CHANNEL, USER, 'working');
    await flush();
    manager.close(THREAD, CHANNEL);
    manager.reply(THREAD, CHANNEL, 'one more thing'); // sent before the close ran
    await flush();

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'done', costUsd: 0 });
    await flush();

    expect(spawns[0]?.proc.turns).toHaveLength(1); // the late message never became a turn
    expect(notices.at(-2)?.text).toContain('🔚 Session closed.');
    expect(notices.at(-1)?.text).toBe(
      'Session closed. Mention me on a new root message to start again.',
    );
  });

  it('closing a live session frees its slot for a queued message', async () => {
    const { manager, store, spawns } = makeHarness(undefined, { cap: 1 });
    manager.open(THREAD, CHANNEL, USER, 'busy');
    await flush();
    manager.open(THREAD_2, CHANNEL, USER, 'waiting');
    await flush();
    manager.close(THREAD, CHANNEL);
    await flush();

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'done', costUsd: 0 });
    await flush();

    expect(store.get(THREAD, CHANNEL)?.status).toBe('closed');
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.proc.turns[0]?.text).toBe('waiting');
  });

  it('a redelivered root mention on a closed thread gets the fixed line, never a fresh turn', async () => {
    const { manager, spawns, notices } = makeHarness(costedScript);
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.close(THREAD, CHANNEL);
    await flush();

    manager.open(THREAD, CHANNEL, USER, 'first'); // Slack redelivery
    await flush();

    expect(spawns).toHaveLength(1);
    expect(notices.at(-1)?.text).toBe(
      'Session closed. Mention me on a new root message to start again.',
    );
  });
});

describe('SessionManager auto-close sweep (spec §3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sessions dormant past the span auto-close with the dormancy 🔚 summary', async () => {
    const { manager, store, notices } = makeHarness(chattyScript('sess-1'), {
      autoCloseMs: 7 * DAY,
    });
    manager.open(THREAD, CHANNEL, USER, 'hello');
    await flush();

    await vi.advanceTimersByTimeAsync(7 * DAY + 60_000);
    const closed = await manager.sweepDormant();

    expect(closed).toBe(1);
    expect(store.get(THREAD, CHANNEL)?.status).toBe('closed');
    expect(notices.at(-1)?.text).toContain('🔚 Session closed — dormant for 7 days.');
    expect(manager.liveProcessCount()).toBe(0); // the warm TTL reaped it long ago
  });

  it('a session with recent activity is untouched', async () => {
    const { manager, store } = makeHarness(chattyScript('sess-1'), { autoCloseMs: 7 * DAY });
    manager.open(THREAD, CHANNEL, USER, 'hello');
    await flush();

    await vi.advanceTimersByTimeAsync(1 * DAY);
    const closed = await manager.sweepDormant();

    expect(closed).toBe(0);
    expect(store.get(THREAD, CHANNEL)?.status).toBe('open');
  });

  it('never closes a session with a turn in flight, even on a stale ledger row', async () => {
    // last_activity_at only moves when a turn completes — a week-later reply
    // whose first turn is still running must not be closed under the user.
    const { manager, store, spawns } = makeHarness(undefined, { autoCloseMs: 7 * DAY });
    manager.open(THREAD, CHANNEL, USER, 'long haul');
    await flush();

    await vi.advanceTimersByTimeAsync(8 * DAY);
    const closed = await manager.sweepDormant();

    expect(closed).toBe(0);
    expect(store.get(THREAD, CHANNEL)?.status).toBe('open');

    spawns[0]?.proc.turns[0]?.resolve({ status: 'success', resultText: 'done', costUsd: 0 });
    await flush();
    expect(store.get(THREAD, CHANNEL)?.turnCount).toBe(1); // the turn still landed
  });

  it('a failed turn still resets the dormancy clock — an erroring thread is not dormant', async () => {
    const { manager, store } = makeHarness(
      (_text, events) => {
        events.onSessionId('sess-1');
        return { status: 'error', errors: ['boom'] };
      },
      { autoCloseMs: 7 * DAY },
    );
    manager.open(THREAD, CHANNEL, USER, 'first try');
    await flush();

    await vi.advanceTimersByTimeAsync(6 * DAY);
    manager.reply(THREAD, CHANNEL, 'try again'); // fails too — but it IS activity
    await flush();
    await vi.advanceTimersByTimeAsync(2 * DAY); // 8 days since open, 2 since the reply

    expect(await manager.sweepDormant()).toBe(0);
    expect(store.get(THREAD, CHANNEL)?.status).toBe('open');
  });

  it('the dormancy summary names the actual span, not the configured minimum', async () => {
    const { manager, notices } = makeHarness(chattyScript('sess-1'), { autoCloseMs: 7 * DAY });
    manager.open(THREAD, CHANNEL, USER, 'hello');
    await flush();

    await vi.advanceTimersByTimeAsync(30 * DAY); // e.g. the daemon was down a while
    await manager.sweepDormant();

    expect(notices.at(-1)?.text).toContain('🔚 Session closed — dormant for 30 days.');
  });

  it('a reply after auto-close gets the fixed line — dormancy closes are final too', async () => {
    const { manager, notices, spawns } = makeHarness(chattyScript('sess-1'), {
      autoCloseMs: 7 * DAY,
    });
    manager.open(THREAD, CHANNEL, USER, 'hello');
    await flush();
    await vi.advanceTimersByTimeAsync(7 * DAY + 60_000);
    await manager.sweepDormant();

    const result = manager.reply(THREAD, CHANNEL, 'still there?');
    await flush();

    expect(result).toBe('closed');
    expect(spawns).toHaveLength(1);
    expect(notices.at(-1)?.text).toBe(
      'Session closed. Mention me on a new root message to start again.',
    );
  });
});

describe('SessionManager turn-lifecycle root ack (issue #49)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acks the turn start before the turn runs — 👀 lands before any reply text', async () => {
    const order: string[] = [];
    const { manager, turnEnds } = makeHarness(
      (text, events) => {
        order.push(`turn:${text}`);
        events.onSessionId('sess-1');
        return { status: 'success', resultText: 'ok', costUsd: 0 };
      },
      {
        onTurnStart: (threadTs) => {
          order.push(`start:${threadTs}`);
          return Promise.resolve();
        },
      },
    );

    manager.open(THREAD, CHANNEL, USER, 'hello');
    await flush();

    expect(order).toEqual([`start:${THREAD}`, 'turn:hello']);
    expect(turnEnds).toEqual([THREAD]);
  });

  it('every turn kind acks — open, reply, and orchestration wake alike', async () => {
    const { manager, turnStarts, turnEnds } = makeHarness(chattyScript('sess-1'));

    manager.open(THREAD, CHANNEL, USER, 'open turn');
    await flush();
    manager.reply(THREAD, CHANNEL, 'reply turn');
    await flush();
    manager.wake(THREAD, CHANNEL, '[orchestration event] worker_done …');
    await flush();

    expect(turnStarts).toEqual([THREAD, THREAD, THREAD]);
    expect(turnEnds).toEqual([THREAD, THREAD, THREAD]);
  });

  it('settles the turn end after a failed turn too — the 👀 never sticks on an error', async () => {
    const { manager, turnEnds, voices } = makeHarness(() => ({
      status: 'error',
      errors: ['boom'],
    }));

    manager.open(THREAD, CHANNEL, USER, 'explode');
    await flush();

    expect(voices[0]?.finalized).toBe(true);
    expect(turnEnds).toEqual([THREAD]);
  });

  it('a failing ack never blocks the turn', async () => {
    const { manager, voices, turnEnds } = makeHarness(chattyScript('sess-1'), {
      onTurnStart: () => Promise.reject(new Error('slack down')),
    });

    manager.open(THREAD, CHANNEL, USER, 'hello');
    await flush();

    expect(voices[0]?.finalized).toBe(true);
    expect(turnEnds).toEqual([THREAD]);
  });

  it('a failing settle never blocks the drain — the next turn still runs', async () => {
    const { manager, spawns, voices } = makeHarness(chattyScript('sess-1'), {
      onTurnEnd: () => Promise.reject(new Error('slack down')),
    });

    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();
    manager.reply(THREAD, CHANNEL, 'second');
    await flush();

    expect(spawns).toHaveLength(1);
    expect(voices).toHaveLength(2);
    expect(voices[1]?.finalized).toBe(true);
  });

  it('a message queued at the cap still acks immediately — 👀 within seconds, not when a slot frees', async () => {
    const { manager, turnStarts, spawns } = makeHarness(undefined, { cap: 1 });
    manager.open(THREAD, CHANNEL, USER, 'busy');
    await flush();

    manager.open(THREAD_2, CHANNEL, USER, 'waiting');
    await flush();

    expect(spawns).toHaveLength(1); // THREAD_2 still waits for a slot…
    expect(turnStarts).toEqual([THREAD, THREAD_2]); // …but its 👀 already landed
  });
});

describe('SessionManager orchestration wakes (spec §6, issue #20)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('wakes an open thread with a turn through the same pipe as a human message', async () => {
    const { manager, spawns } = makeHarness(chattyScript('sess-1'));
    manager.open(THREAD, CHANNEL, USER, 'delegate this');
    await flush();

    const result = manager.wake(THREAD, CHANNEL, '[orchestration event] worker_done …');
    await flush();

    expect(result).toBe('turn');
    expect(spawns).toHaveLength(1); // warm process reused — same pipe, next turn
  });

  it('wakes a dormant thread by cold-resuming its persisted session', async () => {
    const { manager, store, spawns } = makeHarness(chattyScript('sess-1'));
    manager.open(THREAD, CHANNEL, USER, 'delegate this');
    await flush();
    await vi.advanceTimersByTimeAsync(TTL + 1); // warmth TTL — session dozes off

    const result = manager.wake(THREAD, CHANNEL, '[orchestration event] worker_done …');
    await flush();

    expect(result).toBe('turn');
    expect(store.get(THREAD, CHANNEL)?.turnCount).toBe(2);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.resumeSessionId).toBe('sess-1');
  });

  it('skips a closed thread silently — no turn, no fixed line', async () => {
    const { manager, spawns, notices } = makeHarness(chattyScript('sess-1'));
    manager.open(THREAD, CHANNEL, USER, 'delegate this');
    await flush();
    manager.close(THREAD, CHANNEL);
    await flush();
    const before = notices.length;

    const result = manager.wake(THREAD, CHANNEL, '[orchestration event] worker_done …');
    await flush();

    expect(result).toBe('skipped');
    expect(spawns).toHaveLength(1);
    expect(notices).toHaveLength(before);
  });

  it('skips an unregistered thread — never a ghost session', async () => {
    const { manager, spawns } = makeHarness(chattyScript('sess-1'));

    const result = manager.wake(THREAD, CHANNEL, '[orchestration event] worker_done …');
    await flush();

    expect(result).toBe('skipped');
    expect(spawns).toHaveLength(0);
  });
});

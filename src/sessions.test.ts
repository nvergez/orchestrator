import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.ts';
import { SessionStore } from './db.ts';
import {
  SessionManager,
  type Notifier,
  type OrchestratorProcess,
  type TurnEvents,
  type TurnOutcome,
} from './sessions.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0ASJR3LAE6';
const USER = 'U09CC6M3W1W';
const TTL = 30 * 60_000;

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
}

const makeHarness = (
  script?: (text: string, events: TurnEvents) => TurnOutcome,
  options: { store?: SessionStore; notify?: Notifier } = {},
): Harness => {
  const store = options.store ?? new SessionStore(':memory:');
  const spawns: Harness['spawns'] = [];
  const voices: FakeVoice[] = [];
  const notices: Harness['notices'] = [];
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
    logger: createLogger('silent'),
  });
  return { manager, store, spawns, voices, notices };
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

    const handled = manager.reply(THREAD, CHANNEL, 'sneaky resume');
    await flush();

    expect(handled).toBe(false);
    expect(spawns).toHaveLength(0);
  });

  it('reply within the warmth TTL reuses the live process', async () => {
    const { manager, spawns } = makeHarness(chattyScript('sess-1'));
    manager.open(THREAD, CHANNEL, USER, 'first');
    await flush();

    const handled = manager.reply(THREAD, CHANNEL, 'second');
    await flush();

    expect(handled).toBe(true);
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

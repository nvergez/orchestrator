import type { Logger } from './logger.ts';
import type { SessionStore } from './db.ts';
import { crossedThresholds } from './cost.ts';
import { costWarningLine } from './messages.ts';

/**
 * The session manager — one Claude Code session per Slack thread (spec §3).
 * Guiding principle: process liveness ≠ session existence. The SQLite row and
 * its `session_id` are the durable session; the subprocess behind
 * `OrchestratorProcess` is a transient warm cache that this manager spawns,
 * reuses within the warmth TTL, and ends without ceremony.
 */

/** What a running turn reports back as it streams. */
export interface TurnEvents {
  onDelta(text: string): void;
  onSessionId(sessionId: string): void;
}

export type TurnOutcome =
  /** `costUsd` is this turn's SDK-reported cost, feeding the ledger (spec §7). */
  | { status: 'success'; resultText: string; costUsd: number }
  | { status: 'error'; errors: string[] }
  /** The subprocess exited without delivering a result for this turn. */
  | { status: 'process_ended' };

/** One live Claude subprocess, warm across turns until `end()`. */
export interface OrchestratorProcess {
  runTurn(text: string, events: TurnEvents): Promise<TurnOutcome>;
  end(): Promise<void>;
}

export type ProcessFactory = (opts: {
  /** Persisted session_id to cold-resume, or null to open a fresh session. */
  resumeSessionId: string | null;
  /** The Slack thread this session speaks for — where its 🚦 gates post. */
  threadTs: string;
}) => OrchestratorProcess;

/** The slice of `Voice` the manager drives — one instance per turn. */
export interface VoiceHandle {
  append(delta: string): void;
  finalize(fallback?: string): Promise<void>;
}

export type VoiceFactory = (threadTs: string) => VoiceHandle;

/** Posts a standalone message to a thread — 💸 warnings "post the event" (spec §8). */
export type Notifier = (threadTs: string, text: string) => Promise<void>;

interface ThreadState {
  threadTs: string;
  channelId: string;
  queue: string[];
  running: boolean;
  proc: OrchestratorProcess | null;
  warmTimer: NodeJS.Timeout | null;
}

export interface SessionManagerOptions {
  store: SessionStore;
  spawn: ProcessFactory;
  voiceFor: VoiceFactory;
  notify: Notifier;
  /** Ascending USD totals at which to warn once each (spec §7, default 5 then 10). */
  costThresholdsUsd: number[];
  warmTtlMs: number;
  logger: Logger;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly spawn: ProcessFactory;
  private readonly voiceFor: VoiceFactory;
  private readonly notify: Notifier;
  private readonly costThresholdsUsd: number[];
  private readonly warmTtlMs: number;
  private readonly logger: Logger;
  private readonly threads = new Map<string, ThreadState>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.spawn = options.spawn;
    this.voiceFor = options.voiceFor;
    this.notify = options.notify;
    this.costThresholdsUsd = options.costThresholdsUsd;
    this.warmTtlMs = options.warmTtlMs;
    this.logger = options.logger;
    // Boot rule (spec §3): whatever the store holds comes back dormant.
    // Nothing here touches a process; the next human message resumes.
  }

  /** Root @mention: register the thread and run its first turn. */
  open(threadTs: string, channelId: string, rootUser: string, text: string): void {
    this.store.register(threadTs, channelId, rootUser);
    this.enqueue(threadTs, channelId, text);
  }

  /**
   * Reply in a thread: a turn iff the thread is registered and open.
   * Returns false for unregistered threads — never a ghost resume.
   */
  reply(threadTs: string, channelId: string, text: string): boolean {
    const row = this.store.get(threadTs, channelId);
    if (row === undefined || row.status !== 'open') return false;
    this.enqueue(threadTs, channelId, text);
    return true;
  }

  /** Warm subprocesses currently alive (the global-cap slice builds on this). */
  liveProcessCount(): number {
    let count = 0;
    for (const state of this.threads.values()) {
      if (state.proc !== null) count += 1;
    }
    return count;
  }

  private enqueue(threadTs: string, channelId: string, text: string): void {
    const key = `${channelId}:${threadTs}`;
    let state = this.threads.get(key);
    if (state === undefined) {
      state = { threadTs, channelId, queue: [], running: false, proc: null, warmTimer: null };
      this.threads.set(key, state);
    }
    state.queue.push(text);
    if (state.warmTimer !== null) {
      clearTimeout(state.warmTimer);
      state.warmTimer = null;
    }
    if (!state.running) {
      state.running = true;
      this.drain(state).catch((error: unknown) => {
        this.logger.error({ err: error, threadTs }, 'thread drain loop crashed');
        state.running = false;
      });
    }
  }

  /** FIFO per thread (spec §3): strictly one turn in flight, queue the rest. */
  private async drain(state: ThreadState): Promise<void> {
    try {
      for (let text = state.queue.shift(); text !== undefined; text = state.queue.shift()) {
        await this.runOneTurn(state, text);
      }
    } finally {
      state.running = false;
      if (state.proc !== null) this.armWarmTimer(state);
    }
  }

  private async runOneTurn(state: ThreadState, text: string): Promise<void> {
    if (state.proc === null) {
      const row = this.store.get(state.threadTs, state.channelId);
      const resumeSessionId = row?.sessionId ?? null;
      this.logger.info(
        { threadTs: state.threadTs, resumeSessionId },
        resumeSessionId === null ? 'opening session' : 'cold-resuming session',
      );
      state.proc = this.spawn({ resumeSessionId, threadTs: state.threadTs });
    }

    const voice = this.voiceFor(state.threadTs);
    let outcome: TurnOutcome;
    try {
      outcome = await state.proc.runTurn(text, {
        onDelta: (delta) => voice.append(delta),
        onSessionId: (sessionId) =>
          this.store.setSessionId(state.threadTs, state.channelId, sessionId),
      });
    } catch (error) {
      this.logger.error({ err: error, threadTs: state.threadTs }, 'turn threw');
      outcome = { status: 'error', errors: [String(error)] };
    }

    if (outcome.status === 'success') {
      const beforeUsd = this.store.get(state.threadTs, state.channelId)?.costUsdTotal ?? 0;
      this.store.recordTurn(state.threadTs, state.channelId, outcome.costUsd);
      await voice.finalize(outcome.resultText);
      await this.warnOnCostThresholds(state, beforeUsd);
      return;
    }

    // Failed or orphaned turn: say so in the thread, drop the process, and
    // wait for the next human message (spec §3 — no auto-retry).
    const reason =
      outcome.status === 'error'
        ? `⚠️ Turn failed (${outcome.errors.join('; ')}) — reply to retry.`
        : '⚠️ The session process ended unexpectedly — reply to resume.';
    this.logger.warn({ threadTs: state.threadTs, outcome }, 'turn did not complete');
    voice.append(reason);
    await voice.finalize();
    await this.dropProcess(state);
  }

  /**
   * 💸 threshold warnings (spec §7/§8): compare the persisted total before
   * and after the turn — a threshold fires exactly when the total reaches
   * it, so each fires once per session, restarts included. Measure-only: a
   * failed post is logged and forgotten, the session never blocks on cost.
   */
  private async warnOnCostThresholds(state: ThreadState, beforeUsd: number): Promise<void> {
    const afterUsd = this.store.get(state.threadTs, state.channelId)?.costUsdTotal ?? beforeUsd;
    for (const threshold of crossedThresholds(beforeUsd, afterUsd, this.costThresholdsUsd)) {
      // "Next warning at $N" must be a live promise: when one turn jumps
      // several thresholds at once, don't announce one that just fired too.
      const next = this.costThresholdsUsd.find((t) => t > threshold && t > afterUsd);
      this.logger.info(
        { threadTs: state.threadTs, threshold, costUsdTotal: afterUsd },
        'cost threshold crossed',
      );
      try {
        await this.notify(state.threadTs, costWarningLine(afterUsd, threshold, next));
      } catch (error) {
        this.logger.warn(
          { err: error, threadTs: state.threadTs, threshold },
          'cost warning post failed',
        );
      }
    }
  }

  private armWarmTimer(state: ThreadState): void {
    state.warmTimer = setTimeout(() => {
      state.warmTimer = null;
      if (state.running || state.proc === null) return;
      this.logger.info({ threadTs: state.threadTs }, 'warmth TTL expired, session dormant');
      void this.dropProcess(state);
    }, this.warmTtlMs);
    state.warmTimer.unref();
  }

  private async dropProcess(state: ThreadState): Promise<void> {
    const proc = state.proc;
    state.proc = null;
    if (proc === null) return;
    try {
      await proc.end();
    } catch (error) {
      this.logger.warn({ err: error, threadTs: state.threadTs }, 'process end failed');
    }
  }
}

import type { Logger } from './logger.ts';
import type { SessionRow, SessionStore } from './db.ts';
import { DAY_MS } from './config.ts';
import { crossedThresholds } from './cost.ts';
import {
  CLOSED_THREAD_LINE,
  closingSummary,
  costWarningLine,
  queuedLine,
} from './messages.ts';

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

/** A thread's FIFO carries turns and, terminally, the close command (spec §3). */
type QueueItem = { kind: 'turn'; text: string } | { kind: 'close' };

interface ThreadState {
  threadTs: string;
  channelId: string;
  queue: QueueItem[];
  running: boolean;
  proc: OrchestratorProcess | null;
  warmTimer: NodeJS.Timeout | null;
  /** When the last drain finished — the reaping order at the cap (coldest first). */
  warmSince: number;
}

export type ReplyResult = 'turn' | 'closed' | 'unregistered';

export type CloseResult = 'closing' | 'closed' | 'unregistered';

export interface SessionManagerOptions {
  store: SessionStore;
  spawn: ProcessFactory;
  voiceFor: VoiceFactory;
  notify: Notifier;
  /** Ascending USD totals at which to warn once each (spec §7, default 5 then 10). */
  costThresholdsUsd: number[];
  warmTtlMs: number;
  /** Global cap on live sessions — dormant ones don't count (spec §3, default 5). */
  liveSessionCap: number;
  /** Dormancy span after which `sweepDormant` closes a session (spec §3, 7 days). */
  autoCloseAfterMs: number;
  /** The thread's delegation count from the #19 ledger — the 🔚 summary's number. */
  countDelegations: (threadTs: string) => number;
  logger: Logger;
}

export class SessionManager {
  private readonly store: SessionStore;
  private readonly spawn: ProcessFactory;
  private readonly voiceFor: VoiceFactory;
  private readonly notify: Notifier;
  private readonly costThresholdsUsd: number[];
  private readonly warmTtlMs: number;
  private readonly liveSessionCap: number;
  private readonly autoCloseAfterMs: number;
  private readonly countDelegations: (threadTs: string) => number;
  private readonly logger: Logger;
  private readonly threads = new Map<string, ThreadState>();
  /**
   * Live sessions = threads holding a subprocess. `pendingSpawns` reserves
   * the async gap between winning a slot and the spawn landing, so a burst
   * of simultaneous messages can never overshoot the cap.
   */
  private pendingSpawns = 0;
  /** Threads waiting for a slot, FIFO — queued messages run in arrival order. */
  private readonly slotWaiters: Array<() => void> = [];
  private sweeping = false;

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.spawn = options.spawn;
    this.voiceFor = options.voiceFor;
    this.notify = options.notify;
    this.costThresholdsUsd = options.costThresholdsUsd;
    this.warmTtlMs = options.warmTtlMs;
    this.liveSessionCap = options.liveSessionCap;
    this.autoCloseAfterMs = options.autoCloseAfterMs;
    this.countDelegations = options.countDelegations;
    this.logger = options.logger;
    // Boot rule (spec §3): whatever the store holds comes back dormant.
    // Nothing here touches a process; the next human message resumes.
  }

  /** Root @mention: register the thread and run its first turn. */
  open(threadTs: string, channelId: string, rootUser: string, text: string): void {
    this.store.register(threadTs, channelId, rootUser);
    // A redelivered root mention can land on an already-closed row; closed
    // is final (spec §3), so it gets the fixed line, never a fresh turn.
    if (this.store.get(threadTs, channelId)?.status === 'closed') {
      this.postClosedLine(threadTs);
      return;
    }
    this.enqueue(threadTs, channelId, { kind: 'turn', text });
  }

  /**
   * Reply in a thread: a turn iff the thread is registered and open.
   * Unregistered threads stay untouched — never a ghost resume — and a
   * closed thread answers with the fixed line only (spec §3).
   */
  reply(threadTs: string, channelId: string, text: string): ReplyResult {
    const row = this.store.get(threadTs, channelId);
    if (row === undefined) return 'unregistered';
    if (row.status === 'closed') {
      this.postClosedLine(threadTs);
      return 'closed';
    }
    this.enqueue(threadTs, channelId, { kind: 'turn', text });
    return 'turn';
  }

  /**
   * `@orchestrator close` (spec §3): queued FIFO like any message, so an
   * in-flight turn — including one suspended on a 🚦 gate — always settles
   * before the session is finalized; a session is never killed mid-turn.
   */
  close(threadTs: string, channelId: string): CloseResult {
    const row = this.store.get(threadTs, channelId);
    if (row === undefined) return 'unregistered';
    if (row.status === 'closed') {
      this.postClosedLine(threadTs);
      return 'closed';
    }
    this.enqueue(threadTs, channelId, { kind: 'close' });
    return 'closing';
  }

  /**
   * The dormancy sweep (spec §3): auto-close open sessions past the
   * configured span. Anything showing signs of life right now — a live
   * process, a running turn, queued messages — is skipped: last_activity_at
   * only moves when a turn completes, so a first-turn-after-a-week must not
   * be closed under the user's feet.
   */
  async sweepDormant(): Promise<number> {
    // Re-entry guard: a sweep slower than its interval (Slack hiccups) must
    // not overlap the next one and double-post 🔚 summaries.
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const cutoff = new Date(Date.now() - this.autoCloseAfterMs).toISOString();
      let closed = 0;
      for (const row of this.store.openSessionsInactiveSince(cutoff)) {
        const state = this.threads.get(threadKey(row.threadTs, row.channelId));
        if (
          state !== undefined &&
          (state.running || state.proc !== null || state.queue.length > 0)
        ) {
          continue;
        }
        this.store.closeSession(row.threadTs, row.channelId);
        closed += 1;
        this.logger.info(
          { threadTs: row.threadTs, lastActivityAt: row.lastActivityAt },
          'auto-closed dormant session',
        );
        // The summary names the *actual* dormancy — a session swept after a
        // long daemon outage says so, not the configured minimum.
        const dormantDays = Math.round((Date.now() - Date.parse(row.lastActivityAt)) / DAY_MS);
        await this.postClosingSummary(row, dormantDays);
      }
      return closed;
    } finally {
      this.sweeping = false;
    }
  }

  /** Warm subprocesses currently alive (the global-cap slice builds on this). */
  liveProcessCount(): number {
    let count = 0;
    for (const state of this.threads.values()) {
      if (state.proc !== null) count += 1;
    }
    return count;
  }

  /** Closed is final (spec §3): the fixed line, no resume, no state change. */
  private postClosedLine(threadTs: string): void {
    this.notify(threadTs, CLOSED_THREAD_LINE).catch((error: unknown) => {
      this.logger.warn({ err: error, threadTs }, 'closed-thread line post failed');
    });
  }

  /** Posts the 🔚 summary from the ledger row; a failed post never blocks the close. */
  private async postClosingSummary(row: SessionRow, dormantDays?: number): Promise<void> {
    try {
      await this.notify(
        row.threadTs,
        closingSummary({
          delegations: this.countDelegations(row.threadTs),
          costUsd: row.costUsdTotal,
          turnCount: row.turnCount,
          dormantDays,
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs: row.threadTs },
        '🔚 closing summary post failed',
      );
    }
  }

  private enqueue(threadTs: string, channelId: string, item: QueueItem): void {
    const key = threadKey(threadTs, channelId);
    let state = this.threads.get(key);
    if (state === undefined) {
      state = {
        threadTs,
        channelId,
        queue: [],
        running: false,
        proc: null,
        warmTimer: null,
        warmSince: 0,
      };
      this.threads.set(key, state);
    }
    state.queue.push(item);
    this.clearWarmTimer(state);
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
      for (let item = state.queue.shift(); item !== undefined; item = state.queue.shift()) {
        if (item.kind === 'close') await this.runClose(state);
        else await this.runOneTurn(state, item.text);
      }
    } finally {
      state.running = false;
      state.warmSince = Date.now();
      if (state.proc !== null) this.armWarmTimer(state);
      // The finished drain may have freed a slot — or made this thread the
      // reapable one a queued message was waiting for.
      this.wakeWaiters();
    }
  }

  /**
   * Takes one of the `liveSessionCap` slots before a spawn (spec §3). Fast
   * path: capacity left, or a coldest finished-turn session to reap. Slow
   * path: every live session is mid-turn — never a hard reject, so the
   * thread posts the ⏳ line and waits, FIFO, until a slot frees.
   */
  private async acquireSlot(state: ThreadState): Promise<void> {
    if (this.slotWaiters.length === 0 && this.tryReserveSlotOrReap()) return;
    // Register the waiter before the ⏳ post: a slot freed while the post is
    // in flight must still find us in the line.
    const slot = new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.logger.info(
      { threadTs: state.threadTs, liveSessionCap: this.liveSessionCap },
      'live-session cap reached, all sessions mid-turn — message queued',
    );
    try {
      await this.notify(
        state.threadTs,
        queuedLine(this.liveProcessCount() + this.pendingSpawns),
      );
    } catch (error) {
      this.logger.warn({ err: error, threadTs: state.threadTs }, '⏳ queued line post failed');
    }
    return slot;
  }

  /**
   * Claims capacity for one spawn. Under the cap: reserve. At the cap: reap
   * the coldest live session whose turn is finished — it gives up its
   * process and cold-resumes later from its persisted session_id, nothing
   * lost. A mid-turn session (running, possibly suspended on a 🚦 gate) is
   * never touched. The reaped subprocess winds down in the background: the
   * cap governs live sessions, not OS-level teardown.
   */
  private tryReserveSlotOrReap(): boolean {
    if (this.liveProcessCount() + this.pendingSpawns < this.liveSessionCap) {
      this.pendingSpawns += 1;
      return true;
    }
    let coldest: ThreadState | undefined;
    for (const candidate of this.threads.values()) {
      if (candidate.proc === null || candidate.running) continue;
      if (coldest === undefined || candidate.warmSince < coldest.warmSince) {
        coldest = candidate;
      }
    }
    if (coldest === undefined) return false;
    this.logger.info(
      { threadTs: coldest.threadTs },
      'live-session cap reached — reaping the coldest idle session',
    );
    this.clearWarmTimer(coldest);
    void this.dropProcess(coldest);
    this.pendingSpawns += 1;
    return true;
  }

  /**
   * Hands freed capacity to queued messages, FIFO. Called after anything
   * that could free a slot or leave a session reapable: a drain finishing,
   * a process dropping, a close. NOT called from within dropProcess — the
   * reap inside tryReserveSlot would recurse and over-hand slots.
   */
  private wakeWaiters(): void {
    while (this.slotWaiters.length > 0 && this.tryReserveSlotOrReap()) {
      this.slotWaiters.shift()?.();
    }
  }

  /**
   * The terminal close (spec §3), reached through the thread's FIFO. Posts
   * the 🔚 summary from the ledger row, flips the row, and releases the
   * process and its slot.
   */
  private async runClose(state: ThreadState): Promise<void> {
    const row = this.store.get(state.threadTs, state.channelId);
    if (row === undefined || row.status === 'closed') return;
    this.store.closeSession(state.threadTs, state.channelId);
    this.logger.info(
      { threadTs: state.threadTs, turnCount: row.turnCount, costUsdTotal: row.costUsdTotal },
      'session closed',
    );
    // Anything still queued behind the close was sent to a session that no
    // longer exists: drop it, answering turns once with the fixed line.
    const dropped = state.queue.splice(0);
    this.clearWarmTimer(state);
    const hadProc = state.proc !== null;
    void this.dropProcess(state);
    if (hadProc) this.wakeWaiters();
    await this.postClosingSummary(row);
    // Best-effort and independent of the summary post: a failed summary must
    // not swallow the dropped turns' fixed line, or vice versa.
    if (dropped.some((item) => item.kind === 'turn')) {
      this.postClosedLine(state.threadTs);
    }
  }

  private async runOneTurn(state: ThreadState, text: string): Promise<void> {
    if (state.proc === null) {
      await this.acquireSlot(state);
      const row = this.store.get(state.threadTs, state.channelId);
      const resumeSessionId = row?.sessionId ?? null;
      this.logger.info(
        { threadTs: state.threadTs, resumeSessionId },
        resumeSessionId === null ? 'opening session' : 'cold-resuming session',
      );
      try {
        state.proc = this.spawn({ resumeSessionId, threadTs: state.threadTs });
      } finally {
        this.pendingSpawns -= 1;
        // A throwing spawn releases its reserved slot to the next in line.
        if (state.proc === null) this.wakeWaiters();
      }
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
    // A failed turn is still human activity: reset the dormancy clock so the
    // sweep can't auto-close a thread whose last messages all errored.
    this.store.touch(state.threadTs, state.channelId);
    voice.append(reason);
    await voice.finalize();
    await this.dropProcess(state);
    this.wakeWaiters();
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

  private clearWarmTimer(state: ThreadState): void {
    if (state.warmTimer === null) return;
    clearTimeout(state.warmTimer);
    state.warmTimer = null;
  }

  private armWarmTimer(state: ThreadState): void {
    state.warmTimer = setTimeout(() => {
      state.warmTimer = null;
      if (state.running || state.proc === null) return;
      this.logger.info({ threadTs: state.threadTs }, 'warmth TTL expired, session dormant');
      void this.dropProcess(state);
      this.wakeWaiters();
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

function threadKey(threadTs: string, channelId: string): string {
  return `${channelId}:${threadTs}`;
}

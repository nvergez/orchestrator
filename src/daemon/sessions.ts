import type { Logger } from '../kernel/logger.ts';
import type { SessionRow, SessionStore } from './db.ts';
import { crossedThresholds } from './cost.ts';
import {
  CLOSED_THREAD_LINE,
  closingSummary,
  costWarningLine,
  queuedLine,
  type ClosingDelegation,
} from '../kernel/messages.ts';

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

export interface SessionTurn {
  text: string;
  images: Array<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    bytes: Uint8Array;
    label: string;
  }>;
}

const asTurn = (turn: string | SessionTurn): SessionTurn =>
  typeof turn === 'string' ? { text: turn, images: [] } : turn;

/** One live Claude subprocess, warm across turns until `end()`. */
export interface OrchestratorProcess {
  runTurn(turn: SessionTurn, events: TurnEvents): Promise<TurnOutcome>;
  end(): Promise<void>;
}

export type ProcessFactory = (opts: {
  /** Persisted session_id to cold-resume, or null to open a fresh session. */
  resumeSessionId: string | null;
  /** The Slack thread this session speaks for — where its 🚦 gates post. */
  threadTs: string;
  /** The thread's channel (issue #93) — the daemon serves several. */
  channelId: string;
}) => OrchestratorProcess;

/** The slice of `Voice` the manager drives — one instance per turn. */
export interface VoiceHandle {
  append(delta: string): void;
  finalize(fallback?: string): Promise<void>;
}

export type VoiceFactory = (threadTs: string, channelId: string) => VoiceHandle;

/** Posts a standalone message to a thread — 💸 warnings "post the event" (spec §8). */
export type Notifier = (threadTs: string, channelId: string, text: string) => Promise<void>;

/** Human bursts can share a turn; events and close remain FIFO boundaries. */
type TurnItem = { kind: 'turn'; turn: SessionTurn; source: 'human' | 'event'; receivedAt: number };
type QueueItem = TurnItem | { kind: 'close' };

const MAX_BATCH_MESSAGES = 20;
const MAX_BATCH_TEXT = 24_000;
const MAX_BATCH_IMAGES = 8;
const CLOSED_REMINDER_INTERVAL_MS = 60_000;

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
  /** Short, bounded collection window for human messages; default 750 ms. */
  messageBatchWindowMs?: number;
  /** Dormancy span after which `sweepDormant` closes a session (spec §3, 7 days). */
  autoCloseAfterMs: number;
  /** The thread's delegations from the #19 ledger, outcomes and issue links
   * resolved — the 🔚 summary's per-delegation lines (issue #51). */
  listDelegations: (threadTs: string, channelId: string) => Promise<ClosingDelegation[]>;
  /** Turn-start ack (issue #49): 👀 on the root before the turn produces
   * anything — awaited ahead of the slot wait so even a queued message acks
   * within seconds. */
  onTurnStart: (threadTs: string, channelId: string) => Promise<void>;
  /** Turn-end settle (issue #49): takes the 👀 back off when the turn left
   * nothing in flight and nothing pending. Runs on every outcome. */
  onTurnEnd: (threadTs: string, channelId: string) => Promise<void>;
  /** Downloads are activity too: never auto-close while preparing an input. */
  isPreparingTurn: (threadTs: string, channelId: string) => boolean;
  /** Runs on close, for explicit and dormant closes alike. */
  onClose: (threadTs: string, channelId: string) => Promise<void>;
  /**
   * Runs on an EXPLICIT close only (issue #120): a deliberately ended
   * conversation forces the memory pass at once, where a dormant sweep does
   * not — by the time a thread has been silent for a week, the pass ran days
   * ago. Awaited after the 🔚 summary and after the process and its slot are
   * already released, so the only thing it ever delays is bookkeeping.
   */
  onExplicitClose?: (threadTs: string, channelId: string) => Promise<void>;
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
  private readonly messageBatchWindowMs: number;
  private readonly autoCloseAfterMs: number;
  private readonly listDelegations: (
    threadTs: string,
    channelId: string,
  ) => Promise<ClosingDelegation[]>;
  private readonly onTurnStart: (threadTs: string, channelId: string) => Promise<void>;
  private readonly onTurnEnd: (threadTs: string, channelId: string) => Promise<void>;
  private readonly isPreparingTurn: SessionManagerOptions['isPreparingTurn'];
  private readonly onClose: SessionManagerOptions['onClose'];
  private readonly onExplicitClose: SessionManagerOptions['onExplicitClose'];
  private readonly logger: Logger;
  private readonly threads = new Map<string, ThreadState>();
  private readonly closedReminders = new Map<string, NodeJS.Timeout>();
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
    this.messageBatchWindowMs = options.messageBatchWindowMs ?? 750;
    this.autoCloseAfterMs = options.autoCloseAfterMs;
    this.listDelegations = options.listDelegations;
    this.onTurnStart = options.onTurnStart;
    this.onTurnEnd = options.onTurnEnd;
    this.onClose = options.onClose;
    this.onExplicitClose = options.onExplicitClose;
    this.isPreparingTurn = options.isPreparingTurn;
    this.logger = options.logger;
    // Boot rule (spec §3): whatever the store holds comes back dormant.
    // Nothing here touches a process; the next human message resumes.
  }

  status(threadTs: string, channelId: string): 'open' | 'closed' | 'unregistered' {
    return this.store.get(threadTs, channelId)?.status ?? 'unregistered';
  }

  /** Root @mention: register the thread and run its first turn. */
  open(threadTs: string, channelId: string, rootUser: string, turn: string | SessionTurn): void {
    this.store.register(threadTs, channelId, rootUser);
    // A redelivered root mention can land on an already-closed row; closed
    // is final (spec §3), so it gets the fixed line, never a fresh turn.
    if (this.store.get(threadTs, channelId)?.status === 'closed') {
      this.postClosedLine(threadTs, channelId);
      return;
    }
    this.enqueue(threadTs, channelId, { kind: 'turn', turn: asTurn(turn), source: 'human', receivedAt: Date.now() });
  }

  /**
   * Reply in a thread: a turn iff the thread is registered and open.
   * Unregistered threads stay untouched — never a ghost resume — and a
   * closed thread answers with the fixed line only (spec §3).
   */
  reply(threadTs: string, channelId: string, turn: string | SessionTurn): ReplyResult {
    const row = this.store.get(threadTs, channelId);
    if (row === undefined) return 'unregistered';
    if (row.status === 'closed') {
      this.postClosedLine(threadTs, channelId);
      return 'closed';
    }
    if (asTurn(turn).text.trim() !== '' || asTurn(turn).images.length > 0) {
      this.enqueue(threadTs, channelId, { kind: 'turn', turn: asTurn(turn), source: 'human', receivedAt: Date.now() });
    }
    return 'turn';
  }

  /**
   * Orchestration-event wake (spec §6): the event enters the SAME pipe as a
   * human message — same FIFO, same turn, same voice — so wakes stay
   * uniform. Unlike `reply` it is silent when the thread is closed or
   * unregistered: a worker completing under a closed thread is the daemon's
   * to surface (the card and reaction are already updated), and the fixed
   * closed-thread line would only confuse.
   */
  wake(threadTs: string, channelId: string, text: string): 'turn' | 'skipped' {
    const row = this.store.get(threadTs, channelId);
    if (row === undefined || row.status === 'closed') return 'skipped';
    this.enqueue(threadTs, channelId, { kind: 'turn', turn: asTurn(text), source: 'event', receivedAt: Date.now() });
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
      this.postClosedLine(threadTs, channelId);
      return 'closed';
    }
    this.enqueue(threadTs, channelId, { kind: 'close' });
    return 'closing';
  }

  /**
   * The dormancy sweep (spec §3): auto-close open sessions past the
   * configured span, silently — no 🔚 summary. Anything showing signs of life
   * right now — a live process, a running turn, queued messages — is skipped:
   * last_activity_at only moves when a turn completes, so a
   * first-turn-after-a-week must not be closed under the user's feet.
   */
  async sweepDormant(): Promise<number> {
    // Re-entry guard: a sweep slower than its interval (Slack hiccups) must
    // not overlap the next one and clean the same threads twice.
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      const cutoff = new Date(Date.now() - this.autoCloseAfterMs).toISOString();
      let closed = 0;
      for (const row of this.store.openSessionsInactiveSince(cutoff)) {
        if (this.isPreparingTurn(row.threadTs, row.channelId)) continue;
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
        // Silent by design: a dormant thread is closed for housekeeping, and a
        // 🔚 summary posted days after the last human word only re-pings the
        // thread. The explicit `close` still summarises.
        await this.cleanupThread(row);
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
  private postClosedLine(threadTs: string, channelId: string): void {
    const key = threadKey(threadTs, channelId);
    if (this.closedReminders.has(key)) return;
    // Reserve before the async post so simultaneous replies cannot each
    // announce the same closure. Expire entries even if no one replies again.
    const timer = setTimeout(() => this.closedReminders.delete(key), CLOSED_REMINDER_INTERVAL_MS);
    timer.unref();
    this.closedReminders.set(key, timer);
    this.notify(threadTs, channelId, CLOSED_THREAD_LINE).catch((error: unknown) => {
      if (this.closedReminders.get(key) === timer) {
        clearTimeout(timer);
        this.closedReminders.delete(key);
      }
      this.logger.warn({ err: error, threadTs }, 'closed-thread line post failed');
    });
  }

  /** Posts the 🔚 summary from the ledger row; a failed outcome read or post
   * never blocks the close. */
  private async postClosingSummary(row: SessionRow): Promise<void> {
    try {
      await this.notify(
        row.threadTs,
        row.channelId,
        closingSummary({
          delegations: await this.listDelegations(row.threadTs, row.channelId),
          costUsd: row.costUsdTotal,
          turnCount: row.turnCount,
        }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs: row.threadTs },
        '🔚 closing summary post failed',
      );
    }
    await this.cleanupThread(row);
  }

  /** Thread-scoped cleanup (attachments today); never fails a close. */
  private async cleanupThread(row: SessionRow): Promise<void> {
    await this.onClose(row.threadTs, row.channelId).catch((err: unknown) => {
      this.logger.warn({ err, threadTs: row.threadTs }, 'thread cleanup failed');
    });
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

  /** FIFO per thread: one turn in flight, consecutive human messages batched. */
  private async drain(state: ThreadState): Promise<void> {
    try {
      for (let item = state.queue.shift(); item !== undefined; item = state.queue.shift()) {
        if (item.kind === 'close') await this.runClose(state);
        else await this.runOneTurn(state, item);
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
        state.channelId,
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
    if (this.onExplicitClose !== undefined) {
      await this.onExplicitClose(state.threadTs, state.channelId).catch((error: unknown) => {
        this.logger.warn({ err: error, threadTs: state.threadTs }, 'explicit-close hook failed');
      });
    }
    // Best-effort and independent of the summary post: a failed summary must
    // not swallow the dropped turns' fixed line, or vice versa.
    if (dropped.some((item) => item.kind === 'turn')) {
      this.postClosedLine(state.threadTs, state.channelId);
    }
  }

  private async runOneTurn(state: ThreadState, item: TurnItem): Promise<void> {
    // A turn must be observable from start to finish (issue #39): a warm turn
    // used to emit nothing until completion, making "running" and "never
    // started" indistinguishable in the logs.
    const turnStartedAt = Date.now();
    this.logger.info(
      { threadTs: state.threadTs, mode: state.proc === null ? 'cold' : 'warm' },
      'turn started',
    );
    // The channel-level "I'm on it" (issue #49) — ahead of the slot wait, so
    // a message queued at the cap still acks within seconds of arriving.
    await this.hookSafe(this.onTurnStart, state, 'turn-start ack failed');
    try {
      await this.runTurnBody(state, item, turnStartedAt);
    } finally {
      // Every outcome settles the root (issue #49): a pure Q&A turn takes
      // its 👀 back off; a turn that left work in flight leaves the root to
      // the milestone/gate/done flips that own it.
      await this.hookSafe(this.onTurnEnd, state, 'turn-end settle failed');
    }
  }

  private async runTurnBody(state: ThreadState, item: TurnItem, turnStartedAt: number): Promise<void> {
    if (state.proc === null) {
      await this.acquireSlot(state);
      const row = this.store.get(state.threadTs, state.channelId);
      const resumeSessionId = row?.sessionId ?? null;
      this.logger.info(
        { threadTs: state.threadTs, resumeSessionId },
        resumeSessionId === null ? 'opening session' : 'cold-resuming session',
      );
      try {
        state.proc = this.spawn({
          resumeSessionId,
          threadTs: state.threadTs,
          channelId: state.channelId,
        });
      } finally {
        this.pendingSpawns -= 1;
        // A throwing spawn releases its reserved slot to the next in line.
        if (state.proc === null) this.wakeWaiters();
      }
    }

    // Collect after the slot wait and ack, right before input reaches Claude:
    // messages received during those waits must be part of the same decision.
    // The deadline is fixed at arrival, so continuous chatter cannot starve it.
    if (item.source === 'human') {
      const waitMs = item.receivedAt + this.messageBatchWindowMs - Date.now();
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    const turn = this.collectTurn(state, item);
    const voice = this.voiceFor(state.threadTs, state.channelId);
    let outcome: TurnOutcome;
    try {
      outcome = await state.proc.runTurn(turn, {
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
      this.logger.info(
        {
          threadTs: state.threadTs,
          status: outcome.status,
          durationMs: Date.now() - turnStartedAt,
          costUsd: outcome.costUsd,
        },
        'turn finished',
      );
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
    this.logger.warn(
      { threadTs: state.threadTs, outcome, durationMs: Date.now() - turnStartedAt },
      'turn did not complete',
    );
    // A failed turn is still human activity: reset the dormancy clock so the
    // sweep can't auto-close a thread whose last messages all errored.
    this.store.touch(state.threadTs, state.channelId);
    voice.append(reason);
    await voice.finalize();
    await this.dropProcess(state);
    this.wakeWaiters();
  }

  private collectTurn(state: ThreadState, first: TurnItem): SessionTurn {
    if (first.source === 'event') return first.turn;
    const turns = [first.turn];
    let textLength = first.turn.text.length;
    let imageCount = first.turn.images.length;
    while (turns.length < MAX_BATCH_MESSAGES) {
      const next = state.queue[0];
      if (next?.kind !== 'turn' || next.source !== 'human') break;
      if (textLength + next.turn.text.length > MAX_BATCH_TEXT ||
          imageCount + next.turn.images.length > MAX_BATCH_IMAGES) break;
      state.queue.shift();
      turns.push(next.turn);
      textLength += next.turn.text.length;
      imageCount += next.turn.images.length;
    }
    if (turns.length === 1) return first.turn;
    this.logger.info({ threadTs: state.threadTs, channelId: state.channelId, messages: turns.length }, 'human messages batched');
    return {
      text: '[Consecutive Slack messages, oldest first. Read the whole batch before acting; later clarifications can revise earlier requests. Respond once to the current request, and stay silent if this is only conversation between people.]\n\n' +
        turns.map((turn, index) => `[Message ${index + 1}]\n${turn.text}`).join('\n\n'),
      images: turns.flatMap((turn) => turn.images),
    };
  }

  /** Runs a turn-lifecycle hook; reactions are ambient state — a failing
   * hook is logged and never touches the turn (issue #49). */
  private async hookSafe(
    hook: (threadTs: string, channelId: string) => Promise<void>,
    state: ThreadState,
    failLine: string,
  ): Promise<void> {
    try {
      await hook(state.threadTs, state.channelId);
    } catch (error) {
      this.logger.warn({ err: error, threadTs: state.threadTs }, failLine);
    }
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
        await this.notify(
          state.threadTs,
          state.channelId,
          costWarningLine(afterUsd, threshold, next),
        );
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

import {
  completedCard,
  extractPullRequestLinks,
  worktreeKeptLine,
} from '../kernel/messages.ts';
import { execFileRunner, removeWorktree, type CommandRunner } from '../kernel/orca.ts';
import type { DelegationRow, PendingGateRow, StallAlertRow } from './delegations.ts';
import type { Logger } from '../kernel/logger.ts';

/**
 * The thread surface: the one module that owns what a Slack thread's root
 * message shows — the coarse-state root reactions and the delegation cards —
 * for the thread's whole lifecycle. Every emoji and final-card decision goes
 * through here; the coordinators (dispatch, watcher, watchdog, relay, boot
 * reconciliation) say what HAPPENED, and this module decides what the thread
 * SHOWS. Everything is best-effort: the surface is ambient state, never
 * worth failing an event over.
 */

/** The Slack adapter under the thread surface — what daemon.ts implements
 * over the Web API. Channel-addressed like the API itself (issue #93: the
 * daemon serves several channels); `ts === threadTs` addresses the root. */
export interface Surface {
  /** chat.postMessage into the thread; resolves with the message ts. */
  post(channelId: string, threadTs: string, text: string): Promise<string>;
  /** chat.update on an earlier message. */
  update(channelId: string, ts: string, text: string): Promise<void>;
  /** reactions.add on a message. */
  react(channelId: string, ts: string, name: string): Promise<void>;
  /** reactions.remove on a message. */
  unreact(channelId: string, ts: string, name: string): Promise<void>;
}

/** The registry slice the root-reaction rules read — the thread's in-flight
 * work and its pending gates and stall alerts. */
export interface ThreadStateStore {
  listPendingGates(threadTs: string, channelId: string): PendingGateRow[];
  listPendingStalls(threadTs: string, channelId: string): StallAlertRow[];
  listInFlightForThread(threadTs: string, channelId: string): DelegationRow[];
}

/**
 * The dispatch preamble's failure contract (issue #20): failure is still a
 * worker_done — a subject shaped "Failed: <reason>" is the only signal
 * there is. One predicate so the live watcher path and boot reconciliation
 * (issue #25) can never drift on what counts as a failure.
 */
export function isFailureSubject(subject: string): boolean {
  return /^fail/i.test(subject.trim());
}

/** The root reactions the daemon manages (spec §8) — one on, the rest off. */
const ROOT_REACTIONS = ['eyes', 'white_check_mark', 'x', 'question', 'rotating_light'] as const;

type RootReaction = (typeof ROOT_REACTIONS)[number];

export interface ThreadSurfaceOptions {
  surface: Surface;
  store: ThreadStateStore;
  logger: Logger;
  /** Injectable for tests: the success cleanup's `worktree rm` (issue #43). */
  run?: CommandRunner;
}

/**
 * The root-reaction state machine (spec §8), whole and in one place:
 *
 * - 🚨 outranks ❓ outranks 👀 while work is in flight — re-derived from the
 *   pending registries (gates and stall alerts) on every settle;
 * - ❌ lands immediately on a failure — the reaction is the CURRENT state,
 *   latest terminal event wins;
 * - ✅ lands only once the thread has nothing left in flight;
 * - 👀 is add-only when work starts (a turn opens, a worktree is created)
 *   and remove-only when a turn ends with nothing open — the flips above own
 *   every other transition.
 *
 * Plus the two other faces of the same thread: the delegation card's final
 * ✅/❌ flip (the durable home for links) and the delivered worktree's
 * cleanup with its 🧹 refusal line.
 */
export class ThreadSurface {
  private readonly surface: Surface;
  private readonly store: ThreadStateStore;
  private readonly logger: Logger;
  private readonly run: CommandRunner;

  constructor(options: ThreadSurfaceOptions) {
    this.surface = options.surface;
    this.store = options.store;
    this.logger = options.logger;
    this.run = options.run ?? execFileRunner;
  }

  /** chat.postMessage into the thread; resolves with the message ts. Throws
   * on a Slack failure — callers own their fallbacks. */
  post(channelId: string, threadTs: string, text: string): Promise<string> {
    return this.surface.post(channelId, threadTs, text);
  }

  /** chat.update on an earlier message. Throws on a Slack failure. */
  update(channelId: string, ts: string, text: string): Promise<void> {
    return this.surface.update(channelId, ts, text);
  }

  // ── root reactions ─────────────────────────────────────────────────────────

  /**
   * The add-only 👀 (issue #49): the channel-level "I'm on it" the moment
   * work starts — any turn beginning (session open included), or a worktree
   * created for a delegation. Deliberately no stale-reaction sweep: the
   * settle/done flips own every coarse-state transition, so a pending ❓/🚨
   * or an earlier ✅/❌ stays put next to the 👀. The usual failure is
   * Slack's already_reacted, when the 👀 is simply on.
   */
  async ackWorking(channelId: string, threadTs: string): Promise<void> {
    try {
      await this.surface.react(channelId, threadTs, 'eyes');
    } catch (error) {
      this.logger.debug({ err: error, threadTs }, 'working 👀 add failed (may already be set)');
    }
  }

  /**
   * The turn-end counterpart (issue #49): a turn that ends with no delegation
   * in flight and nothing pending leaves no state worth signalling, so its 👀
   * comes off — a pure Q&A thread reads clean from the channel. Anything still
   * open leaves the root alone: the flips that manage in-flight state already
   * put the honest reaction there. Only the 👀 is touched — a ✅/❌ from an
   * earlier delegation survives as the thread's durable outcome.
   */
  async settleTurnEnd(
    channelId: string,
    threadTs: string,
    /** Work the registries cannot see: a created-but-not-yet-dispatched
     * worktree (the coordinator's create→dispatch window) has a 👀-backed
     * card but no ledger row, and must keep its milestone 👀 on. */
    hasUndispatchedWork = false,
  ): Promise<void> {
    if (
      hasUndispatchedWork ||
      this.store.listInFlightForThread(threadTs, channelId).length > 0 ||
      this.store.listPendingGates(threadTs, channelId).length > 0 ||
      this.store.listPendingStalls(threadTs, channelId).length > 0
    ) {
      return;
    }
    try {
      await this.surface.unreact(channelId, threadTs, 'eyes');
    } catch (error) {
      // Usually Slack's no_reaction — a flip already took the 👀 off.
      this.logger.debug({ err: error, threadTs }, 'turn-end 👀 removal skipped');
    }
  }

  /**
   * The thread's honest coarse state while work is in flight, re-derived from
   * the registries and applied to the root (spec §8): 🚨 while an escalation
   * or a watchdog stall alert waits, ❓ while only questions do, 👀 otherwise.
   * The settle for every path where a pending set changed — a gate relayed or
   * answered, a stall alerted or nudged, a sibling done.
   */
  async settleRoot(channelId: string, threadTs: string): Promise<void> {
    const gates = this.store.listPendingGates(threadTs, channelId);
    const alarmed =
      gates.some((gate) => gate.kind === 'escalation') ||
      this.store.listPendingStalls(threadTs, channelId).length > 0;
    const name: RootReaction = alarmed ? 'rotating_light' : gates.length > 0 ? 'question' : 'eyes';
    await this.apply(channelId, threadTs, name);
  }

  /**
   * Spec §8 on a live worker_done: a failure surfaces as ❌ immediately; a
   * success flips the root to ✅ only once the thread has no other in-flight
   * work — with siblings still running, the registries decide the honest
   * state (👀, or ❓/🚨 while other gates or stall alerts wait — this is
   * also what clears a 🚨 whose stall alert the ledger close just settled).
   * Latest terminal event wins: a sibling success after a failure does
   * replace the ❌ — the failure keeps its ❌ card and its summary message
   * in the thread, which are the log; the root is not.
   */
  async settleWorkerDone(channelId: string, threadTs: string, failed: boolean): Promise<void> {
    if (failed) {
      await this.apply(channelId, threadTs, 'x');
      return;
    }
    if (this.store.listInFlightForThread(threadTs, channelId).length > 0) {
      await this.settleRoot(channelId, threadTs);
      return;
    }
    await this.apply(channelId, threadTs, 'white_check_mark');
  }

  /**
   * Spec §8 coarse state, boot reconciliation's batch flavor (issue #25):
   * any failure among the outage closures surfaces as ❌; all-clear flips to
   * ✅ only when the closures left the thread with nothing in flight;
   * otherwise the root is not touched — closed rows never re-arm a watcher,
   * and whatever state the thread showed stays until live events move it.
   */
  async settleReconciled(
    channelId: string,
    threadTs: string,
    closed: Array<'completed' | 'failed'>,
  ): Promise<void> {
    if (closed.includes('failed')) {
      await this.apply(channelId, threadTs, 'x');
    } else if (
      closed.length > 0 &&
      this.store.listInFlightForThread(threadTs, channelId).length === 0
    ) {
      await this.apply(channelId, threadTs, 'white_check_mark');
    }
  }

  /**
   * Adds the new root reaction, then clears the other managed ones — the
   * shared move behind every coarse-state swap. Both halves are best-effort:
   * an add usually fails as already_reacted, a removal as no_reaction (the
   * stale one simply wasn't set).
   */
  private async apply(channelId: string, threadTs: string, name: RootReaction): Promise<void> {
    try {
      await this.surface.react(channelId, threadTs, name);
    } catch (error) {
      this.logger.debug({ err: error, threadTs, name }, 'root reaction add failed');
    }
    for (const stale of ROOT_REACTIONS) {
      if (stale === name) continue;
      try {
        await this.surface.unreact(channelId, threadTs, stale);
      } catch (error) {
        this.logger.debug({ err: error, threadTs, stale }, 'stale reaction removal skipped');
      }
    }
  }

  // ── the ✅/❌ card ──────────────────────────────────────────────────────────

  /**
   * The delegation card's final ✅/❌ state — or a fresh post when no card
   * ever landed. Shared by the watcher's worker_done flip and boot
   * reconciliation's outage closures (issue #25); failure is signalled by
   * passing a `failureReason`.
   */
  async finishCard(
    row: DelegationRow,
    opts: {
      durationMs: number;
      issueUrl: string | undefined;
      /** Where the PR links come from — the worker's report, or empty. */
      reportText: string;
      failureReason?: string;
    },
  ): Promise<void> {
    const text = completedCard({
      repo: row.repo ?? 'work',
      issueNumber: row.issueNumber ?? 0,
      title: row.title ?? row.taskId,
      worktreePath: row.worktreePath,
      durationMs: opts.durationMs,
      issueUrl: opts.issueUrl,
      prLinks: extractPullRequestLinks(opts.reportText),
      ...(opts.failureReason !== undefined && { failureReason: opts.failureReason }),
    });
    try {
      if (row.cardTs === null) {
        await this.surface.post(row.channelId, row.threadTs, text);
      } else {
        await this.surface.update(row.channelId, row.cardTs, text);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs: row.threadTs, cardTs: row.cardTs },
        'final card edit failed',
      );
    }
  }

  // ── the delivered worktree ─────────────────────────────────────────────────

  /**
   * The success cleanup (issue #43): a delivered delegation's worktree goes
   * away — the work lives on in the pushed branch/PR and the card keeps the
   * links. `worktree rm` runs deliberately WITHOUT `--force`, so a dirty tree
   * makes the runtime refuse and the worktree stays inspectable; the refusal
   * surfaces as one thread line. Failed delegations never reach here — their
   * worktree is the debugging evidence. Best-effort like every janitorial
   * move: an error is a warn line, never a crash. Shared by the watcher's
   * worker_done path and boot reconciliation's outage closures (issue #25).
   */
  async cleanupDeliveredWorktree(row: DelegationRow): Promise<void> {
    if (row.worktreeId === null) {
      this.logger.warn(
        { threadTs: row.threadTs, dispatchId: row.dispatchId },
        'closed delegation carries no worktree id — cleanup skipped',
      );
      return;
    }
    try {
      await removeWorktree(this.run, row.worktreeId);
      this.logger.info(
        { threadTs: row.threadTs, dispatchId: row.dispatchId, worktreeId: row.worktreeId },
        'delivered worktree removed',
      );
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs: row.threadTs, worktreeId: row.worktreeId },
        'worktree cleanup refused — kept for inspection',
      );
      try {
        await this.surface.post(
          row.channelId,
          row.threadTs,
          worktreeKeptLine(
            row.worktreeName ?? row.worktreeId,
            error instanceof Error ? error.message : String(error),
          ),
        );
      } catch (postError) {
        this.logger.warn({ err: postError, threadTs: row.threadTs }, 'worktree-kept line post failed');
      }
    }
  }
}

import {
  completedCard,
  extractPullRequestLinks,
  gateRelayMessage,
  workerDoneFallbackLine,
  worktreeKeptLine,
} from './messages.ts';
import {
  execFileRunner,
  makeExecFileRunner,
  parseOrcaEnvelope,
  removeWorktree,
  safeRegistryIssueUrl,
  type CommandRunner,
} from './orca.ts';
import type { DelegationRow, DelegationStore, PendingGateRow, StallAlertRow } from './delegations.ts';
import type { DelegationSurface } from './dispatch.ts';
import type { Logger } from './logger.ts';

/**
 * The per-thread gate watcher (spec §6, issue #20): "the daemon listens, the
 * session thinks". For every thread with in-flight delegations the daemon
 * holds one child `orca orchestration check --wait` on the thread's mailbox
 * terminal, filtered to the three structured event types, in rolling windows
 * — a timeout or `{count:0}` is a checkpoint, not a failure (issue #4), so
 * the window simply respawns; the loop stops on its own once the thread has
 * no in-flight work left.
 *
 * A `worker_done` closes the ledger row, flips the delegation card to its
 * final ✅/❌ state (the durable home for links), swaps the root reaction,
 * and wakes the session through the SAME input pipe as a human message —
 * the session's voice writes the short summary; the daemon only posts one
 * itself when no session can take the wake. A delivered delegation's
 * worktree is then removed (issue #43); a failed one keeps its worktree
 * for debugging.
 *
 * A `decision_gate`/`escalation` is relayed up in full (issue #21): the
 * daemon itself posts the fixed-contract gate message — the worker's
 * question VERBATIM, numbered options, the reply instruction — registers it
 * in the `pending_gates` table and sets the ❓/🚨 root reaction. Posting it
 * daemon-side is what makes the contract a guarantee: no paraphrase can
 * drift in, the registry captures the relay ts (spec §9), and a gate landing
 * on a closed or dead session is still never lost. No session turn runs at
 * relay time — the mock shows none — the session thinks at ANSWER time,
 * anchored on the registry through its turn context (relay.ts).
 *
 * At boot `rearmFromStore` re-arms a watcher for every thread the ledger
 * still shows in flight — which is also what makes a daemon crash safe: the
 * orchestration bus keys messages on the handle string, not on terminal
 * liveness, so a completion sent while nobody listened is still sitting
 * unread when the re-armed check asks for it.
 */

/** The reaction half of the Slack surface — add one, take a stale one off. */
export interface ReactionSurface {
  /** reactions.add on a message (the root: ts === threadTs). */
  react(ts: string, name: string): Promise<void>;
  /** reactions.remove on a message (the root: ts === threadTs). */
  unreact(ts: string, name: string): Promise<void>;
}

/** The coordinator's Slack surface plus removal — how a stale root
 * reaction comes off when the state swaps (spec §8). */
export interface WatcherSurface extends DelegationSurface, ReactionSurface {}

export type WakeResult = 'turn' | 'skipped';

export interface GateWatcherOptions {
  store: DelegationStore;
  surface: WatcherSurface;
  /** Wakes the thread's session through the human-message pipe (spec §6). */
  wake: (threadTs: string, channelId: string, text: string) => WakeResult;
  /** A delegation left the in-flight set — frees a worker-cap slot (#19). */
  onDelegationClosed: () => void;
  logger: Logger;
  /** One `check --wait` window before it rolls; default 15 min. */
  windowMs?: number;
  /** Pause after a failed check before the next window; default 30 s. */
  retryDelayMs?: number;
  /** Injectable for tests: the blocking check child (long timeout). */
  runCheck?: CommandRunner;
  /** Injectable for tests: short daemon-side calls (registry lookups). */
  run?: CommandRunner;
  now?: () => Date;
}

const DEFAULT_WINDOW_MS = 15 * 60_000;

const DEFAULT_RETRY_DELAY_MS = 30_000;

/** Grace beyond the child's own --timeout-ms before execFile kills it. */
const CHECK_GRACE_MS = 30_000;

/** The gate trio plus the liveness types (issue #48): a worker `heartbeat`
 * (or a bus producer's `status` ping) carries no relay and wakes nobody —
 * it stamps the delegation's bus clock, the watchdog's in-flight-age source. */
const WATCHED_TYPES = 'worker_done,escalation,decision_gate,heartbeat,status';

/** The root reactions the daemon manages (spec §8) — one on, the rest off. */
const ROOT_REACTIONS = ['eyes', 'white_check_mark', 'x', 'question', 'rotating_light'] as const;

export type RootReaction = (typeof ROOT_REACTIONS)[number];

/**
 * Adds the new root reaction, then clears the other managed ones — the
 * shared move behind every coarse-state swap (here and in the gate relay's
 * answer path). Both halves are best-effort: reactions are ambient state,
 * never worth failing an event over.
 */
export async function applyRootReaction(
  surface: ReactionSurface,
  logger: Logger,
  threadTs: string,
  name: RootReaction,
): Promise<void> {
  try {
    await surface.react(threadTs, name);
  } catch (error) {
    logger.debug({ err: error, threadTs, name }, 'root reaction add failed');
  }
  for (const stale of ROOT_REACTIONS) {
    if (stale === name) continue;
    try {
      await surface.unreact(threadTs, stale);
    } catch (error) {
      // Usually Slack's no_reaction — the stale one simply wasn't set.
      logger.debug({ err: error, threadTs, stale }, 'stale reaction removal skipped');
    }
  }
}

/** The registry slice the coarse-state computation reads. */
export interface PendingStateStore {
  listPendingGates(threadTs: string): PendingGateRow[];
  listPendingStalls(threadTs: string): StallAlertRow[];
}

/**
 * The thread's honest coarse state while work is in flight, re-derived from
 * the registries and applied to the root (spec §8): 🚨 while an escalation
 * or a watchdog stall alert waits, ❓ while only questions do, 👀 otherwise.
 * Shared by every path that settles the root after a pending set changed —
 * a gate relayed or answered, a stall alerted or nudged, a sibling done.
 */
export async function settleRootReaction(
  store: PendingStateStore,
  surface: ReactionSurface,
  logger: Logger,
  threadTs: string,
): Promise<void> {
  const gates = store.listPendingGates(threadTs);
  const alarmed =
    gates.some((gate) => gate.kind === 'escalation') ||
    store.listPendingStalls(threadTs).length > 0;
  const name: RootReaction = alarmed ? 'rotating_light' : gates.length > 0 ? 'question' : 'eyes';
  await applyRootReaction(surface, logger, threadTs, name);
}

/** The registry slice the turn-end settle reads — in-flight work plus the
 * pending registries behind the coarse state. */
export interface TurnAckStore extends PendingStateStore {
  listInFlightForThread(threadTs: string): DelegationRow[];
}

/**
 * The turn-start ack (issue #49): 👀 on the root the moment ANY turn begins
 * — session open included — the channel-level "I'm on it" before any reply
 * text. Add-only, deliberately not `applyRootReaction`: the milestone/gate/
 * done flips own every coarse-state transition, so a pending ❓/🚨 or an
 * earlier ✅/❌ stays put next to the 👀. Best-effort like every reaction —
 * the usual failure is Slack's already_reacted, when the 👀 is simply on.
 */
export async function ackTurnStart(
  surface: Pick<ReactionSurface, 'react'>,
  logger: Logger,
  threadTs: string,
): Promise<void> {
  try {
    await surface.react(threadTs, 'eyes');
  } catch (error) {
    logger.debug({ err: error, threadTs }, 'turn-start 👀 add failed (may already be set)');
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
export async function settleTurnEnd(
  store: TurnAckStore,
  surface: Pick<ReactionSurface, 'unreact'>,
  logger: Logger,
  threadTs: string,
  /** Work the registries cannot see: a created-but-not-yet-dispatched
   * worktree (the coordinator's create→dispatch window) has a 👀-backed
   * card but no ledger row, and must keep its milestone 👀 on. */
  hasUndispatchedWork = false,
): Promise<void> {
  if (
    hasUndispatchedWork ||
    store.listInFlightForThread(threadTs).length > 0 ||
    store.listPendingGates(threadTs).length > 0 ||
    store.listPendingStalls(threadTs).length > 0
  ) {
    return;
  }
  try {
    await surface.unreact(threadTs, 'eyes');
  } catch (error) {
    // Usually Slack's no_reaction — a flip already took the 👀 off.
    logger.debug({ err: error, threadTs }, 'turn-end 👀 removal skipped');
  }
}

export interface OrchestrationMessage {
  id: string;
  type: string;
  subject: string;
  body: string;
  /** The sending terminal — the asking worker, for a gate's route-back. */
  fromHandle?: string;
  payload: { taskId?: string; dispatchId?: string; question?: string; options?: string[] };
}

/**
 * The dispatch preamble's failure contract (issue #20): failure is still a
 * worker_done — a subject shaped "Failed: <reason>" is the only signal
 * there is. One predicate so the watcher and boot reconciliation (issue
 * #25) can never drift on what counts as a failure.
 */
export function isFailureSubject(subject: string): boolean {
  return /^fail/i.test(subject.trim());
}

/**
 * The delegation card's final ✅/❌ state — or a fresh post when no card
 * ever landed. Shared by the watcher's worker_done flip and boot
 * reconciliation's outage closures (issue #25); failure is signalled by
 * passing a `failureReason`.
 */
export async function flipCardFinal(
  surface: Pick<WatcherSurface, 'post' | 'update'>,
  logger: Logger,
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
      await surface.post(row.threadTs, text);
    } else {
      await surface.update(row.cardTs, text);
    }
  } catch (error) {
    logger.warn({ err: error, threadTs: row.threadTs, cardTs: row.cardTs }, 'final card edit failed');
  }
}

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
export async function cleanupDeliveredWorktree(
  run: CommandRunner,
  surface: Pick<WatcherSurface, 'post'>,
  logger: Logger,
  row: DelegationRow,
): Promise<void> {
  if (row.worktreeId === null) {
    logger.warn(
      { threadTs: row.threadTs, dispatchId: row.dispatchId },
      'closed delegation carries no worktree id — cleanup skipped',
    );
    return;
  }
  try {
    await removeWorktree(run, row.worktreeId);
    logger.info(
      { threadTs: row.threadTs, dispatchId: row.dispatchId, worktreeId: row.worktreeId },
      'delivered worktree removed',
    );
  } catch (error) {
    logger.warn(
      { err: error, threadTs: row.threadTs, worktreeId: row.worktreeId },
      'worktree cleanup refused — kept for inspection',
    );
    try {
      await surface.post(
        row.threadTs,
        worktreeKeptLine(
          row.worktreeName ?? row.worktreeId,
          error instanceof Error ? error.message : String(error),
        ),
      );
    } catch (postError) {
      logger.warn({ err: postError, threadTs: row.threadTs }, 'worktree-kept line post failed');
    }
  }
}

/**
 * `orchestration check --json` stdout → the readable bus messages, with the
 * raw array riding along for the caller's dropped-entries log line. Throws
 * on a shapeless envelope. Shared with boot reconciliation (issue #25),
 * whose read-only `check --all` peek sees the same message shape.
 */
export function readCheckMessages(stdout: string): {
  messages: OrchestrationMessage[];
  raw: unknown[];
} {
  const raw = parseOrcaEnvelope(stdout)?.messages;
  if (!Array.isArray(raw)) {
    throw new Error('unexpected `orca orchestration check` response shape');
  }
  return { messages: raw.flatMap(readMessage), raw };
}

export class GateWatcher {
  private readonly store: DelegationStore;
  private readonly surface: WatcherSurface;
  private readonly wake: GateWatcherOptions['wake'];
  private readonly onDelegationClosed: () => void;
  private readonly logger: Logger;
  private readonly windowMs: number;
  private readonly retryDelayMs: number;
  private readonly runCheck: CommandRunner;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  /** One live loop per thread, keyed by its own token so a crash-path
   * cleanup can never clobber a successor loop armed in the meantime. */
  private readonly loops = new Map<string, object>();

  constructor(options: GateWatcherOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.wake = options.wake;
    this.onDelegationClosed = options.onDelegationClosed;
    this.logger = options.logger;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.runCheck = options.runCheck ?? makeExecFileRunner(this.windowMs + CHECK_GRACE_MS);
    this.run = options.run ?? execFileRunner;
    this.now = options.now ?? (() => new Date());
  }

  /** Starts the thread's watch loop; a no-op while one is already running. */
  arm(threadTs: string): void {
    if (this.loops.has(threadTs)) return;
    const token = {};
    this.loops.set(threadTs, token);
    void this.watch(threadTs)
      .catch((error: unknown) => {
        this.logger.error({ err: error, threadTs }, 'gate watcher loop crashed');
      })
      .finally(() => {
        // Clean exits already un-armed themselves, synchronously with their
        // stop decision — this only mops up after a crash, and never a
        // successor loop that armed while this callback sat in the queue.
        if (this.loops.get(threadTs) === token) this.loops.delete(threadTs);
      });
  }

  isArmed(threadTs: string): boolean {
    return this.loops.has(threadTs);
  }

  /** Boot re-arm (spec §6): one watcher per thread the ledger shows in flight. */
  rearmFromStore(): number {
    const threads = this.store.threadsWithInFlight();
    for (const { threadTs } of threads) this.arm(threadTs);
    return threads.length;
  }

  // ── the rolling-window loop ────────────────────────────────────────────────

  private async watch(threadTs: string): Promise<void> {
    this.logger.info({ threadTs }, 'gate watcher armed');
    while (true) {
      if (this.store.listInFlightForThread(threadTs).length === 0) {
        // Un-arm in the same synchronous block as the stop decision: a
        // dispatch interleaving after this line finds the thread un-armed
        // and starts a fresh loop instead of no-opping into a lost watcher.
        this.loops.delete(threadTs);
        this.logger.info({ threadTs }, 'no in-flight delegations left — gate watcher stops');
        return;
      }
      const mailbox = this.store.getMailbox(threadTs);
      if (mailbox === undefined) {
        // Unreachable on the normal path — a dispatch cannot happen without
        // the mailbox — but a hand-edited ledger must not spin this loop.
        this.loops.delete(threadTs);
        this.logger.warn(
          { threadTs },
          'in-flight delegations but no mailbox terminal — gate watcher stops',
        );
        return;
      }
      let messages: OrchestrationMessage[];
      try {
        messages = await this.checkOnce(mailbox);
      } catch (error) {
        this.logger.warn(
          { err: error, threadTs, mailbox },
          'check --wait failed — next window after a pause',
        );
        await sleep(this.retryDelayMs);
        continue;
      }
      // An empty result is the window's timeout — a checkpoint, not a
      // failure (issue #4): fall through and roll the next window.
      for (const message of messages) {
        await this.handleMessage(threadTs, message);
      }
    }
  }

  /** One `check --wait` window on the thread's mailbox. Throws on a bad shape. */
  private async checkOnce(mailbox: string): Promise<OrchestrationMessage[]> {
    const { stdout } = await this.runCheck('orca', [
      'orchestration',
      'check',
      '--wait',
      '--terminal',
      mailbox,
      '--types',
      WATCHED_TYPES,
      '--timeout-ms',
      String(this.windowMs),
      '--json',
    ]);
    const { messages, raw } = readCheckMessages(stdout);
    if (messages.length < raw.length) {
      // The check marked them read, so this log line is their last trace.
      this.logger.error(
        { mailbox, dropped: raw.length - messages.length, raw },
        'unreadable bus messages dropped',
      );
    }
    return messages;
  }

  // ── event handling ─────────────────────────────────────────────────────────

  private async handleMessage(threadTs: string, message: OrchestrationMessage): Promise<void> {
    this.logger.info(
      { threadTs, msgId: message.id, type: message.type, subject: message.subject },
      'orchestration event received',
    );
    if (message.type === 'worker_done') {
      await this.handleWorkerDone(threadTs, message);
    } else if (message.type === 'decision_gate' || message.type === 'escalation') {
      await this.handleGateOrEscalation(threadTs, message.type, message);
    } else if (message.type === 'heartbeat' || message.type === 'status') {
      await this.handleWorkerLiveness(threadTs, message);
    } else {
      this.logger.warn({ threadTs, type: message.type }, 'unwatched event type slipped through');
    }
  }

  /**
   * `heartbeat`/`status` (issue #48): the message IS the whole signal — no
   * relay, no wake. It stamps the delegation's bus clock (what the watchdog
   * measures in-flight age against) and settles any pending ⚠️ alert: a
   * worker just heard from is a worker no longer needing attention, and the
   * root's coarse state follows. A message matching no ledger row — or a
   * straggler naming a closed dispatch — stamps nothing (the store only
   * updates in-flight rows), so it can never mask a hung retry.
   */
  private async handleWorkerLiveness(
    threadTs: string,
    message: OrchestrationMessage,
  ): Promise<void> {
    const row = this.findRow(threadTs, message);
    if (row === undefined) {
      this.logger.debug(
        { threadTs, msgId: message.id, payload: message.payload },
        'liveness message matches no ledger row — ignored',
      );
      return;
    }
    this.store.recordBusActivity(row.dispatchId);
    if (this.store.answerStall(row.dispatchId)) {
      this.logger.info(
        { threadTs: row.threadTs, dispatchId: row.dispatchId },
        'pending watchdog alert settled — the worker spoke on the bus',
      );
      await settleRootReaction(this.store, this.surface, this.logger, row.threadTs);
    }
  }

  /**
   * `worker_done` (issue #20): ledger row closed, card flipped to ✅/❌ with
   * the durable links, root reaction swapped, session woken for the summary,
   * and on success the worktree cleaned up (issue #43). Failure is still a
   * worker_done — the preamble fixes the subject shape ("Failed: <reason>"),
   * which is all the signal there is.
   */
  private async handleWorkerDone(threadTs: string, message: OrchestrationMessage): Promise<void> {
    const row = this.findRow(threadTs, message);
    if (row === undefined) {
      // Never lose a completion: unmatched still lands in the thread, raw.
      this.logger.warn(
        { threadTs, msgId: message.id, payload: message.payload },
        'worker_done matches no ledger row — surfaced raw',
      );
      await this.postSafe(
        threadTs,
        `⚠️ A worker reported done but matches no delegation I know:\n> ${message.subject}\n> ${message.body}`,
      );
      return;
    }
    const failed = isFailureSubject(message.subject);
    if (!this.store.closeDelegation(row.dispatchId, failed ? 'failed' : 'completed')) {
      this.logger.info(
        { threadTs, dispatchId: row.dispatchId },
        'duplicate worker_done for an already-closed delegation — ignored',
      );
      return;
    }
    this.onDelegationClosed();
    this.logger.info(
      { threadTs: row.threadTs, dispatchId: row.dispatchId, failed },
      'delegation closed on worker_done',
    );

    // Card first (the summary's "details in the card ⤴" must already be
    // true), then the root reaction, then the wake.
    await this.finishCard(row, message, failed);
    await this.swapRootReaction(row.threadTs, failed);
    const outcome = this.wake(
      row.threadTs,
      row.channelId,
      workerDoneWakeText(row, message, failed),
    );
    if (outcome === 'skipped') {
      // No session can format the summary (thread closed, or never
      // registered) — the completion still gets its NEW message.
      this.logger.info(
        { threadTs: row.threadTs, dispatchId: row.dispatchId },
        'no session took the worker_done wake — posting the fallback summary',
      );
      await this.postSafe(row.threadTs, workerDoneFallbackLine(message.subject, failed));
    }
    // Janitorial last — the human-facing card, reaction and wake never wait
    // on it. A failure keeps its worktree as the debugging evidence.
    if (!failed) {
      await cleanupDeliveredWorktree(this.run, this.surface, this.logger, row);
    }
  }

  /**
   * `decision_gate`/`escalation` — the relay up (issue #21): the fixed
   * gate message posted as a NEW message, the `pending_gates` row written
   * at relay time, the ❓/🚨 root reaction set. The registry row is the
   * never-lost guarantee — recorded even when the Slack post fails, so the
   * question stays routable and recoverable.
   *
   * A re-ask supersedes instead of stacking (issue #46): a worker whose
   * `ask` timed out asks the SAME question again under a fresh msg_id, and
   * only the newest ask still listens for a reply. So when the question
   * matches a live gate from the same terminal, the old row flips to
   * `superseded` (forwarding to the successor) and the existing ❓ relay is
   * edited in place — never a second notification for one logical question.
   */
  private async handleGateOrEscalation(
    threadTs: string,
    kind: 'decision_gate' | 'escalation',
    message: OrchestrationMessage,
  ): Promise<void> {
    if (this.store.getGate(message.id) !== undefined) {
      this.logger.info(
        { threadTs, msgId: message.id, kind },
        'gate already in the registry — replayed event ignored',
      );
      return;
    }
    const row = this.findRow(threadTs, message);
    // The ask itself is bus liveness (issue #48): stamp the clock, and
    // settle any pending ⚠️ — the gate relayed below owns the thread's
    // attention from here (the settle at the end recomputes the root).
    if (row !== undefined) {
      this.store.recordBusActivity(row.dispatchId);
      this.store.answerStall(row.dispatchId);
    }
    // The row's thread owns the delegation — the human answers there.
    const gateThread = row?.threadTs ?? threadTs;
    // The payload's question is canonical for an `ask`; body/subject cover
    // escalations and any bus producer that skipped the payload.
    const question = firstNonEmpty(message.payload.question, message.body, message.subject);
    const options = message.payload.options ?? [];
    const taskId = message.payload.taskId ?? row?.taskId ?? null;
    const workerHandle = message.fromHandle ?? row?.workerHandle ?? null;
    // The asking terminal is the re-ask's identity; task ids only VETO a
    // match when both sides name one and disagree — an id-less side (a stray
    // ask, a pre-#46 row) must not shield a duplicate from the dedup. The
    // self-exclusion is belt-and-braces: the replay guard above already
    // filtered this msg_id, and a row must never forward to itself.
    const reasked = this.store.listPendingGates(gateThread).find(
      (gate) =>
        gate.msgId !== message.id &&
        gate.kind === kind &&
        gate.workerHandle !== null &&
        gate.workerHandle === workerHandle &&
        (gate.taskId === null || taskId === null || gate.taskId === taskId) &&
        isSameQuestion(gate.question, question),
    );

    const text = gateRelayMessage({
      kind,
      worktreeName: row?.worktreeName ?? null,
      repo: row?.repo ?? null,
      issueNumber: row?.issueNumber ?? null,
      issueUrl:
        row === undefined
          ? undefined
          : await safeRegistryIssueUrl(this.run, this.logger, row.repo, row.issueNumber),
      question,
      options,
    });
    let relayTs: string | null = null;
    if (reasked !== undefined && reasked.relayTs !== null) {
      // The question already sits in the thread — refresh it to the newest
      // verbatim wording and keep anchoring the registry on that message.
      relayTs = reasked.relayTs;
      try {
        await this.surface.update(reasked.relayTs, text);
      } catch (error) {
        this.logger.warn(
          { err: error, threadTs: gateThread, msgId: message.id, relayTs },
          're-asked gate relay edit failed — the original relay still shows the question',
        );
      }
    } else {
      try {
        relayTs = await this.surface.post(gateThread, text);
      } catch (error) {
        this.logger.error(
          { err: error, threadTs: gateThread, msgId: message.id, kind, question },
          'gate relay post failed — the registry row below still holds the question',
        );
      }
    }
    this.store.recordGate({
      msgId: message.id,
      threadTs: gateThread,
      taskId,
      dispatchId: message.payload.dispatchId ?? row?.dispatchId ?? null,
      workerHandle,
      worktreeName: row?.worktreeName ?? null,
      kind,
      question,
      options,
      relayTs,
    });
    // Successor first, then the flip: a crash between the two leaves a
    // harmless extra pending row, never a question with no live gate.
    if (reasked !== undefined) {
      this.store.supersedeGate(reasked.msgId, message.id);
      this.logger.info(
        { threadTs: gateThread, msgId: message.id, superseded: reasked.msgId, kind },
        're-asked question superseded its stale gate — one live gate, no second relay',
      );
    }
    // A pending escalation or stall alert outranks a plain question on the
    // root (spec §8): a ❓ arriving while a 🚨 waits must not soften the
    // coarse state. The just-recorded gate is part of the settled set.
    await settleRootReaction(this.store, this.surface, this.logger, gateThread);
  }

  /**
   * The ledger row behind an event: the payload's dispatch id (authoritative
   * — the preamble makes workers echo it on worker_done) with the task id as
   * a fallback, then the sending terminal — a worker's `ask` carries neither
   * id, so the asking handle is a decision_gate's usual identity (issue
   * #21). Fallbacks are scoped to the thread. A row living in another thread
   * is trusted over the arrival mailbox — the card to edit lives where the
   * row says.
   */
  private findRow(threadTs: string, message: OrchestrationMessage): DelegationRow | undefined {
    const byDispatch =
      message.payload.dispatchId === undefined
        ? undefined
        : this.store.getByDispatchId(message.payload.dispatchId);
    if (byDispatch !== undefined) {
      if (byDispatch.threadTs !== threadTs) {
        this.logger.warn(
          { threadTs, rowThreadTs: byDispatch.threadTs, dispatchId: byDispatch.dispatchId },
          'event arrived on another thread’s mailbox — handling it in the row’s thread',
        );
      }
      return byDispatch;
    }
    if (message.payload.taskId !== undefined) {
      return (
        this.store.inFlightByTaskId(threadTs, message.payload.taskId) ??
        // A closed row still matches (issue #25): a worker_done consumed
        // after boot reconciliation already closed its delegation must land
        // on the duplicate guard above, not surface as an unknown worker.
        this.store.latestByTaskId(threadTs, message.payload.taskId)
      );
    }
    // The handle fallback only covers id-LESS payloads (an `ask`): a message
    // that names ids pointing nowhere is a stale straggler — matching it by
    // handle would let a failed retry's worker_done close the live dispatch.
    if (message.payload.dispatchId !== undefined || message.fromHandle === undefined) {
      return undefined;
    }
    return this.store.inFlightByWorkerHandle(threadTs, message.fromHandle);
  }

  // ── the ✅/❌ card ──────────────────────────────────────────────────────────

  /** The card's final state — or a fresh post when no card ever landed. */
  private async finishCard(
    row: DelegationRow,
    message: OrchestrationMessage,
    failed: boolean,
  ): Promise<void> {
    await flipCardFinal(this.surface, this.logger, row, {
      durationMs: this.now().getTime() - Date.parse(row.dispatchedAt),
      issueUrl: await safeRegistryIssueUrl(this.run, this.logger, row.repo, row.issueNumber),
      reportText: `${message.subject}\n${message.body}`,
      ...(failed && { failureReason: message.subject }),
    });
  }

  // ── root reactions ─────────────────────────────────────────────────────────

  /**
   * Spec §8 coarse state: a failure surfaces as ❌ immediately; a success
   * flips the root to ✅ only once the thread has no other in-flight work —
   * with siblings still running, the registries decide the honest state
   * (👀, or ❓/🚨 while other gates or stall alerts wait — this is also
   * what clears a 🚨 whose stall alert the ledger close just settled). The
   * reaction is the CURRENT state, latest terminal event wins: a sibling
   * success after a failure does replace the ❌ — the failure keeps its ❌
   * card and its summary message in the thread, which are the log; the root
   * is not.
   */
  private async swapRootReaction(threadTs: string, failed: boolean): Promise<void> {
    if (failed) {
      await this.setRootReaction(threadTs, 'x');
      return;
    }
    if (this.store.listInFlightForThread(threadTs).length > 0) {
      await settleRootReaction(this.store, this.surface, this.logger, threadTs);
      return;
    }
    await this.setRootReaction(threadTs, 'white_check_mark');
  }

  private async setRootReaction(threadTs: string, name: RootReaction): Promise<void> {
    await applyRootReaction(this.surface, this.logger, threadTs, name);
  }

  private async postSafe(threadTs: string, text: string): Promise<boolean> {
    try {
      await this.surface.post(threadTs, text);
      return true;
    } catch (error) {
      this.logger.warn({ err: error, threadTs }, 'watcher thread post failed');
      return false;
    }
  }
}

// ── wake texts — what the daemon feeds the session's input pipe ─────────────

/**
 * The worker_done wake: the worker's report plus what is left for the LLM to
 * do — only the summary; the daemon already did the mechanical part.
 */
/** `repo#n (worktree)`, degrading to the task id — the wake texts' name for a row. */
function delegationRef(row: DelegationRow): string {
  const ref =
    row.repo !== null && row.issueNumber !== null ? `${row.repo}#${row.issueNumber}` : row.taskId;
  return row.worktreeName === null ? ref : `${ref} (\`${row.worktreeName}\`)`;
}

export function workerDoneWakeText(
  row: DelegationRow,
  message: { subject: string; body: string },
  failed: boolean,
): string {
  const report = message.body.trim() === '' ? message.subject : message.body;
  return [
    `[orchestration event — not a human message] worker_done: the delegation ${delegationRef(row)} ` +
      (failed ? 'FAILED.' : 'completed.'),
    `Worker subject: ${message.subject}`,
    `Worker report:\n${report}`,
    '',
    'The daemon already closed the ledger, flipped the delegation card to its final state and ' +
      'set the root reaction. Your only job: reply with ONE short summary for the human ' +
      `(1–2 lines of Slack mrkdwn) — start with "${failed ? '❌ Failed' : '✅ Delivered'} —", ` +
      (failed
        ? 'say what went wrong, '
        : 'say what shipped and include the PR link if the report names one, ') +
      'and end with "Details in the card ⤴". Do not run any commands for this event.',
  ].join('\n');
}

// ── message reading ──────────────────────────────────────────────────────────

/** One raw bus message → the watcher's shape; unreadable entries drop, logged upstream. */
function readMessage(raw: unknown): OrchestrationMessage[] {
  const record = raw as {
    id?: unknown;
    type?: unknown;
    subject?: unknown;
    body?: unknown;
    from_handle?: unknown;
    payload?: unknown;
  };
  if (typeof record.id !== 'string' || typeof record.type !== 'string') return [];
  return [
    {
      id: record.id,
      type: record.type,
      subject: typeof record.subject === 'string' ? record.subject : '',
      body: typeof record.body === 'string' ? record.body : '',
      ...(typeof record.from_handle === 'string' && { fromHandle: record.from_handle }),
      payload: readPayload(record.payload),
    },
  ];
}

/**
 * The bus serializes `payload` as a JSON string — `{taskId, dispatchId}` on
 * worker events, plus `{question, options}` on an `ask` (issue #21).
 */
function readPayload(raw: unknown): OrchestrationMessage['payload'] {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as {
      taskId?: unknown;
      dispatchId?: unknown;
      question?: unknown;
      options?: unknown;
    };
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((option): option is string => typeof option === 'string')
      : undefined;
    return {
      ...(typeof parsed.taskId === 'string' && { taskId: parsed.taskId }),
      ...(typeof parsed.dispatchId === 'string' && { dispatchId: parsed.dispatchId }),
      ...(typeof parsed.question === 'string' && { question: parsed.question }),
      ...(options !== undefined && options.length > 0 && { options }),
    };
  } catch {
    return {};
  }
}

/** The first candidate with content — how the relay picks the question text. */
function firstNonEmpty(...candidates: Array<string | undefined>): string {
  return candidates.find((text) => text !== undefined && text.trim() !== '') ?? '';
}

/**
 * Whether a new ask repeats a live gate's question (issue #46). Workers
 * re-ask essentially verbatim after an `ask` timeout, so the match stays
 * deliberately narrow — case and whitespace only — lest two genuinely
 * distinct questions from one worker ever collapse into each other.
 */
function isSameQuestion(a: string, b: string): boolean {
  const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
  return normalize(a) === normalize(b);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

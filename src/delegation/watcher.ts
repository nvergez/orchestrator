import { gateRelayMessage, workerDoneFallbackLine } from '../kernel/messages.ts';
import {
  execFileRunner,
  makeExecFileRunner,
  readCheckMessages,
  safeRegistryIssueUrl,
  type CommandRunner,
  type OrchestrationMessage,
} from '../kernel/orca.ts';
import { isFailedReport, type ThreadSurface } from './thread-surface.ts';
import type { DelegationRow, DelegationStore } from './delegations.ts';
import type { Logger } from '../kernel/logger.ts';
import { deliverQuestion } from './question-delivery.ts';

/**
 * The per-thread gate watcher (spec §6, issue #20): "the daemon listens, the
 * session thinks". For every thread with in-flight delegations the daemon
 * holds one child `orca orchestration check --wait` on the thread's mailbox
 * terminal, filtered to the three structured event types, in rolling windows
 * — a timeout or `{count:0}` is a checkpoint, not a failure (issue #4), so
 * the window simply respawns; the loop stops on its own once the thread has
 * no in-flight work left.
 *
 * A `worker_done` closes the ledger row and hands the root reaction to the
 * thread surface. A Question delivers its durable answer directly, then
 * finishes its card and cleanup. A Change wakes the session through
 * the SAME input pipe as a human message — the session's voice writes the
 * short summary; the daemon only posts one itself when no session can take
 * the wake. A delivered delegation's worktree is then removed (issue #43); a
 * failed one keeps its worktree for debugging.
 *
 * A `decision_gate`/`escalation` is relayed up in full (issue #21): the
 * daemon itself posts the fixed-contract gate message — the worker's
 * question VERBATIM, numbered options, the reply instruction — registers it
 * in the `pending_gates` table and settles the ❓/🚨 root reaction. Posting
 * it daemon-side is what makes the contract a guarantee: no paraphrase can
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
 *
 * Since Orca 1.4.198 (ADR 0006) a window returns one Delivery that replays
 * identically until acknowledged — so the loop acknowledges a handled batch
 * on its NEXT check (`--ack` rides the following `--wait`), and settles the
 * last one before it stops. A crash between handling and ack replays the
 * batch, which the handlers' duplicate guards absorb: at-least-once, never
 * lost.
 */

export type WakeResult = 'turn' | 'skipped';

export interface GateWatcherOptions {
  store: DelegationStore;
  /** The thread surface — every card, reaction and cleanup decision. */
  surface: ThreadSurface;
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

export class GateWatcher {
  private readonly store: DelegationStore;
  private readonly surface: ThreadSurface;
  private readonly wake: GateWatcherOptions['wake'];
  private readonly onDelegationClosed: () => void;
  private readonly logger: Logger;
  private readonly windowMs: number;
  private readonly retryDelayMs: number;
  private readonly runCheck: CommandRunner;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  /** One live loop per thread (keyed `channelId:threadTs`, issue #93), each
   * under its own token so a crash-path cleanup can never clobber a
   * successor loop armed in the meantime. */
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
  arm(threadTs: string, channelId: string): void {
    const key = loopKey(threadTs, channelId);
    if (this.loops.has(key)) return;
    const token = {};
    this.loops.set(key, token);
    void this.watch(threadTs, channelId)
      .catch((error: unknown) => {
        this.logger.error({ err: error, threadTs }, 'gate watcher loop crashed');
      })
      .finally(() => {
        // Clean exits already un-armed themselves, synchronously with their
        // stop decision — this only mops up after a crash, and never a
        // successor loop that armed while this callback sat in the queue.
        if (this.loops.get(key) === token) this.loops.delete(key);
      });
  }

  isArmed(threadTs: string, channelId: string): boolean {
    return this.loops.has(loopKey(threadTs, channelId));
  }

  /** Boot re-arm: one watcher per thread with live work or pending answers. */
  rearmFromStore(): number {
    const threads = this.store.threadsNeedingWatcher();
    for (const { threadTs, channelId } of threads) this.arm(threadTs, channelId);
    return threads.length;
  }

  // ── the rolling-window loop ────────────────────────────────────────────────

  private async watch(threadTs: string, channelId: string): Promise<void> {
    const key = loopKey(threadTs, channelId);
    this.logger.info({ threadTs, channelId }, 'gate watcher armed');
    /** The Delivery handled in the last window, not yet acknowledged. */
    let unacked: string | undefined;
    while (true) {
      const pending = this.store.pendingQuestionDeliveries({ threadTs, channelId });
      let deliveryFailed = false;
      for (const row of pending) {
        try {
          await deliverQuestion(row, this.store, this.surface);
        } catch (error) {
          this.logger.warn({ err: error, dispatchId: row.dispatchId }, 'Question answer delivery failed — retrying');
          deliveryFailed = true;
          break;
        }
      }
      if (deliveryFailed) {
        await sleep(this.retryDelayMs);
        continue;
      }
      const mailbox = this.store.getMailbox(threadTs, channelId);
      if (this.store.listInFlightForThread(threadTs, channelId).length === 0) {
        if (unacked !== undefined && mailbox !== undefined) {
          // Left unacknowledged, the batch would replay ahead of every later
          // event on this mailbox — settle it before the loop lets go.
          await this.acknowledge(mailbox, unacked);
        }
        // Un-arm in the same synchronous block as the stop decision: a
        // dispatch interleaving after this line finds the thread un-armed
        // and starts a fresh loop instead of no-opping into a lost watcher.
        this.loops.delete(key);
        this.logger.info({ threadTs }, 'no in-flight delegations left — gate watcher stops');
        return;
      }
      if (mailbox === undefined) {
        // Unreachable on the normal path — a dispatch cannot happen without
        // the mailbox — but a hand-edited ledger must not spin this loop.
        this.loops.delete(key);
        this.logger.warn(
          { threadTs },
          'in-flight delegations but no mailbox terminal — gate watcher stops',
        );
        return;
      }
      let window: CheckWindow;
      try {
        window = await this.checkOnce(mailbox, unacked);
      } catch (error) {
        this.logger.warn(
          { err: error, threadTs, mailbox, ...(unacked !== undefined && { droppedAck: unacked }) },
          'check --wait failed — next window after a pause',
        );
        // The ack does not survive a failure: an already-applied one fails
        // every retry as `stale_delivery` (probed live), while a batch left
        // unacknowledged merely replays into the duplicate guards and gets
        // acknowledged after that window instead — at-least-once either way.
        unacked = undefined;
        await sleep(this.retryDelayMs);
        continue;
      }
      unacked = window.deliveryId;
      // An empty result is the window's timeout — a checkpoint, not a
      // failure (issue #4): fall through and roll the next window.
      for (const message of window.messages) {
        await this.handleMessage(threadTs, channelId, message);
      }
    }
  }

  /**
   * One `check --wait` window on the thread's mailbox, acknowledging the
   * previous window's Delivery on the way in. Throws on a bad shape.
   */
  private async checkOnce(mailbox: string, ack: string | undefined): Promise<CheckWindow> {
    const { stdout } = await this.runCheck('orca', [
      'orchestration',
      'check',
      '--wait',
      ...(ack === undefined ? [] : ['--ack', ack]),
      '--terminal',
      mailbox,
      '--types',
      WATCHED_TYPES,
      '--timeout-ms',
      String(this.windowMs),
      '--json',
    ]);
    const { messages, raw, deliveryId } = readCheckMessages(stdout);
    if (messages.length < raw.length) {
      // The check consumed them, so this log line is their last trace.
      this.logger.error(
        { mailbox, dropped: raw.length - messages.length, raw },
        'unreadable bus messages dropped',
      );
    }
    return { messages, ...(deliveryId !== undefined && { deliveryId }) };
  }

  /**
   * Settles the last handled Delivery when the loop stops with it unacked —
   * `check --ack` without `--wait`, on the short runner. A batch the ack
   * hands back stays queued for the next arm (returned is not acknowledged),
   * so nothing is lost; a failure here merely replays an already-handled
   * batch later, which the duplicate guards absorb.
   */
  private async acknowledge(mailbox: string, deliveryId: string): Promise<void> {
    try {
      await this.run('orca', [
        'orchestration',
        'check',
        '--ack',
        deliveryId,
        '--terminal',
        mailbox,
        '--json',
      ]);
      this.logger.info({ mailbox, deliveryId }, 'last Delivery acknowledged');
    } catch (error) {
      this.logger.warn(
        { err: error, mailbox, deliveryId },
        'final Delivery acknowledgement failed — it replays on the next arm',
      );
    }
  }

  // ── event handling ─────────────────────────────────────────────────────────

  private async handleMessage(
    threadTs: string,
    channelId: string,
    message: OrchestrationMessage,
  ): Promise<void> {
    this.logger.info(
      { threadTs, msgId: message.id, type: message.type, subject: message.subject },
      'orchestration event received',
    );
    if (message.type === 'worker_done') {
      await this.handleWorkerDone(threadTs, channelId, message);
    } else if (message.type === 'decision_gate' || message.type === 'escalation') {
      await this.handleGateOrEscalation(threadTs, channelId, message.type, message);
    } else if (message.type === 'heartbeat' || message.type === 'status') {
      await this.handleWorkerLiveness(threadTs, channelId, message);
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
    channelId: string,
    message: OrchestrationMessage,
  ): Promise<void> {
    const row = this.findRow(threadTs, channelId, message);
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
      await this.surface.settleRoot(row.channelId, row.threadTs);
    }
  }

  /**
   * `worker_done` (issue #20): ledger row closed, card flipped to ✅/❌ with
   * the durable links, root reaction settled, session woken for the summary,
   * and on success the worktree cleaned up (issue #43). Failure is still a
   * worker_done — the worker's explicit `--outcome` (Orca ≥ 1.4.198), else
   * the older preamble's subject shape ("Failed: <reason>").
   */
  private async handleWorkerDone(
    threadTs: string,
    channelId: string,
    message: OrchestrationMessage,
  ): Promise<void> {
    const row = this.findRow(threadTs, channelId, message);
    if (row === undefined) {
      // Never lose a completion: unmatched still lands in the thread, raw.
      this.logger.warn(
        { threadTs, msgId: message.id, payload: message.payload },
        'worker_done matches no ledger row — surfaced raw',
      );
      await this.postSafe(
        threadTs,
        channelId,
        `⚠️ A worker reported done but matches no delegation I know:\n> ${message.subject}\n> ${message.body}`,
      );
      return;
    }
    const failed = isFailedReport(message);
    if (!this.store.closeDelegation(row.dispatchId, failed ? 'failed' : 'completed', message.body)) {
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

    // Settle in bus-event order, independent of when answer posting succeeds.
    // Deferred delivery must never overwrite a later sibling's failure.
    if (row.kind === 'question' && !failed) {
      await this.surface.settleWorkerDone(row.channelId, row.threadTs, false);
      return;
    }

    // Card first (the summary's "details in the card ⤴" must already be
    // true), then the root reaction, then the wake.
    await this.finishCard(row, message, failed);
    await this.surface.settleWorkerDone(row.channelId, row.threadTs, failed);
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
      await this.postSafe(
        row.threadTs,
        row.channelId,
        workerDoneFallbackLine(message.subject, failed, message.body),
      );
    }
    // Janitorial last — the human-facing card, reaction and wake never wait
    // on it. A failure keeps its worktree as the debugging evidence.
    if (!failed) {
      await this.surface.cleanupDeliveredWorktree(row);
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
    channelId: string,
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
    const row = this.findRow(threadTs, channelId, message);
    // The ask itself is bus liveness (issue #48): stamp the clock, and
    // settle any pending ⚠️ — the gate relayed below owns the thread's
    // attention from here (the settle at the end recomputes the root).
    if (row !== undefined) {
      this.store.recordBusActivity(row.dispatchId);
      this.store.answerStall(row.dispatchId);
    }
    // The row's thread owns the delegation — the human answers there.
    const gateThread = row?.threadTs ?? threadTs;
    const gateChannel = row?.channelId ?? channelId;
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
    const reasked = this.store.listPendingGates(gateThread, gateChannel).find(
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
        await this.surface.update(gateChannel, reasked.relayTs, text);
      } catch (error) {
        this.logger.warn(
          { err: error, threadTs: gateThread, msgId: message.id, relayTs },
          're-asked gate relay edit failed — the original relay still shows the question',
        );
      }
    } else {
      try {
        relayTs = await this.surface.post(gateChannel, gateThread, text);
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
      channelId: gateChannel,
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
    await this.surface.settleRoot(gateChannel, gateThread);
  }

  /**
   * The ledger row behind an event — the ledger owns the identity rules
   * (dispatch id authoritative, task id and asking-terminal fallbacks,
   * issue #20/#21/#25); this only adds the arrival log: a row living in
   * another thread is handled in the ROW's thread, not the mailbox's.
   */
  private findRow(
    threadTs: string,
    channelId: string,
    message: OrchestrationMessage,
  ): DelegationRow | undefined {
    const row = this.store.resolveWorkerEvent(threadTs, channelId, {
      dispatchId: message.payload.dispatchId,
      taskId: message.payload.taskId,
      workerHandle: message.fromHandle,
    });
    if (row !== undefined && (row.threadTs !== threadTs || row.channelId !== channelId)) {
      this.logger.warn(
        { threadTs, rowThreadTs: row.threadTs, dispatchId: row.dispatchId },
        'event arrived on another thread’s mailbox — handling it in the row’s thread',
      );
    }
    return row;
  }

  /** The card's final state — duration and issue link resolved daemon-side. */
  private async finishCard(
    row: DelegationRow,
    message: OrchestrationMessage,
    failed: boolean,
  ): Promise<void> {
    await this.surface.finishCard(row, {
      durationMs: this.now().getTime() - Date.parse(row.dispatchedAt),
      issueUrl: await safeRegistryIssueUrl(this.run, this.logger, row.repo, row.issueNumber),
      reportText: `${message.subject}\n${message.body}`,
      ...(failed && { failureReason: message.subject }),
    });
  }

  private async postSafe(threadTs: string, channelId: string, text: string): Promise<boolean> {
    try {
      await this.surface.post(channelId, threadTs, text);
      return true;
    } catch (error) {
      this.logger.warn({ err: error, threadTs }, 'watcher thread post failed');
      return false;
    }
  }
}

/** The (channel, thread) pair flattened for the loop map (issue #93). */
function loopKey(threadTs: string, channelId: string): string {
  return `${channelId}:${threadTs}`;
}

/** What one window returned: its messages, and the Delivery to acknowledge
 * once they are handled (absent on a timeout and on runtimes before Runs). */
interface CheckWindow {
  messages: OrchestrationMessage[];
  deliveryId?: string;
}

// ── wake texts — what the daemon feeds the session's input pipe ─────────────

/** Worktree name, degrading to the task id — the wake text's reference. */
function delegationRef(row: DelegationRow): string {
  return row.worktreeName ?? row.taskId;
}

/**
 * The worker_done wake: the worker's report plus what is left for the LLM to
 * do — only the summary; the daemon already did the mechanical part.
 */
function workerDoneWakeText(
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
      '(1–2 lines of Slack mrkdwn) — ' +
      (failed
        ? 'start with "❌ Failed —", say what went wrong, '
        : 'start with the PR link when present, then say what changed; without a PR, give the plain report, ') +
      'and end with "Details in the card ⤴". Do not run any commands for this event.',
  ].join('\n');
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

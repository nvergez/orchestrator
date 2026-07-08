import {
  completedCard,
  crudeWorkerEventLine,
  extractPullRequestLinks,
  workerDoneFallbackLine,
} from './messages.ts';
import {
  execFileRunner,
  listRegistryRepos,
  makeExecFileRunner,
  parseOrcaEnvelope,
  type CommandRunner,
} from './orca.ts';
import type { DelegationRow, DelegationStore } from './delegations.ts';
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
 * itself when no session can take the wake. A `decision_gate`/`escalation`
 * arriving before the relay slice (#21) is surfaced crudely but verbatim —
 * never lost — and the wake gives the session the context to relay the
 * human's answer back down.
 *
 * At boot `rearmFromStore` re-arms a watcher for every thread the ledger
 * still shows in flight — which is also what makes a daemon crash safe: the
 * orchestration bus keys messages on the handle string, not on terminal
 * liveness, so a completion sent while nobody listened is still sitting
 * unread when the re-armed check asks for it.
 */

/** What the watcher needs from Slack — posts, card edits, root reactions. */
export interface WatcherSurface {
  /** chat.postMessage into the thread; resolves with the message ts. */
  post(threadTs: string, text: string): Promise<string>;
  /** chat.update on an earlier card. */
  update(ts: string, text: string): Promise<void>;
  /** reactions.add on the root message (ts === threadTs). */
  react(ts: string, name: string): Promise<void>;
  /** reactions.remove — how the stale root reaction comes off (spec §8). */
  unreact(ts: string, name: string): Promise<void>;
}

export type WakeResult = 'turn' | 'skipped';

export interface GateWatcherOptions {
  store: DelegationStore;
  surface: WatcherSurface;
  /** The single pinned channel — where wakes land when a row carries none. */
  channelId: string;
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

const WATCHED_TYPES = 'worker_done,escalation,decision_gate';

/** The root reactions the daemon manages (spec §8) — one on, the rest off. */
const ROOT_REACTIONS = ['eyes', 'white_check_mark', 'x', 'question', 'rotating_light'] as const;

type RootReaction = (typeof ROOT_REACTIONS)[number];

interface OrchestrationMessage {
  id: string;
  type: string;
  subject: string;
  body: string;
  payload: { taskId?: string; dispatchId?: string };
}

export class GateWatcher {
  private readonly store: DelegationStore;
  private readonly surface: WatcherSurface;
  private readonly channelId: string;
  private readonly wake: GateWatcherOptions['wake'];
  private readonly onDelegationClosed: () => void;
  private readonly logger: Logger;
  private readonly windowMs: number;
  private readonly retryDelayMs: number;
  private readonly runCheck: CommandRunner;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private readonly armed = new Set<string>();

  constructor(options: GateWatcherOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.channelId = options.channelId;
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
    if (this.armed.has(threadTs)) return;
    this.armed.add(threadTs);
    void this.watch(threadTs)
      .catch((error: unknown) => {
        this.logger.error({ err: error, threadTs }, 'gate watcher loop crashed');
      })
      .finally(() => this.armed.delete(threadTs));
  }

  isArmed(threadTs: string): boolean {
    return this.armed.has(threadTs);
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
        this.logger.info({ threadTs }, 'no in-flight delegations left — gate watcher stops');
        return;
      }
      const mailbox = this.store.getMailbox(threadTs);
      if (mailbox === undefined) {
        // Unreachable on the normal path — a dispatch cannot happen without
        // the mailbox — but a hand-edited ledger must not spin this loop.
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
    const messages = parseOrcaEnvelope(stdout)?.messages;
    if (!Array.isArray(messages)) {
      throw new Error('unexpected `orca orchestration check` response shape');
    }
    return messages.flatMap(readMessage);
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
    } else {
      this.logger.warn({ threadTs, type: message.type }, 'unwatched event type slipped through');
    }
  }

  /**
   * `worker_done` (issue #20): ledger row closed, card flipped to ✅/❌ with
   * the durable links, root reaction swapped, session woken for the summary.
   * Failure is still a worker_done — the preamble fixes the subject shape
   * ("Failed: <reason>"), which is all the signal there is.
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
    const failed = /^fail/i.test(message.subject.trim());
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
  }

  /**
   * `decision_gate`/`escalation` before the relay slice (#21): the daemon's
   * own verbatim post is the never-lost guarantee; the wake is best-effort
   * context so the session can relay the human's answer back down.
   */
  private async handleGateOrEscalation(
    threadTs: string,
    kind: 'decision_gate' | 'escalation',
    message: OrchestrationMessage,
  ): Promise<void> {
    const row = this.findRow(threadTs, message);
    await this.postSafe(
      threadTs,
      crudeWorkerEventLine({
        kind,
        worktreeName: row?.worktreeName ?? null,
        repo: row?.repo ?? null,
        issueNumber: row?.issueNumber ?? null,
        subject: message.subject,
        body: message.body,
        msgId: message.id,
      }),
    );
    await this.setRootReaction(threadTs, kind === 'escalation' ? 'rotating_light' : 'question');
    this.wake(threadTs, row?.channelId ?? this.channelId, gateWakeText(kind, row, message));
  }

  /**
   * The ledger row behind an event: the payload's dispatch id (authoritative
   * — the preamble makes workers echo it) with the task id as fallback,
   * scoped to the thread. A row living in another thread is trusted over the
   * arrival mailbox — the card to edit lives where the row says.
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
    if (message.payload.taskId === undefined) return undefined;
    return this.store.inFlightByTaskId(threadTs, message.payload.taskId);
  }

  // ── the ✅/❌ card ──────────────────────────────────────────────────────────

  /** The card's final state — or a fresh post when no card ever landed. */
  private async finishCard(
    row: DelegationRow,
    message: OrchestrationMessage,
    failed: boolean,
  ): Promise<void> {
    const text = completedCard({
      repo: row.repo ?? 'work',
      issueNumber: row.issueNumber ?? 0,
      title: row.title ?? row.taskId,
      worktreePath: row.worktreePath,
      durationMs: this.now().getTime() - Date.parse(row.dispatchedAt),
      issueUrl: await this.issueUrl(row),
      prLinks: extractPullRequestLinks(`${message.subject}\n${message.body}`),
      ...(failed && { failureReason: message.subject }),
    });
    try {
      if (row.cardTs === null) {
        await this.surface.post(row.threadTs, text);
      } else {
        await this.surface.update(row.cardTs, text);
      }
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs: row.threadTs, cardTs: row.cardTs },
        'final card edit failed',
      );
    }
  }

  /**
   * The issue link is re-derived from the registry at close time — the
   * ledger row keeps only `repo#n`. Wrapped: a folder repo (no remote) or an
   * unreachable Orca degrades to the plain reference (spec §10).
   */
  private async issueUrl(row: DelegationRow): Promise<string | undefined> {
    if (row.repo === null || row.issueNumber === null) return undefined;
    try {
      const registry = await listRegistryRepos(this.run);
      const key = registry.find((repo) => repo.name === row.repo)?.canonicalKey;
      return key === undefined ? undefined : `https://${key}/issues/${row.issueNumber}`;
    } catch (error) {
      this.logger.warn(
        { err: error, repo: row.repo },
        'registry lookup for the issue link failed — plain reference',
      );
      return undefined;
    }
  }

  // ── root reactions ─────────────────────────────────────────────────────────

  /**
   * Spec §8 coarse state: a failure surfaces as ❌ immediately; a success
   * flips the root to ✅ only once the thread has no other in-flight work —
   * with siblings still running, 👀 stays the honest state.
   */
  private async swapRootReaction(threadTs: string, failed: boolean): Promise<void> {
    if (!failed && this.store.listInFlightForThread(threadTs).length > 0) return;
    await this.setRootReaction(threadTs, failed ? 'x' : 'white_check_mark');
  }

  /** Adds the new root reaction, then clears the other managed ones. */
  private async setRootReaction(threadTs: string, name: RootReaction): Promise<void> {
    try {
      await this.surface.react(threadTs, name);
    } catch (error) {
      this.logger.debug({ err: error, threadTs, name }, 'root reaction add failed');
    }
    for (const stale of ROOT_REACTIONS) {
      if (stale === name) continue;
      try {
        await this.surface.unreact(threadTs, stale);
      } catch (error) {
        // Usually Slack's no_reaction — the stale one simply wasn't set.
        this.logger.debug({ err: error, threadTs, stale }, 'stale reaction removal skipped');
      }
    }
  }

  private async postSafe(threadTs: string, text: string): Promise<void> {
    try {
      await this.surface.post(threadTs, text);
    } catch (error) {
      this.logger.warn({ err: error, threadTs }, 'watcher thread post failed');
    }
  }
}

// ── wake texts — what the daemon feeds the session's input pipe ─────────────

/**
 * The worker_done wake: the worker's report plus what is left for the LLM to
 * do — only the summary; the daemon already did the mechanical part.
 */
export function workerDoneWakeText(
  row: DelegationRow,
  message: { subject: string; body: string },
  failed: boolean,
): string {
  const ref =
    row.repo !== null && row.issueNumber !== null ? `${row.repo}#${row.issueNumber}` : row.taskId;
  const name = row.worktreeName === null ? '' : ` (\`${row.worktreeName}\`)`;
  const report = message.body.trim() === '' ? message.subject : message.body;
  return [
    `[orchestration event — not a human message] worker_done: the delegation ${ref}${name} ` +
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

/**
 * The gate/escalation wake (crude slice): the daemon posted the question
 * verbatim already — the session acknowledges and, when the human answers,
 * relays it back down with `orchestration reply`.
 */
export function gateWakeText(
  kind: 'decision_gate' | 'escalation',
  row: DelegationRow | undefined,
  message: { id: string; subject: string; body: string },
): string {
  const from =
    row === undefined
      ? 'a worker'
      : `the delegation ${row.repo ?? '?'}#${row.issueNumber ?? '?'} (\`${row.worktreeName ?? row.taskId}\`)`;
  return [
    `[orchestration event — not a human message] A ${kind} arrived from ${from}.`,
    `Subject: ${message.subject}`,
    `Body:\n${message.body}`,
    '',
    'The daemon already posted the worker’s message verbatim in the thread and set the root ' +
      'reaction — do NOT repeat the question. Reply with ONE short line telling the user you ' +
      'will relay their answer. When their answer arrives as the next thread message, relay it ' +
      `verbatim (an option number becomes that option’s full text) with:\n` +
      `orca orchestration reply --id ${message.id} --body "<their answer>"`,
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
    payload?: unknown;
  };
  if (typeof record.id !== 'string' || typeof record.type !== 'string') return [];
  return [
    {
      id: record.id,
      type: record.type,
      subject: typeof record.subject === 'string' ? record.subject : '',
      body: typeof record.body === 'string' ? record.body : '',
      payload: readPayload(record.payload),
    },
  ];
}

/** The bus serializes `payload` as a JSON string — `{taskId, dispatchId}`. */
function readPayload(raw: unknown): { taskId?: string; dispatchId?: string } {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as { taskId?: unknown; dispatchId?: unknown };
    return {
      ...(typeof parsed.taskId === 'string' && { taskId: parsed.taskId }),
      ...(typeof parsed.dispatchId === 'string' && { dispatchId: parsed.dispatchId }),
    };
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

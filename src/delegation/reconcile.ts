import { formatDuration, restartNotice } from '../kernel/messages.ts';
import {
  execFileRunner,
  listOrchestrationTasks,
  listRegistryRepos,
  listWorktreeProcesses,
  readCheckMessages,
  type CommandRunner,
  type OrchestrationMessage,
  type WorktreeProcess,
} from '../kernel/orca.ts';
import { isFailureSubject, type ThreadSurface } from './thread-surface.ts';
import type { DelegationRow, DelegationStore } from './delegations.ts';
import type { Logger } from '../kernel/logger.ts';

/**
 * Boot reconciliation (spec §7, issue #25): workers are independent
 * processes — a daemon crash leaves them running, and a `worker_done` sent
 * into the void is still sitting on the bus. At boot, every delegation the
 * ledger still shows dispatched is reconciled against what actually
 * happened — the orchestration task list, the live worktree state, and a
 * READ-ONLY peek at the thread mailbox (`check --all` never marks messages
 * read, so the re-armed gate watcher keeps seeing whatever it would have) —
 * and each affected thread gets exactly ONE ⚠️ line with the observed truth.
 *
 * The boundaries are the point:
 * - never kill or restart a worker — every orca call here is a read, with
 *   ONE write exception: a row closed as completed gets its worktree
 *   removed, the same success cleanup as the live worker_done path (issue
 *   #43) and gated on the same positive signal; failures keep theirs;
 * - never wake a session — completions missed during the outage close their
 *   ledger row and flip their card right here, daemon-side, so no watcher
 *   ever turns them into a wake; the session stays dormant (#5's boot rule)
 *   until the next human message resumes supervision;
 * - never close on absence of evidence — only a positive signal (the
 *   worker's own worker_done, or a terminal task status) ends a row; a
 *   vanished worktree or an unreachable runtime is reported truthfully but
 *   stays supervisable;
 * - never notify twice — the per-thread fingerprint of still-open
 *   delegations and their classes is persisted, and a restart that observes
 *   the same picture posts nothing.
 *
 * Ordering contract with the rest of boot (runtime.ts `boot()`, pinned by
 * runtime.test.ts): reconciliation runs
 * BEFORE the delegation coordinator derives the worker-cap count and BEFORE
 * the gate watchers re-arm — rows closed here free their cap slots by never
 * being counted, and threads left with nothing in flight never arm a
 * watcher, so an outage completion is reported exactly once (a leftover
 * unread worker_done consumed later hits the watcher's duplicate guard,
 * which the store's any-status task-id lookup backstops).
 */

/** What reconciliation concluded about one dispatched row. */
type OutcomeKind = 'completed' | 'failed' | 'in-flight' | 'stalled' | 'unknown';

interface Reconciled {
  row: DelegationRow;
  kind: OutcomeKind;
  /** The observed state, rendered for the ⚠️ line — always the truth we saw. */
  state: string;
  /** The failure wording for the ❌ card, when `kind` is failed. */
  reason?: string;
  /** The peeked worker_done, when the bus had one — carries the PR links. */
  report?: OrchestrationMessage;
}

/** The two kinds that close a ledger row; everything else stays supervisable. */
const isTerminal = (item: Reconciled): item is Reconciled & { kind: 'completed' | 'failed' } =>
  item.kind === 'completed' || item.kind === 'failed';

/** What the task list and the worktree table said, fetched once per boot. */
interface Observations {
  taskStatus: Map<string, string>;
  worktrees: WorktreeProcess[];
}

const COMPLETED_STATE = '✅ completed during the outage (details in the card ⤴)';

const DEFAULT_STALL_AFTER_MS = 15 * 60_000;

export interface BootReconcilerOptions {
  store: DelegationStore;
  surface: ThreadSurface;
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
  now?: () => Date;
  /** A worker quiet longer than this reads as stalled; default 15 min. */
  stallAfterMs?: number;
}

export class BootReconciler {
  private readonly store: DelegationStore;
  private readonly surface: ThreadSurface;
  private readonly logger: Logger;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private readonly stallAfterMs: number;
  /** Lazily fetched `repo list` name → canonical key, for the issue links. */
  private registry: Promise<Map<string, string>> | undefined;

  constructor(options: BootReconcilerOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.logger = options.logger;
    this.run = options.run ?? execFileRunner;
    this.now = options.now ?? (() => new Date());
    this.stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  }

  /** The whole boot pass. Never throws — a failed boot step must not crash the daemon. */
  async reconcile(): Promise<void> {
    const threads = this.store.threadsWithInFlight();
    if (threads.length === 0) {
      this.logger.debug('no in-flight delegations — nothing to reconcile');
      return;
    }
    let observed: Observations | undefined;
    try {
      const [tasks, worktrees] = await Promise.all([
        listOrchestrationTasks(this.run),
        listWorktreeProcesses(this.run),
      ]);
      observed = { taskStatus: new Map(tasks.map((task) => [task.id, task.status])), worktrees };
    } catch (error) {
      // No observations, no conclusions: every row stays as it was and the
      // ⚠️ lines say so — spec §10's "Orca runtime unavailable, never a
      // crash", but the affected threads still hear about the restart.
      this.logger.warn(
        { err: error, threads: threads.length },
        'Orca runtime unavailable — restart notices will say state unknown',
      );
    }
    for (const { threadTs, channelId } of threads) {
      try {
        await this.reconcileThread(threadTs, channelId, observed);
      } catch (error) {
        this.logger.error({ err: error, threadTs }, 'thread reconciliation failed');
      }
    }
  }

  private async reconcileThread(
    threadTs: string,
    channelId: string,
    observed: Observations | undefined,
  ): Promise<void> {
    const rows = this.store.listInFlightForThread(threadTs, channelId);
    if (rows.length === 0) return;
    const items =
      observed === undefined
        ? rows.map(
            (row): Reconciled => ({
              row,
              kind: 'unknown',
              state: 'state unknown (Orca runtime unavailable)',
            }),
          )
        : await this.classifyThread(threadTs, channelId, rows, observed);

    // Close what actually ended — ledger first (the truth), card second (the
    // cosmetics). Closed rows never arm a watcher, so no wake follows.
    const closed: Array<Reconciled & { kind: 'completed' | 'failed' }> = [];
    for (const item of items) {
      if (!isTerminal(item)) continue;
      if (!this.store.closeDelegation(item.row.dispatchId, item.kind)) continue;
      closed.push(item);
      this.logger.info(
        { threadTs, dispatchId: item.row.dispatchId, kind: item.kind },
        'delegation closed by boot reconciliation',
      );
      await this.finishCard(item);
      if (item.kind === 'completed') {
        await this.surface.cleanupDeliveredWorktree(item.row);
      }
    }
    await this.surface.settleReconciled(channelId, threadTs, closed.map((item) => item.kind));

    // Idempotence: the fingerprint captures what stays open and how it
    // looked. A closure always posts (it is new truth, and the closed row
    // cannot re-report — it leaves the dispatched set); an unchanged open
    // picture posts nothing.
    const fingerprint = items
      .filter((item) => !isTerminal(item))
      .map((item) => `${item.row.dispatchId}=${item.kind}`)
      .sort()
      .join('|');
    if (
      closed.length === 0 &&
      this.store.getReconcileFingerprint(threadTs, channelId) === fingerprint
    ) {
      this.logger.info({ threadTs }, 'state unchanged since the last restart — no ⚠️ re-post');
      return;
    }
    const notice = restartNotice(items.map((item) => ({ ref: noticeRef(item.row), state: item.state })));
    try {
      await this.surface.post(channelId, threadTs, notice);
    } catch (error) {
      // Fingerprint deliberately not saved: the next restart tries again.
      this.logger.error({ err: error, threadTs }, 'restart ⚠️ post failed — will retry next boot');
      return;
    }
    this.store.setReconcileFingerprint(threadTs, channelId, fingerprint);
    this.logger.info(
      { threadTs, delegations: items.length, closed: closed.length },
      'restart ⚠️ posted',
    );
  }

  // ── classification ───────────────────────────────────────────────────────

  private async classifyThread(
    threadTs: string,
    channelId: string,
    rows: DelegationRow[],
    observed: Observations,
  ): Promise<Reconciled[]> {
    // The ledger owns the identity rule (`resolveWorkerEvent`, shared with
    // the live watcher): the dispatch id is authoritative, the task id only
    // covers payloads naming no dispatch at all — a report whose ids point
    // elsewhere never closes anything here. First report per delegation wins.
    const reportFor = new Map<string, OrchestrationMessage>();
    for (const message of await this.peekWorkerDones(threadTs, channelId)) {
      const row = this.store.resolveWorkerEvent(threadTs, channelId, {
        dispatchId: message.payload.dispatchId,
        taskId: message.payload.taskId,
      });
      if (row !== undefined && !reportFor.has(row.dispatchId)) {
        reportFor.set(row.dispatchId, message);
      }
    }
    return rows.map((row) => this.classify(row, observed, reportFor.get(row.dispatchId)));
  }

  /**
   * One row against the three observation sources. Precedence: a peeked
   * worker_done is the worker's own word (and the only failure signal with a
   * reason — the "Failed:" subject contract); the task list is authoritative
   * for bare completion; only an unfinished task falls through to worktree
   * liveness. Liveness only ever describes — a worktree that is gone,
   * archived or silent keeps its row open (absence of evidence closes
   * nothing); the human decides in the thread.
   */
  private classify(
    row: DelegationRow,
    observed: Observations,
    report: OrchestrationMessage | undefined,
  ): Reconciled {
    if (report !== undefined) {
      return isFailureSubject(report.subject)
        ? {
            row,
            kind: 'failed',
            state: `❌ failed during the outage — ${report.subject}`,
            reason: report.subject,
            report,
          }
        : { row, kind: 'completed', state: COMPLETED_STATE, report };
    }

    const status = observed.taskStatus.get(row.taskId);
    if (status === 'completed') return { row, kind: 'completed', state: COMPLETED_STATE };
    if (status === 'failed') {
      const reason = 'the task list marked it failed while the daemon was down';
      return { row, kind: 'failed', state: `❌ failed during the outage (${reason})`, reason };
    }

    // The path fallback only covers rows that never learned their worktree
    // id: on folder repos every workspace shares the folder's path, so a
    // recorded-but-vanished id must NOT borrow a sibling's liveness.
    const worktree =
      observed.worktrees.find((candidate) => candidate.worktreeId === row.worktreeId) ??
      (row.worktreeId === null
        ? observed.worktrees.find(
            (candidate) => row.worktreePath !== null && candidate.path === row.worktreePath,
          )
        : undefined);
    if (worktree === undefined) {
      return row.worktreeId === null && row.worktreePath === null
        ? // The ledger row never learned its worktree (a dispatch observed
          // without a matching create) — there is nothing to observe.
          {
            row,
            kind: 'unknown',
            state: 'state unknown — its worktree was never recorded, results stay reachable via the task list',
          }
        : {
            row,
            kind: 'unknown',
            state: 'its worktree is no longer listed — presumed dead',
          };
    }
    if (worktree.isArchived) {
      return {
        row,
        kind: 'stalled',
        state: 'its worktree was archived without a completion — presumed dead',
      };
    }
    if (worktree.liveTerminalCount === 0) {
      return { row, kind: 'stalled', state: 'seems stalled — its worker terminal is gone' };
    }
    const age = worktree.lastOutputAt === null ? null : this.now().getTime() - worktree.lastOutputAt;
    if (age !== null && age > this.stallAfterMs) {
      return { row, kind: 'stalled', state: `seems stalled — no sign for ${formatDuration(age)}` };
    }
    return {
      row,
      kind: 'in-flight',
      state: age === null ? 'still in progress' : `still in progress (last sign ${formatDuration(age)} ago)`,
    };
  }

  /**
   * The thread mailbox, peeked without consuming: `--all` returns every
   * message and marks nothing read (verified against the live runtime), so
   * a worker_done the re-armed watcher would have seen is still there for
   * it — this also recovers the one crash window `--unread` loses (read by
   * a watcher that died before closing the row). Filtered to worker_done
   * client-side belt-and-braces.
   */
  private async peekWorkerDones(
    threadTs: string,
    channelId: string,
  ): Promise<OrchestrationMessage[]> {
    const mailbox = this.store.getMailbox(threadTs, channelId);
    if (mailbox === undefined) return [];
    try {
      const { stdout } = await this.run('orca', [
        'orchestration',
        'check',
        '--all',
        '--terminal',
        mailbox,
        '--types',
        'worker_done',
        '--json',
      ]);
      return readCheckMessages(stdout).messages.filter((message) => message.type === 'worker_done');
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs, mailbox },
        'mailbox peek failed — reconciling from task and worktree state alone',
      );
      return [];
    }
  }

  // ── the closed rows' Slack surface ───────────────────────────────────────

  /** The card's final ✅/❌ state, the same flip the watcher gives a live worker_done. */
  private async finishCard(item: Reconciled): Promise<void> {
    const { row } = item;
    await this.surface.finishCard(row, {
      durationMs: this.now().getTime() - Date.parse(row.dispatchedAt),
      issueUrl: await this.issueUrl(row),
      reportText: item.report === undefined ? '' : `${item.report.subject}\n${item.report.body}`,
      ...(item.kind === 'failed' && { failureReason: item.reason ?? 'lost during the outage' }),
    });
  }

  /** Issue link via the registry, lazily fetched once; degrades to plain refs. */
  private async issueUrl(row: DelegationRow): Promise<string | undefined> {
    if (row.repo === null || row.issueNumber === null) return undefined;
    this.registry ??= listRegistryRepos(this.run)
      .then(
        (repos) =>
          new Map(
            repos.flatMap((repo) =>
              repo.canonicalKey === undefined ? [] : [[repo.name, repo.canonicalKey] as const],
            ),
          ),
      )
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          'registry lookup for the issue links failed — plain references',
        );
        return new Map<string, string>();
      });
    const key = (await this.registry).get(row.repo);
    return key === undefined ? undefined : `https://${key}/issues/${row.issueNumber}`;
  }
}

/**
 * `repo#n`, degrading to the worktree name, then the task id — the ⚠️
 * line's name for a row (plain, per the mock; unlike the watcher's wake-text
 * ref it never appends the worktree name).
 */
function noticeRef(row: DelegationRow): string {
  if (row.repo !== null && row.issueNumber !== null) return `${row.repo}#${row.issueNumber}`;
  return row.worktreeName ?? row.taskId;
}

import { completedCard, extractPullRequestLinks, formatDuration, restartNotice } from './messages.ts';
import {
  execFileRunner,
  listOrchestrationTasks,
  listRegistryRepos,
  listWorktreeProcesses,
  type CommandRunner,
  type WorktreeProcess,
} from './orca.ts';
import {
  applyRootReaction,
  readCheckMessages,
  type OrchestrationMessage,
  type WatcherSurface,
} from './watcher.ts';
import type { DelegationRow, DelegationStore } from './delegations.ts';
import type { Logger } from './logger.ts';

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
 * - never kill or restart a worker — every orca call here is a read;
 * - never wake a session — completions missed during the outage close their
 *   ledger row and flip their card right here, daemon-side, so no watcher
 *   ever turns them into a wake; the session stays dormant (#5's boot rule)
 *   until the next human message resumes supervision;
 * - never notify twice — the per-thread fingerprint of still-open
 *   delegations and their classes is persisted, and a restart that observes
 *   the same picture posts nothing.
 *
 * Ordering contract with the rest of boot (index.ts): reconciliation runs
 * BEFORE the delegation coordinator derives the worker-cap count and BEFORE
 * the gate watchers re-arm — rows closed here free their cap slots by never
 * being counted, and threads left with nothing in flight never arm a
 * watcher, so an outage completion is reported exactly once (a leftover
 * unread worker_done consumed later hits the watcher's duplicate guard).
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

/** The kinds that keep their ledger row open (still supervisable). */
const OPEN_KINDS: ReadonlySet<OutcomeKind> = new Set(['in-flight', 'stalled', 'unknown']);

export interface BootReconcilerOptions {
  store: DelegationStore;
  surface: WatcherSurface;
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
  now?: () => Date;
  /** A worker quiet longer than this reads as stalled; default 15 min. */
  stallAfterMs?: number;
}

const DEFAULT_STALL_AFTER_MS = 15 * 60_000;

export class BootReconciler {
  private readonly store: DelegationStore;
  private readonly surface: WatcherSurface;
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
    let tasks;
    let worktrees: WorktreeProcess[];
    try {
      [tasks, worktrees] = await Promise.all([
        listOrchestrationTasks(this.run),
        listWorktreeProcesses(this.run),
      ]);
    } catch (error) {
      // Without observations there is no truth to post: leave every row as
      // it was — the watchers still re-arm off the ledger and supervision
      // resumes on the next human message (spec §10: degrade, never crash).
      this.logger.warn(
        { err: error, threads: threads.length },
        'Orca runtime unavailable — boot reconciliation skipped',
      );
      return;
    }
    const taskStatus = new Map(tasks.map((task) => [task.id, task.status]));
    for (const { threadTs } of threads) {
      try {
        await this.reconcileThread(threadTs, taskStatus, worktrees);
      } catch (error) {
        this.logger.error({ err: error, threadTs }, 'thread reconciliation failed');
      }
    }
  }

  private async reconcileThread(
    threadTs: string,
    taskStatus: Map<string, string>,
    worktrees: WorktreeProcess[],
  ): Promise<void> {
    const rows = this.store.listInFlightForThread(threadTs);
    if (rows.length === 0) return;
    const reports = await this.peekWorkerDones(threadTs);
    const items = rows.map((row) => this.classify(row, taskStatus, worktrees, reports));

    // Close what actually ended — ledger first (the truth), card second (the
    // cosmetics). Closed rows never arm a watcher, so no wake follows.
    const closed: Reconciled[] = [];
    for (const item of items) {
      if (item.kind !== 'completed' && item.kind !== 'failed') continue;
      if (!this.store.closeDelegation(item.row.dispatchId, item.kind)) continue;
      closed.push(item);
      this.logger.info(
        { threadTs, dispatchId: item.row.dispatchId, kind: item.kind },
        'delegation closed by boot reconciliation',
      );
      await this.finishCard(item);
    }
    await this.updateRootReaction(threadTs, items, closed);

    // Idempotence: the fingerprint captures what stays open and how it
    // looked. A closure always posts (it is new truth, and the closed row
    // cannot re-report — it leaves the dispatched set); an unchanged open
    // picture posts nothing.
    const fingerprint = items
      .filter((item) => OPEN_KINDS.has(item.kind))
      .map((item) => `${item.row.dispatchId}=${item.kind}`)
      .sort()
      .join('|');
    if (closed.length === 0 && this.store.getReconcileFingerprint(threadTs) === fingerprint) {
      this.logger.info({ threadTs }, 'state unchanged since the last restart — no ⚠️ re-post');
      return;
    }
    const notice = restartNotice(items.map((item) => ({ ref: delegationRef(item.row), state: item.state })));
    try {
      await this.surface.post(threadTs, notice);
    } catch (error) {
      // Fingerprint deliberately not saved: the next restart tries again.
      this.logger.error({ err: error, threadTs }, 'restart ⚠️ post failed — will retry next boot');
      return;
    }
    this.store.setReconcileFingerprint(threadTs, fingerprint);
    this.logger.info(
      { threadTs, delegations: items.length, closed: closed.length },
      'restart ⚠️ posted',
    );
  }

  // ── classification ───────────────────────────────────────────────────────

  /**
   * One row against the three observation sources. Precedence: a peeked
   * worker_done is the worker's own word (and the only failure signal with a
   * reason — the "Failed:" subject contract); the task list is authoritative
   * for bare completion; only an unfinished task falls through to worktree
   * liveness. Absence of evidence closes nothing — a row nothing can be
   * observed for stays open rather than being invented dead.
   */
  private classify(
    row: DelegationRow,
    taskStatus: Map<string, string>,
    worktrees: WorktreeProcess[],
    reports: OrchestrationMessage[],
  ): Reconciled {
    const report =
      reports.find((message) => message.payload.dispatchId === row.dispatchId) ??
      // Like the watcher: the task-id fallback only covers payloads that
      // name no dispatch at all — ids pointing elsewhere never match here.
      reports.find(
        (message) =>
          message.payload.dispatchId === undefined && message.payload.taskId === row.taskId,
      );
    if (report !== undefined) {
      const failed = /^fail/i.test(report.subject.trim());
      return failed
        ? {
            row,
            kind: 'failed',
            state: `❌ failed during the outage — ${report.subject}`,
            reason: report.subject,
            report,
          }
        : { row, kind: 'completed', state: COMPLETED_STATE, report };
    }

    const status = taskStatus.get(row.taskId);
    if (status === 'completed') return { row, kind: 'completed', state: COMPLETED_STATE };
    if (status === 'failed') {
      const reason = 'the task list marked it failed while the daemon was down';
      return { row, kind: 'failed', state: `❌ failed during the outage (${reason})`, reason };
    }

    const worktree =
      worktrees.find((candidate) => candidate.worktreeId === row.worktreeId) ??
      worktrees.find((candidate) => row.worktreePath !== null && candidate.path === row.worktreePath);
    if (worktree === undefined) {
      if (row.worktreeId === null && row.worktreePath === null) {
        // The ledger row never learned its worktree (a dispatch observed
        // without a matching create) — there is nothing to observe.
        return {
          row,
          kind: 'unknown',
          state: 'state unknown — its worktree was never recorded, results stay reachable via the task list',
        };
      }
      const reason = 'its worktree is gone without a completion';
      return { row, kind: 'failed', state: `❌ ${reason} — marked failed`, reason };
    }
    if (worktree.isArchived) {
      const reason = 'its worktree was archived without a completion';
      return { row, kind: 'failed', state: `❌ ${reason} — marked failed`, reason };
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
   * message and marks nothing read, so a worker_done the re-armed watcher
   * would have seen is still there for it — this also recovers the one
   * crash window `--unread` loses (read by a watcher that died before
   * closing the row). Filtered to worker_done client-side belt-and-braces.
   */
  private async peekWorkerDones(threadTs: string): Promise<OrchestrationMessage[]> {
    const mailbox = this.store.getMailbox(threadTs);
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

  /** The card's final ✅/❌ state, same mold as the watcher's worker_done flip. */
  private async finishCard(item: Reconciled): Promise<void> {
    const { row } = item;
    const reportText = item.report === undefined ? '' : `${item.report.subject}\n${item.report.body}`;
    const text = completedCard({
      repo: row.repo ?? 'work',
      issueNumber: row.issueNumber ?? 0,
      title: row.title ?? row.taskId,
      worktreePath: row.worktreePath,
      durationMs: this.now().getTime() - Date.parse(row.dispatchedAt),
      issueUrl: await this.issueUrl(row),
      prLinks: extractPullRequestLinks(reportText),
      ...(item.kind === 'failed' && { failureReason: item.reason ?? 'lost during the outage' }),
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
        'reconciliation card flip failed',
      );
    }
  }

  /**
   * Spec §8 coarse state, batch flavor of the watcher's rule: any failure
   * surfaces as ❌; all-clear flips to ✅ only when the thread has nothing
   * left in flight; otherwise 👀 stays the honest state and nothing is
   * touched.
   */
  private async updateRootReaction(
    threadTs: string,
    items: Reconciled[],
    closed: Reconciled[],
  ): Promise<void> {
    const anyFailed = closed.some((item) => item.kind === 'failed');
    const anyOpen = items.some((item) => OPEN_KINDS.has(item.kind));
    if (anyFailed) {
      await applyRootReaction(this.surface, this.logger, threadTs, 'x');
    } else if (closed.length > 0 && !anyOpen) {
      await applyRootReaction(this.surface, this.logger, threadTs, 'white_check_mark');
    }
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

const COMPLETED_STATE = '✅ completed during the outage (details in the card ⤴)';

/** `repo#n`, degrading to the worktree name, then the task id. */
function delegationRef(row: DelegationRow): string {
  if (row.repo !== null && row.issueNumber !== null) return `${row.repo}#${row.issueNumber}`;
  return row.worktreeName ?? row.taskId;
}

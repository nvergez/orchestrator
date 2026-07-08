import { stalledWorkerAlert } from './messages.ts';
import {
  execFileRunner,
  listWorktreeActivity,
  readTerminalTail,
  safeRegistryIssueUrl,
  type CommandRunner,
  type WorktreeActivity,
} from './orca.ts';
import { settleRootReaction, type WatcherSurface } from './watcher.ts';
import type { DelegationRow, DelegationStore } from './delegations.ts';
import type { Logger } from './logger.ts';

/**
 * The second detection layer of spec §5 (issue #22): the authority layer
 * (gate watcher, issue #20/#21) hears workers that SAY something — this
 * periodic daemon sweep catches the ones that fall silent without asking: a
 * TUI prompt nobody answers, an interactive command, an agent that just
 * stopped. It inspects ONLY the worktrees the ledger shows in flight, reads
 * their liveness off one `orca worktree ps` (last output, agent state
 * clocks), and calls a worker stalled when EVERY signal has been silent
 * longer than the threshold — so a healthy long-running worker, whose
 * output or heartbeats keep any clock moving, never alerts.
 *
 * On a stall the daemon posts the ⚠️ alert itself, exactly like a gate
 * relay (issue #21: no LLM turn burns at relay time, no paraphrase can
 * drift in): the mock's mold — worktree + issue link, the last terminal
 * output verbatim, "Tell me what to answer" — plus the 🚨 root reaction.
 * The `stall_alerts` registry row written alongside is what the reply
 * routes back on (relay.ts sanctions the `terminal send` to that worker)
 * and what keeps the alert singular: the row's fingerprint is the stall
 * state's last-activity clock, and a sweep seeing the same fingerprint has
 * already alerted — no repeat spam while nothing changed. Any new signal
 * (the nudge's own echo included) moves the clock, so a worker that stalls
 * AGAIN later is a new state and alerts anew.
 *
 * A worker whose pending gate this thread already relayed is skipped: it
 * did ask, the ❓/🚨 relay owns the thread's attention (spec §5: "stalled
 * WITHOUT a message").
 */

export interface WatchdogOptions {
  store: DelegationStore;
  surface: WatcherSurface;
  /** Silence across every worktree signal before a worker counts as stalled. */
  stallAfterMs: number;
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
  now?: () => Date;
}

/** How much of the worker terminal the alert quotes. */
const TAIL_READ_LINES = 40;
const TAIL_KEEP_LINES = 8;
const TAIL_KEEP_CHARS = 600;

export class Watchdog {
  private readonly store: DelegationStore;
  private readonly surface: WatcherSurface;
  private readonly stallAfterMs: number;
  private readonly logger: Logger;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  /** A slow orca call must not let interval ticks pile up sweeps. */
  private sweeping = false;

  constructor(options: WatchdogOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.stallAfterMs = options.stallAfterMs;
    this.logger = options.logger;
    this.run = options.run ?? execFileRunner;
    this.now = options.now ?? (() => new Date());
  }

  /** One pass over the in-flight delegations; resolves with the alerts posted. */
  async sweep(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    try {
      return await this.sweepOnce();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce(): Promise<number> {
    const inFlight = this.store.listInFlight();
    if (inFlight.length === 0) return 0;

    let activity: Map<string, WorktreeActivity>;
    try {
      activity = await listWorktreeActivity(this.run);
    } catch (error) {
      // Spec §10: an unreachable runtime is a log line, never a crash — and
      // never a false alert; the next sweep looks again.
      this.logger.warn({ err: error }, 'watchdog sweep skipped — worktree ps unavailable');
      return 0;
    }

    let alerts = 0;
    for (const row of inFlight) {
      if (await this.inspect(row, activity)) alerts += 1;
    }
    return alerts;
  }

  /** One delegation against its worktree's liveness; true when a ⚠️ posted. */
  private async inspect(
    row: DelegationRow,
    activity: Map<string, WorktreeActivity>,
  ): Promise<boolean> {
    if (row.worktreeId === null) {
      this.logger.debug(
        { dispatchId: row.dispatchId },
        'in-flight delegation without a worktree id — watchdog cannot inspect it',
      );
      return false;
    }
    const signals = activity.get(row.worktreeId);
    if (signals === undefined) {
      // The worktree left the runtime (archived, deleted) — that is boot-
      // reconciliation territory (spec §7), not a prompt to nudge.
      this.logger.warn(
        { dispatchId: row.dispatchId, worktreeId: row.worktreeId },
        'in-flight delegation whose worktree is missing from `worktree ps` — skipped',
      );
      return false;
    }

    const lastActivityAt = lastSignalAt(row, signals);
    const stalledForMs = this.now().getTime() - lastActivityAt;
    if (stalledForMs < this.stallAfterMs) return false;

    // One alert per stall state: same last-activity clock ⇒ already alerted
    // — unless that alert never reached Slack AND nobody answered it through
    // the turn context, in which case nobody has seen it and the next sweep
    // retries the post rather than losing the stall to a transient error.
    const fingerprint = String(lastActivityAt);
    const existing = this.store.getStall(row.dispatchId);
    if (
      existing?.fingerprint === fingerprint &&
      (existing.relayTs !== null || existing.status === 'answered')
    ) {
      return false;
    }

    // A worker with a pending relayed gate DID ask — spec §5's watchdog only
    // covers the silent stall; the ❓/🚨 gate relay owns this one.
    if (
      row.workerHandle !== null &&
      this.store
        .listPendingGates(row.threadTs)
        .some((gate) => gate.workerHandle === row.workerHandle)
    ) {
      this.logger.debug(
        { dispatchId: row.dispatchId, workerHandle: row.workerHandle },
        'stalled worker has a pending relayed gate — the gate, not the watchdog, is the state',
      );
      return false;
    }

    await this.alert(row, stalledForMs, fingerprint);
    return true;
  }

  /** The relay-up: ⚠️ message, registry row, 🚨 root — the gates' mold (#21). */
  private async alert(row: DelegationRow, stalledForMs: number, fingerprint: string): Promise<void> {
    const lastOutput = await this.readTail(row);

    let relayTs: string | null = null;
    try {
      relayTs = await this.surface.post(
        row.threadTs,
        stalledWorkerAlert({
          worktreeName: row.worktreeName,
          repo: row.repo,
          issueNumber: row.issueNumber,
          issueUrl: await safeRegistryIssueUrl(this.run, this.logger, row.repo, row.issueNumber),
          stalledForMs,
          lastOutput,
        }),
      );
    } catch (error) {
      this.logger.error(
        { err: error, threadTs: row.threadTs, dispatchId: row.dispatchId },
        'stall alert post failed — the registry row below still holds the stall, and the next sweep retries the post',
      );
    }
    // worker_done can land while this alert was in flight: a closed
    // delegation must neither gain a pending stall row (a sanctioned AUTO
    // send target backing no in-flight work) nor have its fresh ✅ root
    // re-stamped 🚨 — the posted ⚠️ is simply superseded by the ✅ that
    // follows it in the thread.
    if (this.store.getByDispatchId(row.dispatchId)?.status !== 'dispatched') {
      this.logger.info(
        { threadTs: row.threadTs, dispatchId: row.dispatchId },
        'delegation closed while its stall alert posted — nothing registered',
      );
      return;
    }
    this.store.recordStall({
      dispatchId: row.dispatchId,
      threadTs: row.threadTs,
      workerHandle: row.workerHandle,
      worktreeName: row.worktreeName,
      lastOutput,
      fingerprint,
      relayTs,
    });
    this.logger.info(
      {
        threadTs: row.threadTs,
        dispatchId: row.dispatchId,
        worktreeName: row.worktreeName,
        workerHandle: row.workerHandle,
        stalledForMs,
      },
      'stalled worker alerted — needs attention',
    );
    await settleRootReaction(this.store, this.surface, this.logger, row.threadTs);
  }

  /** The worker terminal's tail, truncated for the alert; '' when unreadable. */
  private async readTail(row: DelegationRow): Promise<string> {
    if (row.workerHandle === null) return '';
    try {
      const tail = await readTerminalTail(this.run, row.workerHandle, TAIL_READ_LINES);
      return truncateTail(tail);
    } catch (error) {
      this.logger.warn(
        { err: error, dispatchId: row.dispatchId, workerHandle: row.workerHandle },
        'worker terminal unreadable — alerting without the last output',
      );
      return '';
    }
  }

}

/**
 * The newest liveness signal the runtime reports for the delegation's
 * worktree: terminal output, any agent pane's state clocks — a busy agent
 * keeps these moving, which is what keeps healthy long-runners silent. The
 * dispatch time is the floor, so a worktree the runtime reports nothing for
 * still stalls (once) instead of hiding forever, and never before the
 * delegation itself is older than the threshold.
 */
function lastSignalAt(row: DelegationRow, activity: WorktreeActivity): number {
  const signals = [Date.parse(row.dispatchedAt)];
  if (activity.lastOutputAt !== null) signals.push(activity.lastOutputAt);
  for (const agent of activity.agents) {
    if (agent.updatedAt !== null) signals.push(agent.updatedAt);
    if (agent.stateStartedAt !== null) signals.push(agent.stateStartedAt);
  }
  return Math.max(...signals.filter(Number.isFinite));
}

// eslint-disable-next-line no-control-regex -- ANSI escapes are control chars
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * The alert quotes the END of the terminal (the prompt lives there): ANSI
 * stripped, trailing blank lines dropped, the last few lines kept, and a
 * leading `…` owning up to anything cut.
 */
export function truncateTail(lines: string[]): string {
  const cleaned = lines.map((line) => line.replaceAll(ANSI_ESCAPES, '').trimEnd());
  while (cleaned.length > 0 && cleaned.at(-1) === '') cleaned.pop();
  while (cleaned.length > 0 && cleaned[0] === '') cleaned.shift();
  const kept = cleaned.slice(-TAIL_KEEP_LINES);
  let text = kept.join('\n');
  if (text.length > TAIL_KEEP_CHARS) {
    text = text.slice(-TAIL_KEEP_CHARS);
    text = text.slice(text.indexOf('\n') === -1 ? 0 : text.indexOf('\n') + 1);
  }
  return kept.length < cleaned.length || text.length < kept.join('\n').length
    ? `…\n${text}`
    : text;
}

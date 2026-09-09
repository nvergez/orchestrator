import { commandSegments, flagCount, flagValue, hasFlag, isOrcaCommand, shellQuote } from '../kernel/guardrails.ts';
import {
  CREATE_STEP,
  DISPATCH_STEP,
  MAILBOX_FROM_RULE,
  TASK_CREATE_STEP,
  flagViolation,
} from '../kernel/protocol.ts';
import { delegationCard, milestoneLine, orcaUnavailableLine, workerCapLine } from '../kernel/messages.ts';
import {
  bindRun,
  createRun,
  createTerminal,
  execFileRunner,
  listLiveTerminalHandles,
  listRegistryRepos,
  parseOrcaEnvelope,
  type CommandRunner,
} from '../kernel/orca.ts';
import { titleFromName } from './worktree-name.ts';
import type { RequestKind } from '../kernel/requests.ts';
import type { ThreadSurface } from './thread-surface.ts';
import type { DelegationStore } from './delegations.ts';
import type { Logger } from '../kernel/logger.ts';

/**
 * The daemon half of the delegation happy path (spec §5, issue #19). The
 * session runs the dispatch sequence itself over Bash — that is why #17 made
 * it AUTO tier — and this coordinator rides along at the two seams the SDK
 * gives the daemon:
 *
 * - `prepare` (from canUseTool, before a command runs): holds the global
 *   concurrent-worker cap — an over-cap `worktree create` suspends until a
 *   slot frees, so multi-repo fan-out proceeds in waves — pins the #4 flag
 *   invariants from the protocol table (kernel/protocol.ts, the same table
 *   the routing prose renders from), and rewrites EVERY `orca orchestration`
 *   command to originate from the thread's mailbox terminal as `--from`
 *   (lazily created, SQLite-persisted, reused — issue #9), the terminal the
 *   thread's Orca Run is bound to (ADR 0006).
 * - `observe` (from the PostToolUse hook, after a command ran): reads the
 *   `--json` envelopes the sequence produces, posts the one delegation card
 *   per hand-off and edits it at milestones only, puts 👀 on the root
 *   message, and writes the `delegations` ledger row at dispatch.
 *
 * Every orca call made here daemon-side is wrapped: an unreachable runtime
 * becomes a clear thread line, never a crash (spec §10).
 */

export type PrepareVerdict =
  | { action: 'proceed'; command: string }
  | { action: 'deny'; message: string };

/** The slice canUseTool drives right before allowing a Bash command. */
export interface DispatchPreparer {
  prepare(
    threadTs: string,
    channelId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<PrepareVerdict>;
}

/** The slice the PostToolUse hook feeds and the process lifecycle clears. */
export interface DispatchObserver {
  observe(threadTs: string, channelId: string, command: string, stdout: string): Promise<void>;
  abandonThread(threadTs: string, channelId: string): void;
}

export interface DelegationCoordinatorOptions {
  store: DelegationStore;
  /** The thread surface — cards, milestone edits, the working 👀. */
  surface: ThreadSurface;
  /** Global cap on concurrent workers (spec §5) — env `WORKER_CAP`. */
  workerCap: number;
  /** The Orca worktree the mailbox terminals live in — the daemon's own checkout. */
  mailboxWorktreePath: string;
  /** Fires after every ledgered dispatch — how the gate watcher arms (#20). */
  onDispatched?: (threadTs: string, channelId: string) => void;
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
  now?: () => Date;
}

interface PendingDelegation {
  worktreeId: string;
  name: string;
  path: string;
  repo: string | null;
  issueNumber: number | null;
  agent: string | null;
  kind: RequestKind;
  issueUrl?: string;
  title: string;
  taskId?: string;
  cardTs: string | null;
  milestones: string[];
  /** True while this delegation owns one of the worker-cap slots. */
  holdsSlot: boolean;
}

interface ThreadTracker {
  preparedRepos: Map<string, { repo: string; issueUrl?: string }>;
  /** Un-dispatched delegations, keyed by worktree id. */
  pending: Map<string, PendingDelegation>;
  /** Worker terminal handle → worktree id, learned from `terminal list`. */
  handles: Map<string, string>;
  /** Handles whose TUI reached idle (`terminal wait --for tui-idle` succeeded). */
  waited: Set<string>;
  /** Task id → title, learned from `task-create`. */
  taskTitles: Map<string, string>;
  /** Slots acquired in prepare but not yet claimed by an observed create. */
  looseSlots: number;
}

export class DelegationCoordinator implements DispatchPreparer, DispatchObserver {
  private readonly store: DelegationStore;
  private readonly surface: ThreadSurface;
  private readonly mailboxWorktreePath: string;
  private readonly onDispatched: (threadTs: string, channelId: string) => void;
  private readonly logger: Logger;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private readonly slots: WorkerSlots;
  /** One tracker per thread, keyed `channelId:threadTs` (issue #93). */
  private readonly threads = new Map<string, ThreadTracker>();

  constructor(options: DelegationCoordinatorOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.mailboxWorktreePath = options.mailboxWorktreePath;
    this.onDispatched = options.onDispatched ?? (() => undefined);
    this.logger = options.logger;
    this.run = options.run ?? execFileRunner;
    this.now = options.now ?? (() => new Date());
    // The ledger is the single owner of in-flight counting: the cap reads
    // it live, so workers already in flight at boot hold their slots and a
    // dispatch is counted the moment it is ledgered — nothing to re-derive,
    // nothing that can drift between boots.
    this.slots = new WorkerSlots(options.workerCap, () => this.store.inFlightCount());
  }

  // ── prepare: the canUseTool seam ───────────────────────────────────────────

  async prepare(
    threadTs: string,
    channelId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<PrepareVerdict> {
    const segments = commandSegments(command);
    const creates = segments.filter((tokens) =>
      isOrcaCommand(tokens, CREATE_STEP.topic, CREATE_STEP.action),
    );
    const orchestrations = segments.filter(isOrchestrationCommand);
    if (creates.length === 0 && orchestrations.length === 0) {
      return { action: 'proceed', command };
    }
    // One step per command: the observer maps one --json envelope to one
    // segment, and the --from rewrite must know exactly what it appends to.
    if (segments.length > 1) {
      return deny(
        'run `orca worktree create` and every `orca orchestration …` step as its own ' +
          'command — one delegation step per Bash call, nothing chained around it',
      );
    }
    if (creates.length === 1) {
      return this.prepareCreate(threadTs, channelId, command, creates[0] as string[], signal);
    }
    const tokens = orchestrations[0] as string[];
    if (isOrcaCommand(tokens, DISPATCH_STEP.topic, DISPATCH_STEP.action)) {
      return this.prepareDispatch(threadTs, channelId, tokens);
    }
    return this.prepareOrchestration(threadTs, channelId, tokens);
  }

  /** Pins the #4 create invariants, then takes a worker slot — waiting its wave. */
  private async prepareCreate(
    threadTs: string,
    channelId: string,
    command: string,
    tokens: string[],
    signal?: AbortSignal,
  ): Promise<PrepareVerdict> {
    const violation = flagViolation(CREATE_STEP, tokens);
    if (violation !== undefined) return deny(violation);
    const name = flagValue(tokens, '--name');
    const issue = flagValue(tokens, '--issue');
    const repoRef = flagValue(tokens, '--repo');
    if (tokens.some((token) => token.includes('$')) || ['--name', '--repo', '--issue'].some((flag) => flagCount(tokens, flag) > 1)) {
      return deny('use one literal --name, --repo and optional --issue value');
    }
    if (hasFlag(tokens, '--issue') && (issue === undefined || !/^[1-9]\d*$/.test(issue))) return deny('--issue must be a positive issue number');
    let identity: { repo: string; issueUrl?: string };
    try {
      identity = await this.repoIdentity(repoRef, numberOrNull(issue));
    } catch (error) {
      return deny(`Orca target repo could not be resolved: ${String(error)}`);
    }
    const repo = identity.repo;
    if (name === undefined || !name.startsWith(`${repo}-`) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.slice(repo.length + 1))) {
      return deny(
        'the worktree name must follow `<repo>-<slug>` using the selected repo name (spec §5) — fix the --name and retry',
      );
    }

    if (!this.slots.tryReserve()) {
      this.logger.info(
        { threadTs, inFlight: this.slots.inUse },
        'worker cap reached — delegation waits its wave',
      );
      await this.postSafe(threadTs, channelId, workerCapLine(this.slots.inUse));
      try {
        await this.slots.reserve(signal);
      } catch {
        return deny('the turn was interrupted while waiting for a worker slot — nothing was created');
      }
    }
    this.tracker(threadTs, channelId).preparedRepos.set(name, identity);
    this.tracker(threadTs, channelId).looseSlots += 1;
    return { action: 'proceed', command };
  }

  /**
   * Enforces the tail of the §5 order — the dispatch may only target a
   * handle this thread has listed and awaited to TUI-idle — plus --inject,
   * then rewrites the dispatch to origin from the mailbox.
   */
  private async prepareDispatch(
    threadTs: string,
    channelId: string,
    tokens: string[],
  ): Promise<PrepareVerdict> {
    const violation = flagViolation(DISPATCH_STEP, tokens);
    if (violation !== undefined) return deny(violation);
    if (tokens.some((token) => token.includes('$'))) {
      return deny(
        'shell variables cannot travel through the dispatch rewrite — ' +
          'spell out the literal task id and terminal handle',
      );
    }
    const tracker = this.tracker(threadTs, channelId);
    const toHandle = flagValue(tokens, '--to');
    if (toHandle === undefined || !tracker.handles.has(toHandle)) {
      return deny(
        'this thread has not listed that worker terminal — run ' +
          '`orca terminal list --worktree id:<worktreeId> --json` first (spec §5 order)',
      );
    }
    if (!tracker.waited.has(toHandle)) {
      return deny(
        'the worker TUI has not been awaited — run ' +
          '`orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json` ' +
          'first, so the injection lands on an idle prompt (spec §5 order)',
      );
    }
    return this.originateFromMailbox(threadTs, channelId, tokens, 'nothing was dispatched');
  }

  /**
   * Every other `orca orchestration` command the session runs — `task-create`
   * (step 4), the gate `reply`, the read-only inspections — originates from
   * the mailbox too (ADR 0006): the runtime refuses a sender-less command
   * and files a task under the sender's Run, so a session-chosen `--from`
   * would detach the worker's reports from this thread. The mailbox's
   * Delivery acknowledgements belong to the gate watcher alone.
   */
  private async prepareOrchestration(
    threadTs: string,
    channelId: string,
    tokens: string[],
  ): Promise<PrepareVerdict> {
    const action = orchestrationAction(tokens);
    if (action === TASK_CREATE_STEP.action) {
      const violation = flagViolation(TASK_CREATE_STEP, tokens);
      if (violation !== undefined) return deny(violation);
    } else if (hasFlag(tokens, MAILBOX_FROM_RULE.flag)) {
      return deny(`never pass ${MAILBOX_FROM_RULE.flag} — ${MAILBOX_FROM_RULE.why} (spec §5)`);
    }
    if (action === 'check' && hasFlag(tokens, '--ack')) {
      return deny(
        'never acknowledge a mailbox Delivery yourself — the daemon owns `check --ack` ' +
          "for this thread's mailbox, and an early ack would lose worker events",
      );
    }
    return this.originateFromMailbox(threadTs, channelId, tokens, 'the command did not run');
  }

  /**
   * The tail every orchestration command shares: rebuilt from the
   * quote-stripped tokens with the thread mailbox as `--from`, so the flag
   * lands on the command itself — never glued onto a trailing quote or
   * comment — and the runtime files the call under the mailbox's Run.
   * `consequence` is what the ⚠️ line and the deny say did not happen.
   */
  private async originateFromMailbox(
    threadTs: string,
    channelId: string,
    tokens: string[],
    consequence: string,
  ): Promise<PrepareVerdict> {
    let mailbox: string;
    try {
      mailbox = await this.ensureMailbox(threadTs, channelId);
    } catch (error) {
      this.logger.warn(
        { err: error, threadTs, step: orchestrationAction(tokens) },
        'mailbox terminal unavailable — orchestration command denied',
      );
      await this.postSafe(
        threadTs,
        channelId,
        orcaUnavailableLine(`the thread mailbox terminal could not be reached, so ${consequence}.`),
      );
      return deny(
        'Orca runtime unavailable — the thread mailbox terminal could not be created, ' +
          `so ${consequence}. The user already sees a ⚠️ line; ` +
          'acknowledge briefly and do not retry until asked.',
      );
    }
    const rewritten = [...tokens, '--from', mailbox].map(shellQuote).join(' ');
    this.logger.info(
      { threadTs, mailbox, step: orchestrationAction(tokens) },
      'orchestration command rewritten to originate from the thread mailbox',
    );
    return { action: 'proceed', command: rewritten };
  }

  /**
   * The thread's mailbox terminal (`slack-<channel_id>-<thread_ts>`, issue
   * #9): reused from SQLite when the handle is still live, lazily
   * (re)created otherwise. The title carries the channel (issue #93) so two
   * same-ts threads in different channels never share one; pre-#93 handles
   * keep their old title and keep working. Since Orca 1.4.198 the mailbox
   * also carries the thread's Run (ADR 0006): bound once per handle and
   * remembered beside it, re-bound to a recreated handle so workers still
   * in flight keep reporting into the same inbox. Throws when Orca is
   * unreachable — the caller turns that into the ⚠️ line.
   */
  private async ensureMailbox(threadTs: string, channelId: string): Promise<string> {
    const stored = this.store.getMailbox(threadTs, channelId);
    if (stored !== undefined && (await listLiveTerminalHandles(this.run)).has(stored)) {
      await this.ensureRun(threadTs, channelId, stored);
      return stored;
    }
    const previousRun = this.store.getMailboxRun(threadTs, channelId);
    const handle = await createTerminal(this.run, {
      worktreePath: this.mailboxWorktreePath,
      title: mailboxTitle(channelId, threadTs),
    });
    // Handle first, Run second: a bind that fails must find this very
    // terminal again on the retry, not leak one more per attempt.
    this.store.setMailbox(threadTs, channelId, handle);
    this.logger.info({ threadTs, channelId, handle }, 'mailbox terminal created and persisted');
    if (previousRun !== undefined) {
      try {
        await bindRun(this.run, { from: handle, runId: previousRun });
        this.store.setMailboxRun(threadTs, channelId, previousRun);
        this.logger.info(
          { threadTs, channelId, handle, runId: previousRun },
          'recreated mailbox re-bound to its Run — in-flight workers still reach it',
        );
        return handle;
      } catch (error) {
        this.logger.warn(
          { err: error, threadTs, runId: previousRun },
          'previous Run could not be re-bound to the recreated mailbox — binding a fresh one',
        );
      }
    }
    await this.ensureRun(threadTs, channelId, handle);
    return handle;
  }

  /** Binds the mailbox's Run once (ADR 0006), remembering it beside the handle. */
  private async ensureRun(threadTs: string, channelId: string, mailbox: string): Promise<void> {
    if (this.store.getMailboxRun(threadTs, channelId) !== undefined) return;
    const runId = await createRun(this.run, {
      from: mailbox,
      objective: mailboxTitle(channelId, threadTs),
    });
    this.store.setMailboxRun(threadTs, channelId, runId);
    this.logger.info({ threadTs, channelId, mailbox, runId }, 'Run bound to the thread mailbox and persisted');
  }

  // ── observe: the PostToolUse seam ──────────────────────────────────────────

  /** Reads a finished command's output. Never throws — hooks must not crash a turn. */
  async observe(threadTs: string, channelId: string, command: string, stdout: string): Promise<void> {
    try {
      for (const tokens of commandSegments(command)) {
        if (isOrcaCommand(tokens, CREATE_STEP.topic, CREATE_STEP.action)) {
          await this.observeCreate(threadTs, channelId, tokens, stdout);
        } else if (isOrcaCommand(tokens, 'terminal', 'list')) {
          this.observeTerminalList(threadTs, channelId, stdout);
        } else if (isOrcaCommand(tokens, 'terminal', 'wait')) {
          this.observeTerminalWait(threadTs, channelId, tokens, stdout);
        } else if (isOrcaCommand(tokens, 'orchestration', 'task-create')) {
          this.observeTaskCreate(threadTs, channelId, stdout);
        } else if (isOrcaCommand(tokens, DISPATCH_STEP.topic, DISPATCH_STEP.action)) {
          await this.observeDispatch(threadTs, channelId, stdout);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, threadTs, command }, 'delegation observer failed on a command');
    }
  }

  /** Worktree created → claim the slot, post the card, 👀 on the root. */
  private async observeCreate(
    threadTs: string,
    channelId: string,
    tokens: string[],
    stdout: string,
  ): Promise<void> {
    const tracker = this.tracker(threadTs, channelId);
    const worktree = parseOrcaEnvelope(stdout)?.worktree as
      | { id?: unknown; repoId?: unknown; path?: unknown; displayName?: unknown; linkedIssue?: unknown }
      | undefined;
    if (
      typeof worktree?.id !== 'string' ||
      typeof worktree.path !== 'string' ||
      typeof worktree.displayName !== 'string'
    ) {
      // The create failed (or printed something unreadable): the slot
      // reserved in prepare backs no worker, so it goes back to the pool.
      if (tracker.looseSlots > 0) {
        tracker.looseSlots -= 1;
        this.slots.cancel();
      }
      this.logger.warn({ threadTs }, 'worktree create yielded no worktree — reservation cancelled');
      return;
    }

    const name = worktree.displayName;
    const issueNumber = numberOrNull(flagValue(tokens, '--issue'));
    let identity: { repo: string | null; issueUrl?: string } = tracker.preparedRepos.get(name) ?? { repo: null };
    tracker.preparedRepos.delete(name);
    if (identity.repo === null) {
      try {
        identity = await this.repoIdentity(flagValue(tokens, '--repo'), issueNumber);
      } catch (error) {
        this.logger.warn({ err: error, name }, 'created worktree repo could not be resolved');
      }
    }
    const { repo, issueUrl } = identity;

    const pending: PendingDelegation = {
      worktreeId: worktree.id,
      name,
      path: worktree.path,
      repo,
      issueNumber,
      agent: flagValue(tokens, '--agent') ?? null,
      kind: flagValue(tokens, '--comment') === 'question' ? 'question' : 'change',
      issueUrl,
      title: titleFromName(name, repo ?? ''),
      cardTs: null,
      milestones: [milestoneLine(this.clock(), issueNumber === null ? 'worktree ready' : 'issue linked, worktree ready')],
      holdsSlot: tracker.looseSlots > 0,
    };
    if (tracker.looseSlots > 0) tracker.looseSlots -= 1;
    tracker.pending.set(pending.worktreeId, pending);

    try {
      pending.cardTs = await this.surface.post(channelId, threadTs, this.renderCard(pending));
    } catch (error) {
      // The dispatch milestone retries the post — the card may still catch up.
      this.logger.warn({ err: error, threadTs }, 'delegation card post failed');
    }
    await this.surface.ackWorking(channelId, threadTs);
  }

  /** A successful tui-idle wait clears that handle for injection (spec §5). */
  private observeTerminalWait(
    threadTs: string,
    channelId: string,
    tokens: string[],
    stdout: string,
  ): void {
    if (flagValue(tokens, '--for') !== 'tui-idle' || parseOrcaEnvelope(stdout) === null) return;
    const handle = flagValue(tokens, '--terminal');
    if (handle !== undefined) this.tracker(threadTs, channelId).waited.add(handle);
  }

  /** `terminal list` output teaches us which handle belongs to which worktree. */
  private observeTerminalList(threadTs: string, channelId: string, stdout: string): void {
    const terminals = parseOrcaEnvelope(stdout)?.terminals;
    if (!Array.isArray(terminals)) return;
    const tracker = this.tracker(threadTs, channelId);
    for (const terminal of terminals) {
      const { handle, worktreeId } = terminal as { handle?: unknown; worktreeId?: unknown };
      if (typeof handle === 'string' && typeof worktreeId === 'string') {
        tracker.handles.set(handle, worktreeId);
      }
    }
  }

  /** `task-create` output carries the real title — the card upgrades to it. */
  private observeTaskCreate(threadTs: string, channelId: string, stdout: string): void {
    const task = parseOrcaEnvelope(stdout)?.task as
      | { id?: unknown; task_title?: unknown; display_name?: unknown }
      | undefined;
    if (typeof task?.id !== 'string') return;
    const tracker = this.tracker(threadTs, channelId);
    const title = typeof task.task_title === 'string' && task.task_title !== '' ? task.task_title : undefined;
    if (title !== undefined) tracker.taskTitles.set(task.id, title);

    const pending =
      this.matchByDisplayName(tracker, task.display_name) ?? this.singlePending(tracker);
    if (pending === undefined) return;
    pending.taskId = task.id;
    if (title !== undefined) pending.title = title;
  }

  /** Dispatch succeeded → milestone edit + the ledger row, all identifiers. */
  private async observeDispatch(threadTs: string, channelId: string, stdout: string): Promise<void> {
    const dispatch = parseOrcaEnvelope(stdout)?.dispatch as
      | { id?: unknown; task_id?: unknown; assignee_handle?: unknown }
      | undefined;
    if (typeof dispatch?.id !== 'string' || typeof dispatch.task_id !== 'string') return;
    const workerHandle = typeof dispatch.assignee_handle === 'string' ? dispatch.assignee_handle : null;

    const tracker = this.tracker(threadTs, channelId);
    const byHandle = workerHandle === null ? undefined : tracker.handles.get(workerHandle);
    const pending =
      (byHandle !== undefined ? tracker.pending.get(byHandle) : undefined) ??
      [...tracker.pending.values()].find((candidate) => candidate.taskId === dispatch.task_id) ??
      this.singlePending(tracker);
    if (pending === undefined) {
      this.logger.warn(
        { threadTs, dispatchId: dispatch.id, taskId: dispatch.task_id },
        'dispatch observed without a matching worktree — ledger row will carry nulls',
      );
    } else {
      pending.title = tracker.taskTitles.get(dispatch.task_id) ?? pending.title;
      pending.milestones.push(
        milestoneLine(this.clock(), `brief handed off (task \`${dispatch.task_id}\`)`),
      );
      // Card first, ledger second, so the row carries the card's ts.
      try {
        if (pending.cardTs === null) {
          pending.cardTs = await this.surface.post(channelId, threadTs, this.renderCard(pending));
        } else {
          await this.surface.update(channelId, pending.cardTs, this.renderCard(pending));
        }
      } catch (error) {
        this.logger.warn({ err: error, threadTs }, 'delegation card milestone edit failed');
      }
      tracker.pending.delete(pending.worktreeId);
    }

    this.store.recordDispatch({
      taskId: dispatch.task_id,
      dispatchId: dispatch.id,
      worktreeId: pending?.worktreeId ?? null,
      worktreeName: pending?.name ?? null,
      worktreePath: pending?.path ?? null,
      repo: pending?.repo ?? null,
      issueNumber: pending?.issueNumber ?? null,
      agent: pending?.agent ?? null,
      kind: pending?.kind ?? null,
      workerHandle,
      threadTs,
      channelId,
      cardTs: pending?.cardTs ?? null,
      title: pending?.title ?? tracker.taskTitles.get(dispatch.task_id) ?? null,
    });
    // The ledger row just written is what the cap counts from here — the
    // reservation that covered the create→dispatch window retires. Ledger
    // first, then confirm, so the count never dips below the truth. A
    // dispatch whose reservation was released earlier (an abandoned thread)
    // is simply counted now — the ledger, not slot bookkeeping, is the cap.
    if (pending !== undefined && pending.holdsSlot) {
      pending.holdsSlot = false;
      this.slots.confirm();
    }
    this.logger.info(
      { threadTs, dispatchId: dispatch.id, taskId: dispatch.task_id, workerHandle },
      'delegation dispatched and ledgered',
    );
    // The row is in flight from here — the thread needs its gate watcher.
    this.onDispatched(threadTs, channelId);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * The thread's session process died or its turn failed: reservations for
   * work that will never be dispatched go back to the pool. Tracker state
   * stays — a cold-resumed session may still dispatch a worktree it created
   * earlier, and the card association survives; that dispatch is counted
   * the moment it is ledgered, reservation or not.
   */
  abandonThread(threadTs: string, channelId: string): void {
    const tracker = this.threads.get(trackerKey(threadTs, channelId));
    if (tracker === undefined) return;
    let released = tracker.looseSlots;
    tracker.looseSlots = 0;
    for (const pending of tracker.pending.values()) {
      if (pending.holdsSlot) {
        pending.holdsSlot = false;
        released += 1;
      }
    }
    for (let i = 0; i < released; i += 1) this.slots.cancel();
    if (released > 0) {
      this.logger.info({ threadTs, released }, 'cancelled worker reservations of an abandoned thread');
    }
  }

  /** A delegation left the in-flight set (slice #20): the ledger row is
   * already closed — the freed capacity admits the next waiting wave. */
  onDelegationClosed(): void {
    this.slots.admit();
  }

  /**
   * Whether the thread holds created-but-not-yet-dispatched worktrees
   * (issue #49): they carry a 👀-backed card but no ledger row yet, so the
   * turn-end settle must ask here — the registries cannot see this window.
   */
  hasUndispatched(threadTs: string, channelId: string): boolean {
    return (this.threads.get(trackerKey(threadTs, channelId))?.pending.size ?? 0) > 0;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private tracker(threadTs: string, channelId: string): ThreadTracker {
    const key = trackerKey(threadTs, channelId);
    let tracker = this.threads.get(key);
    if (tracker === undefined) {
      tracker = {
        preparedRepos: new Map(),
        pending: new Map(),
        handles: new Map(),
        waited: new Set(),
        taskTitles: new Map(),
        looseSlots: 0,
      };
      this.threads.set(key, tracker);
    }
    return tracker;
  }

  /** Resolve identity from the command's --repo, never from a worktree name. */
  private async repoIdentity(
    repoRef: string | undefined,
    issueNumber: number | null,
  ): Promise<{ repo: string; issueUrl?: string }> {
    if (repoRef === undefined) throw new Error('worktree create carried no --repo');
    const registry = await listRegistryRepos(this.run);
    const typed = /^(id|name):(.*)$/.exec(repoRef);
    const kind = typed?.[1];
    const ref = typed?.[2] ?? repoRef;
    const repo = registry.find((candidate) =>
      (kind !== 'name' && candidate.id === ref) || (kind !== 'id' && candidate.name === ref),
    );
    if (repo === undefined) throw new Error(`repo ${repoRef} not in the registry`);
    const issueUrl = repo.canonicalKey !== undefined && issueNumber !== null
      ? `https://${repo.canonicalKey}/issues/${issueNumber}`
      : undefined;
    return { repo: repo.name, ...(issueUrl !== undefined && { issueUrl }) };
  }

  private matchByDisplayName(
    tracker: ThreadTracker,
    displayName: unknown,
  ): PendingDelegation | undefined {
    if (typeof displayName !== 'string') return undefined;
    return [...tracker.pending.values()].find((pending) => pending.name === displayName);
  }

  private singlePending(tracker: ThreadTracker): PendingDelegation | undefined {
    return tracker.pending.size === 1 ? [...tracker.pending.values()][0] : undefined;
  }

  private renderCard(pending: PendingDelegation): string {
    return delegationCard({
      repo: pending.repo ?? 'work',
      issueNumber: pending.issueNumber,
      kind: pending.kind,
      title: pending.title,
      worktreeName: pending.name,
      agent: pending.agent ?? 'claude',
      issueUrl: pending.issueUrl,
      milestones: pending.milestones,
    });
  }

  /** Local wall-clock HH:MM, like the mock's card milestones. */
  private clock(): string {
    const now = this.now();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  }

  private async postSafe(threadTs: string, channelId: string, text: string): Promise<void> {
    try {
      await this.surface.post(channelId, threadTs, text);
    } catch (error) {
      this.logger.warn({ err: error, threadTs }, 'delegation thread post failed');
    }
  }
}

/** The (channel, thread) pair flattened for the tracker map (issue #93). */
function trackerKey(threadTs: string, channelId: string): string {
  return `${channelId}:${threadTs}`;
}

/** The mailbox terminal's title — and its Run's objective (issue #93, ADR 0006). */
function mailboxTitle(channelId: string, threadTs: string): string {
  return `slack-${channelId}-${threadTs}`;
}

/** Any `orca orchestration …` segment — every one originates from the mailbox. */
function isOrchestrationCommand(tokens: string[]): boolean {
  return orchestrationIndex(tokens) !== -1;
}

/** The `<action>` after `orchestration` — `task-create`, `reply`, `check`… */
function orchestrationAction(tokens: string[]): string | undefined {
  const index = orchestrationIndex(tokens);
  return index === -1 ? undefined : tokens[index + 1];
}

/** Where the `orchestration` topic sits in an orca segment — the word as a
 * flag's value (`terminal send --text orchestration`) is not the topic. */
function orchestrationIndex(tokens: string[]): number {
  if (tokens[0] !== 'orca') return -1;
  return tokens.findIndex(
    (token, index) =>
      index > 0 && token === 'orchestration' && !(tokens[index - 1] as string).startsWith('--'),
  );
}

/**
 * The admission gate behind the concurrent-worker cap (spec §5). The ledger
 * is the single owner of in-flight counting — `inUse` reads it live and only
 * adds the reservations covering the create→dispatch window (a slot taken in
 * prepare that no ledger row backs yet), so the cap can never drift from the
 * ledger: a dispatch is counted the moment it is ledgered, whatever became
 * of its reservation. FIFO, so waved-off delegations start in the order they
 * asked; the ledger count may exceed the capacity after a config change —
 * reservations then wait until enough in-flight workers finish.
 */
class WorkerSlots {
  private readonly capacity: number;
  /** The ledger's live in-flight count — never cached, never re-derived. */
  private readonly ledgered: () => number;
  /** Slots reserved in prepare that no ledger row backs yet. */
  private reserved = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (reason: Error) => void }> = [];

  constructor(capacity: number, ledgered: () => number) {
    this.capacity = capacity;
    this.ledgered = ledgered;
  }

  get inUse(): number {
    return this.ledgered() + this.reserved;
  }

  tryReserve(): boolean {
    if (this.inUse >= this.capacity) return false;
    this.reserved += 1;
    return true;
  }

  reserve(signal?: AbortSignal): Promise<void> {
    if (this.tryReserve()) return Promise.resolve();
    if (signal?.aborted === true) {
      return Promise.reject(new Error('aborted before a worker slot freed'));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (reason: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(reason);
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.reject(new Error('aborted while waiting for a worker slot'));
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort);
    });
  }

  /** The reservation backs no worker after all (a failed create, an
   * abandoned thread) — the freed capacity admits the next wave. */
  cancel(): void {
    if (this.reserved > 0) this.reserved -= 1;
    this.admit();
  }

  /** The reservation's dispatch was ledgered — the ledger counts the worker
   * from here, so the reservation retires without freeing capacity. */
  confirm(): void {
    if (this.reserved > 0) this.reserved -= 1;
  }

  /**
   * Capacity may have freed (a delegation closed in the ledger, a
   * reservation cancelled) — admit waiters only while the cap truly covers
   * them: after a WORKER_CAP decrease, over-cap in-flight workers must
   * drain below the new cap before any wave proceeds.
   */
  admit(): void {
    while (this.waiters.length > 0 && this.inUse < this.capacity) {
      this.reserved += 1;
      this.waiters.shift()?.resolve();
    }
  }
}

// ── command & envelope reading ───────────────────────────────────────────────

const deny = (message: string): PrepareVerdict => ({ action: 'deny', message });

function numberOrNull(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isInteger(parsed) ? parsed : null;
}

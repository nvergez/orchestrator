import { commandSegments, flagValue, isOrcaCommand, shellQuote } from '../kernel/guardrails.ts';
import { CREATE_STEP, DISPATCH_STEP, flagViolation } from '../kernel/protocol.ts';
import { delegationCard, milestoneLine, orcaUnavailableLine, workerCapLine } from '../kernel/messages.ts';
import {
  createTerminal,
  execFileRunner,
  listLiveTerminalHandles,
  listRegistryRepos,
  parseOrcaEnvelope,
  type CommandRunner,
} from '../kernel/orca.ts';
import { issueFromName, repoFromName, titleFromName } from './worktree-name.ts';
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
 *   the routing prose renders from), and rewrites the dispatch to carry the
 *   thread's mailbox terminal as `--from` (lazily created, SQLite-persisted,
 *   reused — issue #9).
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
  prepare(threadTs: string, command: string, signal?: AbortSignal): Promise<PrepareVerdict>;
}

/** The slice the PostToolUse hook feeds and the process lifecycle clears. */
export interface DispatchObserver {
  observe(threadTs: string, command: string, stdout: string): Promise<void>;
  abandonThread(threadTs: string): void;
}

export interface DelegationCoordinatorOptions {
  store: DelegationStore;
  /** The thread surface — cards, milestone edits, the working 👀. */
  surface: ThreadSurface;
  channelId: string;
  /** Global cap on concurrent workers (spec §5) — env `WORKER_CAP`. */
  workerCap: number;
  /** The Orca worktree the mailbox terminals live in — the daemon's own checkout. */
  mailboxWorktreePath: string;
  /** Fires after every ledgered dispatch — how the gate watcher arms (#20). */
  onDispatched?: (threadTs: string) => void;
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
  now?: () => Date;
}

interface PendingDelegation {
  worktreeId: string;
  name: string;
  path: string;
  repo: string;
  issueNumber: number | null;
  agent: string | null;
  issueUrl?: string;
  title: string;
  taskId?: string;
  cardTs: string | null;
  milestones: string[];
  /** True while this delegation owns one of the worker-cap slots. */
  holdsSlot: boolean;
}

interface ThreadTracker {
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
  private readonly channelId: string;
  private readonly mailboxWorktreePath: string;
  private readonly onDispatched: (threadTs: string) => void;
  private readonly logger: Logger;
  private readonly run: CommandRunner;
  private readonly now: () => Date;
  private readonly slots: WorkerSlots;
  private readonly threads = new Map<string, ThreadTracker>();

  constructor(options: DelegationCoordinatorOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.channelId = options.channelId;
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

  async prepare(threadTs: string, command: string, signal?: AbortSignal): Promise<PrepareVerdict> {
    const segments = commandSegments(command);
    const creates = segments.filter((tokens) =>
      isOrcaCommand(tokens, CREATE_STEP.topic, CREATE_STEP.action),
    );
    const dispatches = segments.filter((tokens) =>
      isOrcaCommand(tokens, DISPATCH_STEP.topic, DISPATCH_STEP.action),
    );
    if (creates.length === 0 && dispatches.length === 0) {
      return { action: 'proceed', command };
    }
    // One step per command: the observer maps one --json envelope to one
    // segment, and the --from rewrite must know exactly what it appends to.
    if (segments.length > 1) {
      return deny(
        'run `orca worktree create` / `orca orchestration dispatch` as its own ' +
          'command — one delegation step per Bash call, nothing chained around it',
      );
    }
    if (creates.length === 1) return this.prepareCreate(threadTs, command, creates[0] as string[], signal);
    return this.prepareDispatch(threadTs, dispatches[0] as string[]);
  }

  /** Pins the #4 create invariants, then takes a worker slot — waiting its wave. */
  private async prepareCreate(
    threadTs: string,
    command: string,
    tokens: string[],
    signal?: AbortSignal,
  ): Promise<PrepareVerdict> {
    const violation = flagViolation(CREATE_STEP, tokens);
    if (violation !== undefined) return deny(violation);
    const name = flagValue(tokens, '--name');
    const issue = flagValue(tokens, '--issue');
    if (name === undefined || issue === undefined || issueFromName(name) !== Number(issue)) {
      return deny(
        'the worktree name must follow `<repo>-<issue#>-<slug>` with the same ' +
          'issue number as --issue (spec §5) — fix the --name and retry',
      );
    }

    if (!this.slots.tryReserve()) {
      this.logger.info(
        { threadTs, inFlight: this.slots.inUse },
        'worker cap reached — delegation waits its wave',
      );
      await this.postSafe(threadTs, workerCapLine(this.slots.inUse));
      try {
        await this.slots.reserve(signal);
      } catch {
        return deny('the turn was interrupted while waiting for a worker slot — nothing was created');
      }
    }
    this.tracker(threadTs).looseSlots += 1;
    return { action: 'proceed', command };
  }

  /**
   * Enforces the tail of the §5 order — the dispatch may only target a
   * handle this thread has listed and awaited to TUI-idle — plus --inject,
   * then rewrites the dispatch to origin from the mailbox.
   */
  private async prepareDispatch(threadTs: string, tokens: string[]): Promise<PrepareVerdict> {
    const violation = flagViolation(DISPATCH_STEP, tokens);
    if (violation !== undefined) return deny(violation);
    if (tokens.some((token) => token.includes('$'))) {
      return deny(
        'shell variables cannot travel through the dispatch rewrite — ' +
          'spell out the literal task id and terminal handle',
      );
    }
    const tracker = this.tracker(threadTs);
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
    let mailbox: string;
    try {
      mailbox = await this.ensureMailbox(threadTs);
    } catch (error) {
      this.logger.warn({ err: error, threadTs }, 'mailbox terminal unavailable — dispatch denied');
      await this.postSafe(
        threadTs,
        orcaUnavailableLine('the thread mailbox terminal could not be reached, so nothing was dispatched.'),
      );
      return deny(
        'Orca runtime unavailable — the thread mailbox terminal could not be created, ' +
          'so the dispatch was not run. The user already sees a ⚠️ line; ' +
          'acknowledge briefly and do not retry until asked.',
      );
    }
    // Rebuilt from the quote-stripped tokens so the --from lands on the
    // dispatch itself — never glued onto a trailing quote or comment.
    const rewritten = [...tokens, '--from', mailbox].map(shellQuote).join(' ');
    this.logger.info({ threadTs, mailbox }, 'dispatch rewritten to origin from the thread mailbox');
    return { action: 'proceed', command: rewritten };
  }

  /**
   * The thread's mailbox terminal (`slack-<thread_ts>`, issue #9): reused
   * from SQLite when the handle is still live, lazily (re)created otherwise.
   * Throws when Orca is unreachable — the caller turns that into the ⚠️ line.
   */
  private async ensureMailbox(threadTs: string): Promise<string> {
    const stored = this.store.getMailbox(threadTs);
    if (stored !== undefined && (await listLiveTerminalHandles(this.run)).has(stored)) {
      return stored;
    }
    const handle = await createTerminal(this.run, {
      worktreePath: this.mailboxWorktreePath,
      title: `slack-${threadTs}`,
    });
    this.store.setMailbox(threadTs, this.channelId, handle);
    this.logger.info({ threadTs, handle }, 'mailbox terminal created and persisted');
    return handle;
  }

  // ── observe: the PostToolUse seam ──────────────────────────────────────────

  /** Reads a finished command's output. Never throws — hooks must not crash a turn. */
  async observe(threadTs: string, command: string, stdout: string): Promise<void> {
    try {
      for (const tokens of commandSegments(command)) {
        if (isOrcaCommand(tokens, CREATE_STEP.topic, CREATE_STEP.action)) {
          await this.observeCreate(threadTs, tokens, stdout);
        } else if (isOrcaCommand(tokens, 'terminal', 'list')) {
          this.observeTerminalList(threadTs, stdout);
        } else if (isOrcaCommand(tokens, 'terminal', 'wait')) {
          this.observeTerminalWait(threadTs, tokens, stdout);
        } else if (isOrcaCommand(tokens, 'orchestration', 'task-create')) {
          this.observeTaskCreate(threadTs, stdout);
        } else if (isOrcaCommand(tokens, DISPATCH_STEP.topic, DISPATCH_STEP.action)) {
          await this.observeDispatch(threadTs, stdout);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, threadTs, command }, 'delegation observer failed on a command');
    }
  }

  /** Worktree created → claim the slot, post the card, 👀 on the root. */
  private async observeCreate(threadTs: string, tokens: string[], stdout: string): Promise<void> {
    const tracker = this.tracker(threadTs);
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
    // prepare enforced --issue, so the token fallback keeps repo#n honest
    // even when the runtime omits linkedIssue from the envelope.
    const issueNumber =
      typeof worktree.linkedIssue === 'number'
        ? worktree.linkedIssue
        : (issueFromName(name) ?? numberOrNull(flagValue(tokens, '--issue')));
    const { repo, issueUrl } = await this.repoIdentity(
      typeof worktree.repoId === 'string' ? worktree.repoId : undefined,
      name,
      issueNumber,
    );

    const pending: PendingDelegation = {
      worktreeId: worktree.id,
      name,
      path: worktree.path,
      repo,
      issueNumber,
      agent: flagValue(tokens, '--agent') ?? null,
      issueUrl,
      title: titleFromName(name),
      cardTs: null,
      milestones: [milestoneLine(this.clock(), 'issue linked, worktree ready')],
      holdsSlot: tracker.looseSlots > 0,
    };
    if (tracker.looseSlots > 0) tracker.looseSlots -= 1;
    tracker.pending.set(pending.worktreeId, pending);

    try {
      pending.cardTs = await this.surface.post(threadTs, this.renderCard(pending));
    } catch (error) {
      // The dispatch milestone retries the post — the card may still catch up.
      this.logger.warn({ err: error, threadTs }, 'delegation card post failed');
    }
    await this.surface.ackWorking(threadTs);
  }

  /** A successful tui-idle wait clears that handle for injection (spec §5). */
  private observeTerminalWait(threadTs: string, tokens: string[], stdout: string): void {
    if (flagValue(tokens, '--for') !== 'tui-idle' || parseOrcaEnvelope(stdout) === null) return;
    const handle = flagValue(tokens, '--terminal');
    if (handle !== undefined) this.tracker(threadTs).waited.add(handle);
  }

  /** `terminal list` output teaches us which handle belongs to which worktree. */
  private observeTerminalList(threadTs: string, stdout: string): void {
    const terminals = parseOrcaEnvelope(stdout)?.terminals;
    if (!Array.isArray(terminals)) return;
    const tracker = this.tracker(threadTs);
    for (const terminal of terminals) {
      const { handle, worktreeId } = terminal as { handle?: unknown; worktreeId?: unknown };
      if (typeof handle === 'string' && typeof worktreeId === 'string') {
        tracker.handles.set(handle, worktreeId);
      }
    }
  }

  /** `task-create` output carries the real title — the card upgrades to it. */
  private observeTaskCreate(threadTs: string, stdout: string): void {
    const task = parseOrcaEnvelope(stdout)?.task as
      | { id?: unknown; task_title?: unknown; display_name?: unknown }
      | undefined;
    if (typeof task?.id !== 'string') return;
    const tracker = this.tracker(threadTs);
    const title = typeof task.task_title === 'string' && task.task_title !== '' ? task.task_title : undefined;
    if (title !== undefined) tracker.taskTitles.set(task.id, title);

    const pending =
      this.matchByDisplayName(tracker, task.display_name) ?? this.singlePending(tracker);
    if (pending === undefined) return;
    pending.taskId = task.id;
    if (title !== undefined) pending.title = title;
  }

  /** Dispatch succeeded → milestone edit + the ledger row, all identifiers. */
  private async observeDispatch(threadTs: string, stdout: string): Promise<void> {
    const dispatch = parseOrcaEnvelope(stdout)?.dispatch as
      | { id?: unknown; task_id?: unknown; assignee_handle?: unknown }
      | undefined;
    if (typeof dispatch?.id !== 'string' || typeof dispatch.task_id !== 'string') return;
    const workerHandle = typeof dispatch.assignee_handle === 'string' ? dispatch.assignee_handle : null;

    const tracker = this.tracker(threadTs);
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
          pending.cardTs = await this.surface.post(threadTs, this.renderCard(pending));
        } else {
          await this.surface.update(pending.cardTs, this.renderCard(pending));
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
      workerHandle,
      threadTs,
      channelId: this.channelId,
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
    this.onDispatched(threadTs);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * The thread's session process died or its turn failed: reservations for
   * work that will never be dispatched go back to the pool. Tracker state
   * stays — a cold-resumed session may still dispatch a worktree it created
   * earlier, and the card association survives; that dispatch is counted
   * the moment it is ledgered, reservation or not.
   */
  abandonThread(threadTs: string): void {
    const tracker = this.threads.get(threadTs);
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
  hasUndispatched(threadTs: string): boolean {
    return (this.threads.get(threadTs)?.pending.size ?? 0) > 0;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private tracker(threadTs: string): ThreadTracker {
    let tracker = this.threads.get(threadTs);
    if (tracker === undefined) {
      tracker = {
        pending: new Map(),
        handles: new Map(),
        waited: new Set(),
        taskTitles: new Map(),
        looseSlots: 0,
      };
      this.threads.set(threadTs, tracker);
    }
    return tracker;
  }

  /** Registry lookup for the card header — wrapped, degrading to name parsing. */
  private async repoIdentity(
    repoId: string | undefined,
    worktreeName: string,
    issueNumber: number | null,
  ): Promise<{ repo: string; issueUrl?: string }> {
    try {
      if (repoId === undefined) throw new Error('worktree create output carried no repoId');
      const registry = await listRegistryRepos(this.run);
      const repo = registry.find((candidate) => candidate.id === repoId);
      if (repo === undefined) throw new Error(`repo ${repoId} not in the registry`);
      const issueUrl =
        repo.canonicalKey !== undefined && issueNumber !== null
          ? `https://${repo.canonicalKey}/issues/${issueNumber}`
          : undefined;
      return { repo: repo.name, ...(issueUrl !== undefined && { issueUrl }) };
    } catch (error) {
      this.logger.warn(
        { err: error, worktreeName },
        'registry lookup for the card failed — falling back to the worktree name',
      );
      return { repo: repoFromName(worktreeName) };
    }
  }

  private matchByDisplayName(
    tracker: ThreadTracker,
    displayName: unknown,
  ): PendingDelegation | undefined {
    if (typeof displayName !== 'string') return undefined;
    const match = /^(.+)#(\d+)$/.exec(displayName);
    if (match === null) return undefined;
    for (const pending of tracker.pending.values()) {
      if (pending.repo === match[1] && pending.issueNumber === Number(match[2])) return pending;
    }
    return undefined;
  }

  private singlePending(tracker: ThreadTracker): PendingDelegation | undefined {
    return tracker.pending.size === 1 ? [...tracker.pending.values()][0] : undefined;
  }

  private renderCard(pending: PendingDelegation): string {
    return delegationCard({
      repo: pending.repo,
      issueNumber: pending.issueNumber ?? 0,
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

  private async postSafe(threadTs: string, text: string): Promise<void> {
    try {
      await this.surface.post(threadTs, text);
    } catch (error) {
      this.logger.warn({ err: error, threadTs }, 'delegation thread post failed');
    }
  }
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

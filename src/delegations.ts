import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One row of the `delegations` table (spec §9) — written at dispatch. */
export interface DelegationRow {
  taskId: string;
  /** The orchestration dispatch id (`ctx_…`) — unique per hand-off. */
  dispatchId: string;
  /** Null only when the daemon could not associate the dispatch (logged). */
  worktreeId: string | null;
  worktreeName: string | null;
  worktreePath: string | null;
  repo: string | null;
  issueNumber: number | null;
  agent: string | null;
  /** The worker terminal the brief was injected into (`term_…`). */
  workerHandle: string | null;
  threadTs: string;
  channelId: string;
  /** Slack ts of the delegation card — how later slices edit it to ✅/❌. */
  cardTs: string | null;
  title: string | null;
  status: 'dispatched' | 'completed' | 'failed';
  dispatchedAt: string;
  closedAt: string | null;
}

/** One row of the `pending_gates` registry (spec §9) — written at relay time. */
export interface PendingGateRow {
  /** The bus message id (`msg_…`) — what `orchestration reply --id` targets. */
  msgId: string;
  threadTs: string;
  taskId: string | null;
  /** The asking terminal — where a `terminal send` fallback/correction lands. */
  workerHandle: string | null;
  worktreeName: string | null;
  kind: 'decision_gate' | 'escalation';
  /** The worker's question, verbatim — the relay never paraphrases it. */
  question: string;
  /** The `ask --options` list, in order; empty when the ask was free-form. */
  options: string[];
  /** Slack ts of the relayed gate message; null when the post failed. */
  relayTs: string | null;
  status: 'pending' | 'answered';
  relayedAt: string;
  answeredAt: string | null;
}

/**
 * The `delegations` + `mailboxes` + `pending_gates` share of the orchestrator
 * state database (spec §9), sharing the SQLite file with SessionStore — same
 * synchronous single-writer design. The delegations ledger is written at
 * dispatch and closed on `worker_done` (slice #20); it is what boot
 * reconciliation and the worker-cap count survive restarts on. The mailboxes
 * table remembers each thread's coordinator terminal (`slack-<thread_ts>`,
 * issue #9) so a thread's dispatches all share one origin handle across
 * daemon restarts. The pending_gates registry is written by the daemon at
 * relay time (issue #21) and anchors the routing of human answers back down.
 *
 * Unlike `sessions`, both tables key on `thread_ts` alone — deliberate: the
 * daemon serves the single pinned channel (spec §2), and the coordinator
 * side only ever sees a thread ts. `channel_id` is stored so the rows stay
 * self-describing, not to disambiguate.
 */
export class DelegationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(dbPath: string, now: () => string = () => new Date().toISOString()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegations (
        dispatch_id   TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        worktree_id   TEXT,
        worktree_name TEXT,
        worktree_path TEXT,
        repo          TEXT,
        issue_number  INTEGER,
        agent         TEXT,
        worker_handle TEXT,
        thread_ts     TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        card_ts       TEXT,
        title         TEXT,
        status        TEXT NOT NULL DEFAULT 'dispatched'
                      CHECK (status IN ('dispatched', 'completed', 'failed')),
        dispatched_at TEXT NOT NULL,
        closed_at     TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mailboxes (
        thread_ts  TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        handle     TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reconciliations (
        thread_ts   TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        posted_at   TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pending_gates (
        msg_id        TEXT PRIMARY KEY,
        thread_ts     TEXT NOT NULL,
        task_id       TEXT,
        worker_handle TEXT,
        worktree_name TEXT,
        kind          TEXT NOT NULL
                      CHECK (kind IN ('decision_gate', 'escalation')),
        question      TEXT NOT NULL,
        options       TEXT NOT NULL,
        relay_ts      TEXT,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'answered')),
        relayed_at    TEXT NOT NULL,
        answered_at   TEXT
      ) STRICT;
    `);
  }

  /**
   * Writes the ledger row at dispatch. Keyed on dispatch_id, and a replay of
   * the same dispatch overwrites rather than double-counts — the id is
   * runtime-issued, so two rows with one id can only be the same hand-off.
   */
  recordDispatch(
    row: Omit<DelegationRow, 'status' | 'dispatchedAt' | 'closedAt'>,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO delegations
           (dispatch_id, task_id, worktree_id, worktree_name, worktree_path,
            repo, issue_number, agent, worker_handle, thread_ts, channel_id,
            card_ts, title, status, dispatched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', ?)`,
      )
      .run(
        row.dispatchId,
        row.taskId,
        row.worktreeId,
        row.worktreeName,
        row.worktreePath,
        row.repo,
        row.issueNumber,
        row.agent,
        row.workerHandle,
        row.threadTs,
        row.channelId,
        row.cardTs,
        row.title,
        this.now(),
      );
  }

  /**
   * Closes the ledger row when the delegation leaves the in-flight set (a
   * `worker_done`, issue #20). Only an in-flight row closes — the boolean
   * says whether this call won, so a duplicated worker_done can neither
   * double-close nor release a second worker slot.
   */
  closeDelegation(dispatchId: string, status: 'completed' | 'failed'): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE delegations SET status = ?, closed_at = ?
         WHERE dispatch_id = ? AND status = 'dispatched'`,
      )
      .run(status, this.now(), dispatchId);
    return Number(changes) > 0;
  }

  getByDispatchId(dispatchId: string): DelegationRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE dispatch_id = ?')
      .get(dispatchId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /**
   * Fallback association for a worker_done whose payload lost the dispatch
   * id: the thread's newest in-flight row for that task. Scoped to the
   * thread — the mailbox the event arrived on — so the runtime-global bus
   * can never close another thread's delegation.
   */
  inFlightByTaskId(threadTs: string, taskId: string): DelegationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND task_id = ? AND status = 'dispatched'
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(threadTs, taskId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /**
   * Fallback association for a `decision_gate` (issue #21): a worker's `ask`
   * carries no task or dispatch id in its payload — the asking terminal
   * (`from_handle`) is the only identity it has. Same thread scoping as the
   * task-id fallback, newest first.
   */
  inFlightByWorkerHandle(threadTs: string, workerHandle: string): DelegationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND worker_handle = ? AND status = 'dispatched'
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(threadTs, workerHandle) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /**
   * The thread's newest row for a task, ANY status (issue #25): after boot
   * reconciliation closes an outage completion, the re-armed watcher can
   * still consume the same worker_done — a taskId-only payload must resolve
   * to the closed row (and hit the duplicate guard) instead of surfacing as
   * an unknown worker.
   */
  latestByTaskId(threadTs: string, taskId: string): DelegationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND task_id = ?
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(threadTs, taskId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /** The thread's in-flight delegations — what keeps its watcher armed (#20). */
  listInFlightForThread(threadTs: string): DelegationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND status = 'dispatched' ORDER BY dispatched_at`,
      )
      .all(threadTs) as Array<Record<string, unknown>>;
    return rows.map(toDelegationRow);
  }

  /** Every thread with in-flight work — the boot re-arm reads this (#20). */
  threadsWithInFlight(): Array<{ threadTs: string; channelId: string }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT thread_ts, channel_id FROM delegations
         WHERE status = 'dispatched' ORDER BY thread_ts`,
      )
      .all() as Array<{ thread_ts: string; channel_id: string }>;
    return rows.map((row) => ({ threadTs: row.thread_ts, channelId: row.channel_id }));
  }

  /** Delegations still in flight — what the worker cap counts at boot. */
  inFlightCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM delegations WHERE status = 'dispatched'`)
      .get() as { n: number };
    return Number(row.n);
  }

  /** All of a thread's delegations, oldest first — the 🔚 summary's ledger. */
  listForThread(threadTs: string): DelegationRow[] {
    const rows = this.db
      .prepare('SELECT * FROM delegations WHERE thread_ts = ? ORDER BY dispatched_at')
      .all(threadTs) as Array<Record<string, unknown>>;
    return rows.map(toDelegationRow);
  }

  countForThread(threadTs: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM delegations WHERE thread_ts = ?')
      .get(threadTs) as { n: number };
    return Number(row.n);
  }

  /** The thread's mailbox terminal handle, if one was ever created (issue #9). */
  getMailbox(threadTs: string): string | undefined {
    const row = this.db
      .prepare('SELECT handle FROM mailboxes WHERE thread_ts = ?')
      .get(threadTs) as { handle: string } | undefined;
    return row?.handle;
  }

  /** Remembers (or replaces, after a stale-handle recreate) the thread's mailbox. */
  setMailbox(threadTs: string, channelId: string, handle: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO mailboxes (thread_ts, channel_id, handle, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(threadTs, channelId, handle, this.now());
  }

  /**
   * The thread's last posted boot-reconciliation fingerprint (issue #25) — a
   * canonical string of the still-open delegations and their observed
   * classes. Repeated restarts with unchanged state compare equal here and
   * post no second ⚠️ line.
   */
  getReconcileFingerprint(threadTs: string): string | undefined {
    const row = this.db
      .prepare('SELECT fingerprint FROM reconciliations WHERE thread_ts = ?')
      .get(threadTs) as { fingerprint: string } | undefined;
    return row?.fingerprint;
  }

  /** Remembers what the thread's ⚠️ line last reported (issue #25). */
  setReconcileFingerprint(threadTs: string, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reconciliations (thread_ts, fingerprint, posted_at)
         VALUES (?, ?, ?)`,
      )
      .run(threadTs, fingerprint, this.now());
  }

  /**
   * Registers a relayed gate (issue #21). First relay wins — the bus id is
   * runtime-unique, so a replayed event must neither re-post nor flip an
   * already-answered gate back to pending; the boolean says whether this
   * call inserted the row.
   */
  recordGate(
    row: Omit<PendingGateRow, 'status' | 'relayedAt' | 'answeredAt'>,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO pending_gates
           (msg_id, thread_ts, task_id, worker_handle, worktree_name,
            kind, question, options, relay_ts, status, relayed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        row.msgId,
        row.threadTs,
        row.taskId,
        row.workerHandle,
        row.worktreeName,
        row.kind,
        row.question,
        JSON.stringify(row.options),
        row.relayTs,
        this.now(),
      );
    return Number(changes) > 0;
  }

  getGate(msgId: string): PendingGateRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM pending_gates WHERE msg_id = ?')
      .get(msgId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toPendingGateRow(row);
  }

  /** All of a thread's relayed gates, oldest first — the turn-context list. */
  listGatesForThread(threadTs: string): PendingGateRow[] {
    const rows = this.db
      .prepare('SELECT * FROM pending_gates WHERE thread_ts = ? ORDER BY relayed_at, msg_id')
      .all(threadTs) as Array<Record<string, unknown>>;
    return rows.map(toPendingGateRow);
  }

  /** The thread's unanswered gates — what the root reaction and routing read. */
  listPendingGates(threadTs: string): PendingGateRow[] {
    return this.listGatesForThread(threadTs).filter((gate) => gate.status === 'pending');
  }

  /**
   * Flips a gate to answered when its reply went down (issue #21). Only a
   * pending gate flips — the boolean says whether this call won, which is
   * what "an answered gate never re-routes" rests on.
   */
  answerGate(msgId: string): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE pending_gates SET status = 'answered', answered_at = ?
         WHERE msg_id = ? AND status = 'pending'`,
      )
      .run(this.now(), msgId);
    return Number(changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toPendingGateRow(row: Record<string, unknown>): PendingGateRow {
  return {
    msgId: row.msg_id as string,
    threadTs: row.thread_ts as string,
    taskId: row.task_id as string | null,
    workerHandle: row.worker_handle as string | null,
    worktreeName: row.worktree_name as string | null,
    kind: row.kind as PendingGateRow['kind'],
    question: row.question as string,
    options: readOptions(row.options),
    relayTs: row.relay_ts as string | null,
    status: row.status as PendingGateRow['status'],
    relayedAt: row.relayed_at as string,
    answeredAt: row.answered_at as string | null,
  };
}

/** The options column is JSON we wrote ourselves; anything else reads empty. */
function readOptions(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toDelegationRow(row: Record<string, unknown>): DelegationRow {
  return {
    taskId: row.task_id as string,
    dispatchId: row.dispatch_id as string,
    worktreeId: row.worktree_id as string | null,
    worktreeName: row.worktree_name as string | null,
    worktreePath: row.worktree_path as string | null,
    repo: row.repo as string | null,
    issueNumber: row.issue_number === null ? null : Number(row.issue_number),
    agent: row.agent as string | null,
    workerHandle: row.worker_handle as string | null,
    threadTs: row.thread_ts as string,
    channelId: row.channel_id as string,
    cardTs: row.card_ts as string | null,
    title: row.title as string | null,
    status: row.status as DelegationRow['status'],
    dispatchedAt: row.dispatched_at as string,
    closedAt: row.closed_at as string | null,
  };
}

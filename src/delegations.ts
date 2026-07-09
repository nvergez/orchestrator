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
  /** The owning delegation (`ctx_…`), when the relay could resolve one —
   * what invalidate-on-close matches first (issue #46). */
  dispatchId: string | null;
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
  /** `superseded` = replaced by a re-ask; `closed` = the delegation ended
   * with the question unanswered (issue #46). Routing only sees `pending`. */
  status: 'pending' | 'answered' | 'superseded' | 'closed';
  /** The re-ask (`msg_…`) that replaced this gate — where a reply aimed at
   * the stale id forwards to; null unless status is `superseded`. */
  supersededBy: string | null;
  relayedAt: string;
  answeredAt: string | null;
}

/** One row of the `stall_alerts` registry (issue #22) — written by the
 * watchdog when it posts a ⚠️ alert; one live alert per delegation. */
export interface StallAlertRow {
  /** The delegation the stall belongs to — also the row key. */
  dispatchId: string;
  threadTs: string;
  /** The stalled worker's terminal — where the reply lands as keystrokes. */
  workerHandle: string | null;
  worktreeName: string | null;
  /** The truncated last terminal output shown in the alert, verbatim. */
  lastOutput: string;
  /** The stall state's identity (the last-activity timestamp) — a sweep
   * seeing the same fingerprint has already alerted and stays silent. */
  fingerprint: string;
  /** Slack ts of the ⚠️ alert message; null when the post failed. */
  relayTs: string | null;
  status: 'pending' | 'answered';
  alertedAt: string;
  answeredAt: string | null;
}

/**
 * The pending_gates columns — one definition shared by the fresh CREATE and
 * the issue #46 migration rebuild, so the two shapes can never drift.
 */
const PENDING_GATES_COLUMNS = `(
        msg_id        TEXT PRIMARY KEY,
        thread_ts     TEXT NOT NULL,
        task_id       TEXT,
        dispatch_id   TEXT,
        worker_handle TEXT,
        worktree_name TEXT,
        kind          TEXT NOT NULL
                      CHECK (kind IN ('decision_gate', 'escalation')),
        question      TEXT NOT NULL,
        options       TEXT NOT NULL,
        relay_ts      TEXT,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'answered', 'superseded', 'closed')),
        superseded_by TEXT,
        relayed_at    TEXT NOT NULL,
        answered_at   TEXT
      ) STRICT`;

/**
 * The `delegations` + `mailboxes` + `pending_gates` + `stall_alerts` share of
 * the orchestrator state database (spec §9), sharing the SQLite file with
 * SessionStore — same synchronous single-writer design. The delegations
 * ledger is written at dispatch and closed on `worker_done` (slice #20); it
 * is what boot reconciliation and the worker-cap count survive restarts on.
 * The mailboxes table remembers each thread's coordinator terminal
 * (`slack-<thread_ts>`, issue #9) so a thread's dispatches all share one
 * origin handle across daemon restarts. The pending_gates registry is written
 * by the daemon at relay time (issue #21) and anchors the routing of human
 * answers back down. The stall_alerts registry is its watchdog sibling
 * (issue #22): written when a ⚠️ alert is posted, it anchors the terminal-
 * send route for the reply and the no-repeat-spam fingerprint.
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
      CREATE TABLE IF NOT EXISTS pending_gates ${PENDING_GATES_COLUMNS};
      CREATE TABLE IF NOT EXISTS stall_alerts (
        dispatch_id   TEXT PRIMARY KEY,
        thread_ts     TEXT NOT NULL,
        worker_handle TEXT,
        worktree_name TEXT,
        last_output   TEXT NOT NULL,
        fingerprint   TEXT NOT NULL,
        relay_ts      TEXT,
        status        TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'answered')),
        alerted_at    TEXT NOT NULL,
        answered_at   TEXT
      ) STRICT;
    `);
    this.migratePendingGates();
  }

  /**
   * Rebuilds a pre-#46 pending_gates table into the current shape (new
   * `dispatch_id`/`superseded_by` columns, two extra statuses). SQLite bakes
   * CHECK constraints into the table, so widening the status set needs the
   * copy-and-rename dance; existing rows ride across with the new columns
   * null. A table already carrying `superseded` is current — no-op.
   */
  private migratePendingGates(): void {
    const schema = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_gates'`)
      .get() as { sql?: unknown } | undefined;
    if (typeof schema?.sql !== 'string' || schema.sql.includes('superseded')) return;
    this.db.exec(`
      BEGIN;
      CREATE TABLE pending_gates_next ${PENDING_GATES_COLUMNS};
      INSERT INTO pending_gates_next
        (msg_id, thread_ts, task_id, worker_handle, worktree_name,
         kind, question, options, relay_ts, status, relayed_at, answered_at)
        SELECT msg_id, thread_ts, task_id, worker_handle, worktree_name,
               kind, question, options, relay_ts, status, relayed_at, answered_at
        FROM pending_gates;
      DROP TABLE pending_gates;
      ALTER TABLE pending_gates_next RENAME TO pending_gates;
      COMMIT;
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
    if (Number(changes) === 0) return false;
    // A closed delegation's stall alert is moot — the worker reported after
    // all. Settle it so the worker never lingers as a silent AUTO send
    // target and the alert drops out of the pending coarse state.
    this.answerStall(dispatchId);
    // Its unanswered gates are moot the same way (issue #46): the worker no
    // longer waits on any reply, so nothing may stay `pending` — a stale
    // live gate would pollute routing disambiguation forever.
    this.closeGatesForDelegation(dispatchId);
    return true;
  }

  /**
   * Invalidate-on-close (issue #46): every still-pending gate the closing
   * delegation owns flips to `closed`. Ownership is the recorded dispatch
   * id; rows without one (pre-#46, or relays that could not resolve the
   * dispatch) fall back to the task id / asking-terminal identity, scoped —
   * like every gate query — to the delegation's own thread.
   */
  private closeGatesForDelegation(dispatchId: string): void {
    const row = this.getByDispatchId(dispatchId);
    if (row === undefined) return;
    this.db
      .prepare(
        `UPDATE pending_gates SET status = 'closed'
         WHERE thread_ts = ? AND status = 'pending'
           AND (dispatch_id = ?
                OR (dispatch_id IS NULL AND (task_id = ? OR worker_handle = ?)))`,
      )
      .run(row.threadTs, dispatchId, row.taskId, row.workerHandle);
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

  /** Every in-flight delegation across all threads — the watchdog sweep's
   * inspection set (issue #22): only these worktrees get looked at. */
  listInFlight(): DelegationRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM delegations WHERE status = 'dispatched' ORDER BY dispatched_at`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(toDelegationRow);
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
    row: Omit<PendingGateRow, 'status' | 'supersededBy' | 'relayedAt' | 'answeredAt'>,
  ): boolean {
    const { changes } = this.db
      .prepare(
        `INSERT OR IGNORE INTO pending_gates
           (msg_id, thread_ts, task_id, dispatch_id, worker_handle, worktree_name,
            kind, question, options, relay_ts, status, relayed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        row.msgId,
        row.threadTs,
        row.taskId,
        row.dispatchId,
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

  /**
   * Flips a re-asked question's stale gate out of the live set (issue #46):
   * pending → superseded, remembering the successor so a reply aimed at the
   * stale msg_id can forward to the one ask the worker still listens on.
   * Only a pending gate flips — an answered gate's reply already went down.
   */
  supersedeGate(msgId: string, successorMsgId: string): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE pending_gates SET status = 'superseded', superseded_by = ?
         WHERE msg_id = ? AND status = 'pending'`,
      )
      .run(successorMsgId, msgId);
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

  /**
   * Registers a posted ⚠️ stall alert (issue #22). One live alert per
   * delegation: a NEW stall state (different fingerprint) replaces the old
   * row wholesale — back to pending, new output, new relay ts — which is
   * exactly the "one alert per stall state" contract.
   */
  recordStall(row: Omit<StallAlertRow, 'status' | 'alertedAt' | 'answeredAt'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO stall_alerts
           (dispatch_id, thread_ts, worker_handle, worktree_name,
            last_output, fingerprint, relay_ts, status, alerted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        row.dispatchId,
        row.threadTs,
        row.workerHandle,
        row.worktreeName,
        row.lastOutput,
        row.fingerprint,
        row.relayTs,
        this.now(),
      );
  }

  /** The delegation's stall alert, whatever its state — the fingerprint check. */
  getStall(dispatchId: string): StallAlertRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM stall_alerts WHERE dispatch_id = ?')
      .get(dispatchId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toStallAlertRow(row);
  }

  /** All of a thread's stall alerts, oldest first — the turn-context list. */
  listStallsForThread(threadTs: string): StallAlertRow[] {
    const rows = this.db
      .prepare('SELECT * FROM stall_alerts WHERE thread_ts = ? ORDER BY alerted_at, dispatch_id')
      .all(threadTs) as Array<Record<string, unknown>>;
    return rows.map(toStallAlertRow);
  }

  /** The thread's unanswered stall alerts — sanctioned send targets, 🚨 state. */
  listPendingStalls(threadTs: string): StallAlertRow[] {
    return this.listStallsForThread(threadTs).filter((stall) => stall.status === 'pending');
  }

  /**
   * Flips a stall alert to answered once its nudge went down the worker's
   * terminal (or its delegation closed). Only a pending alert flips — the
   * boolean says whether this call won.
   */
  answerStall(dispatchId: string): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE stall_alerts SET status = 'answered', answered_at = ?
         WHERE dispatch_id = ? AND status = 'pending'`,
      )
      .run(this.now(), dispatchId);
    return Number(changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toStallAlertRow(row: Record<string, unknown>): StallAlertRow {
  return {
    dispatchId: row.dispatch_id as string,
    threadTs: row.thread_ts as string,
    workerHandle: row.worker_handle as string | null,
    worktreeName: row.worktree_name as string | null,
    lastOutput: row.last_output as string,
    fingerprint: row.fingerprint as string,
    relayTs: row.relay_ts as string | null,
    status: row.status as StallAlertRow['status'],
    alertedAt: row.alerted_at as string,
    answeredAt: row.answered_at as string | null,
  };
}

function toPendingGateRow(row: Record<string, unknown>): PendingGateRow {
  return {
    msgId: row.msg_id as string,
    threadTs: row.thread_ts as string,
    taskId: row.task_id as string | null,
    dispatchId: row.dispatch_id as string | null,
    workerHandle: row.worker_handle as string | null,
    worktreeName: row.worktree_name as string | null,
    kind: row.kind as PendingGateRow['kind'],
    question: row.question as string,
    options: readOptions(row.options),
    relayTs: row.relay_ts as string | null,
    status: row.status as PendingGateRow['status'],
    supersededBy: row.superseded_by as string | null,
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

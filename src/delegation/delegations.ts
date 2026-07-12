import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { worktreeIssueRef } from './worktree-name.ts';

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
  /** When the worker last said ANYTHING structured on the bus (heartbeat,
   * ask, done) — the watchdog's in-flight-age clock (issue #48); null until
   * the first message, so the dispatch time is the floor. */
  lastBusAt: string | null;
  closedAt: string | null;
}

/** One row of the `pending_gates` registry (spec §9) — written at relay time. */
export interface PendingGateRow {
  /** The bus message id (`msg_…`) — what `orchestration reply --id` targets. */
  msgId: string;
  threadTs: string;
  /** The thread's channel (issue #93). Null only on rows written before the
   * multi-channel migration — necessarily single-channel-era rows, which
   * every thread-scoped query therefore matches under ANY channel. */
  channelId: string | null;
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
  /** The thread's channel (issue #93); null only on pre-migration rows,
   * matched under any channel like legacy gates. */
  channelId: string | null;
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
 * How a bus event names its delegation — what `resolveWorkerEvent` trusts,
 * strongest first. The preamble makes workers echo the dispatch id; an `ask`
 * carries no ids at all, so the sending terminal is its only identity.
 */
export interface WorkerEventKeys {
  dispatchId?: string | undefined;
  taskId?: string | undefined;
  /** The sending terminal handle (`from_handle` on the bus). */
  workerHandle?: string | undefined;
}

/**
 * One relayed question as the session's turn context needs it (issue
 * #21/#46) — the read model behind the routing instructions, not a table
 * row. Superseded rows never appear: their question lives on in the re-ask
 * successor, and listing both would recreate the duplicate-gate noise the
 * supersede exists to kill.
 */
export interface TurnContextGate {
  msgId: string;
  kind: 'decision_gate' | 'escalation';
  /** Never `superseded` — those rows stay out of the context by design. */
  status: 'pending' | 'answered' | 'closed';
  question: string;
  options: string[];
  worktreeName: string | null;
  workerHandle: string | null;
  /** `repo#n` from the worktree name, degrading to the task id, then the
   * msg id — the reference the human acknowledges the question by. */
  ackRef: string;
}

/** One watchdog stall alert for the same turn context (issue #22). */
export interface TurnContextStall {
  dispatchId: string;
  status: 'pending' | 'answered';
  worktreeName: string | null;
  workerHandle: string | null;
  lastOutput: string;
  /** `repo#n` from the worktree name, degrading to the dispatch id. */
  ackRef: string;
}

/**
 * The pending_gates columns — one definition shared by the fresh CREATE and
 * the issue #46 migration rebuild, so the two shapes can never drift.
 */
const PENDING_GATES_COLUMNS = `(
        msg_id        TEXT PRIMARY KEY,
        thread_ts     TEXT NOT NULL,
        channel_id    TEXT,
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
 * The mailboxes columns — shared by the fresh CREATE and the issue #93
 * re-key rebuild (thread_ts alone → the pair), so the two shapes never drift.
 */
const MAILBOXES_COLUMNS = `(
        thread_ts  TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        handle     TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_ts, channel_id)
      ) STRICT`;

/**
 * The reconciliations columns — shared by the fresh CREATE and the issue
 * #93 re-key rebuild for the same no-drift reason.
 */
const RECONCILIATIONS_COLUMNS = `(
        thread_ts   TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        posted_at   TEXT NOT NULL,
        PRIMARY KEY (thread_ts, channel_id)
      ) STRICT`;

/**
 * The delegation ledger (spec §9): the persistent record of every
 * delegation's lifecycle and the single source of truth for what is in
 * flight — the worker cap, boot reconciliation and the watchers all count
 * on it. It shares the SQLite file with SessionStore — same synchronous
 * single-writer design — across four tables: `delegations` (written at
 * dispatch, closed on `worker_done`, slice #20), `mailboxes` (each thread's
 * coordinator terminal, `slack-<thread_ts>`, issue #9), `pending_gates`
 * (written by the daemon at relay time, issue #21 — what routes human
 * answers back down) and `stall_alerts` (its watchdog sibling, issue #22).
 *
 * The ledger also OWNS the identity questions over those tables, so callers
 * never re-derive them from raw rows: which delegation a bus event belongs
 * to (`resolveWorkerEvent`), which gate owns a re-asked question now
 * (`liveGateFor`), and what a session's turn context must list
 * (`turnContextFor`).
 *
 * Like `sessions`, every thread-scoped table and query keys on the
 * `(thread_ts, channel_id)` pair (issue #93): the daemon serves several
 * channels, and a thread ts is only unique within its channel. Gate and
 * stall rows written before the multi-channel migration carry a NULL
 * channel — necessarily single-channel-era rows — so thread-scoped queries
 * match them under any channel rather than wedging a legacy question.
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
    // WAL is load-bearing for the dashboard sidecar (ADR 0002): its
    // concurrent read-only connection must never trip the daemon's writes.
    this.db.exec('PRAGMA journal_mode = WAL');
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
        last_bus_at   TEXT,
        closed_at     TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mailboxes ${MAILBOXES_COLUMNS};
      CREATE TABLE IF NOT EXISTS reconciliations ${RECONCILIATIONS_COLUMNS};
      CREATE TABLE IF NOT EXISTS pending_gates ${PENDING_GATES_COLUMNS};
      CREATE TABLE IF NOT EXISTS stall_alerts (
        dispatch_id   TEXT PRIMARY KEY,
        thread_ts     TEXT NOT NULL,
        channel_id    TEXT,
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
    this.migrateDelegations();
    this.migrateStallAlerts();
    this.migrateMailboxes();
    this.migrateReconciliations();
  }

  /**
   * Adds the issue #48 `last_bus_at` column to a pre-#48 delegations table.
   * A plain nullable add — ALTER TABLE suffices, no rebuild; existing rows
   * read null, so their dispatch time stays the in-flight floor.
   */
  private migrateDelegations(): void {
    const schema = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'delegations'`)
      .get() as { sql?: unknown } | undefined;
    if (typeof schema?.sql !== 'string' || schema.sql.includes('last_bus_at')) return;
    this.db.exec(`ALTER TABLE delegations ADD COLUMN last_bus_at TEXT`);
  }

  /**
   * Adds the issue #93 `channel_id` column to a pre-#93 stall_alerts table.
   * A plain nullable add — existing rows read null (the single-channel era),
   * and every thread-scoped query matches them under any channel.
   */
  private migrateStallAlerts(): void {
    const schema = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stall_alerts'`)
      .get() as { sql?: unknown } | undefined;
    if (typeof schema?.sql !== 'string' || schema.sql.includes('channel_id')) return;
    this.db.exec(`ALTER TABLE stall_alerts ADD COLUMN channel_id TEXT`);
  }

  /**
   * Re-keys a pre-#93 mailboxes table from `thread_ts` alone to the
   * `(thread_ts, channel_id)` pair. A primary-key change needs the
   * copy-and-rename dance; rows always carried their channel_id and ride
   * across unchanged.
   */
  private migrateMailboxes(): void {
    const schema = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mailboxes'`)
      .get() as { sql?: unknown } | undefined;
    if (
      typeof schema?.sql !== 'string' ||
      schema.sql.includes('PRIMARY KEY (thread_ts, channel_id)')
    ) {
      return;
    }
    this.db.exec(`
      BEGIN;
      CREATE TABLE mailboxes_next ${MAILBOXES_COLUMNS};
      INSERT INTO mailboxes_next (thread_ts, channel_id, handle, created_at)
        SELECT thread_ts, channel_id, handle, created_at FROM mailboxes;
      DROP TABLE mailboxes;
      ALTER TABLE mailboxes_next RENAME TO mailboxes;
      COMMIT;
    `);
  }

  /**
   * Re-keys a pre-#93 reconciliations table to the pair, backfilling each
   * row's channel from the thread's delegations (a fingerprint only ever
   * exists for a thread that dispatched). A row the backfill cannot
   * attribute is dropped — the worst case is one repeated ⚠️ restart
   * notice, which the next fingerprint write settles.
   */
  private migrateReconciliations(): void {
    const schema = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reconciliations'`)
      .get() as { sql?: unknown } | undefined;
    if (typeof schema?.sql !== 'string' || schema.sql.includes('channel_id')) return;
    this.db.exec(`
      BEGIN;
      CREATE TABLE reconciliations_next ${RECONCILIATIONS_COLUMNS};
      INSERT INTO reconciliations_next (thread_ts, channel_id, fingerprint, posted_at)
        SELECT r.thread_ts,
               (SELECT d.channel_id FROM delegations d WHERE d.thread_ts = r.thread_ts LIMIT 1),
               r.fingerprint, r.posted_at
          FROM reconciliations r
         WHERE EXISTS (SELECT 1 FROM delegations d WHERE d.thread_ts = r.thread_ts);
      DROP TABLE reconciliations;
      ALTER TABLE reconciliations_next RENAME TO reconciliations;
      COMMIT;
    `);
  }

  /**
   * Rebuilds a pre-#46 pending_gates table into the current shape (new
   * `dispatch_id`/`superseded_by` columns, two extra statuses). SQLite bakes
   * CHECK constraints into the table, so widening the status set needs the
   * copy-and-rename dance; existing rows ride across with the new columns
   * null. A second, independent step adds the issue #93 `channel_id` to a
   * post-#46 pre-#93 table (a plain nullable add, like stall_alerts) — the
   * rebuild target already carries it, so at most one step runs per boot.
   */
  private migratePendingGates(): void {
    const schema = this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pending_gates'`)
      .get() as { sql?: unknown } | undefined;
    if (typeof schema?.sql !== 'string') return;
    if (!schema.sql.includes('superseded')) {
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
      return;
    }
    if (!schema.sql.includes('channel_id')) {
      this.db.exec(`ALTER TABLE pending_gates ADD COLUMN channel_id TEXT`);
    }
  }

  /**
   * Writes the ledger row at dispatch. Keyed on dispatch_id, and a replay of
   * the same dispatch overwrites rather than double-counts — the id is
   * runtime-issued, so two rows with one id can only be the same hand-off.
   */
  recordDispatch(
    row: Omit<DelegationRow, 'status' | 'dispatchedAt' | 'lastBusAt' | 'closedAt'>,
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
   * Stamps the in-flight row's bus clock (issue #48): any structured message
   * from the worker — heartbeat, ask, done — proves its bus is alive, and
   * resets the watchdog's in-flight-age fingerprint. Only an in-flight row
   * stamps; a straggler from an already-closed dispatch changes nothing.
   */
  recordBusActivity(dispatchId: string): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE delegations SET last_bus_at = ?
         WHERE dispatch_id = ? AND status = 'dispatched'`,
      )
      .run(this.now(), dispatchId);
    return Number(changes) > 0;
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
         WHERE thread_ts = ? AND (channel_id = ? OR channel_id IS NULL)
           AND status = 'pending'
           AND (dispatch_id = ?
                OR (dispatch_id IS NULL AND (task_id = ? OR worker_handle = ?)))`,
      )
      .run(row.threadTs, row.channelId, dispatchId, row.taskId, row.workerHandle);
  }

  getByDispatchId(dispatchId: string): DelegationRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM delegations WHERE dispatch_id = ?')
      .get(dispatchId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /**
   * The ledger row behind a bus event — the one identity rule for the
   * watcher (issues #20/#21) and boot reconciliation's mailbox peek (issue
   * #25): an event resolves by the STRONGEST identity it names, and a named
   * id pointing nowhere never degrades to a weaker one (a stale straggler's
   * ids must not let it claim the live retry's delegation).
   *
   * - The dispatch id is authoritative, ANY status and ANY thread: a row
   *   living in another thread is trusted over the arrival mailbox — the
   *   card to edit lives where the row says.
   * - The task id covers payloads that name no dispatch id, scoped to the
   *   thread the event arrived on: newest in-flight row first, then any
   *   status — after boot reconciliation closes an outage completion, the
   *   re-armed watcher can still consume the same worker_done, which must
   *   land on the duplicate guard instead of surfacing as an unknown worker.
   * - The sending terminal only covers id-LESS events (a worker's `ask`
   *   carries no ids at all): the thread's newest in-flight row for that
   *   handle.
   */
  resolveWorkerEvent(
    threadTs: string,
    channelId: string,
    event: WorkerEventKeys,
  ): DelegationRow | undefined {
    if (event.dispatchId !== undefined) return this.getByDispatchId(event.dispatchId);
    if (event.taskId !== undefined) {
      return (
        this.inFlightByTaskId(threadTs, channelId, event.taskId) ??
        this.latestByTaskId(threadTs, channelId, event.taskId)
      );
    }
    if (event.workerHandle !== undefined) {
      return this.inFlightByWorkerHandle(threadTs, channelId, event.workerHandle);
    }
    return undefined;
  }

  /** The thread's newest in-flight row for a task — thread-scoped, so the
   * runtime-global bus can never close another thread's delegation. */
  private inFlightByTaskId(
    threadTs: string,
    channelId: string,
    taskId: string,
  ): DelegationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND channel_id = ? AND task_id = ? AND status = 'dispatched'
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(threadTs, channelId, taskId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /** The thread's newest in-flight row for an asking terminal (issue #21). */
  private inFlightByWorkerHandle(
    threadTs: string,
    channelId: string,
    workerHandle: string,
  ): DelegationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND channel_id = ? AND worker_handle = ? AND status = 'dispatched'
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(threadTs, channelId, workerHandle) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /** The thread's newest row for a task, ANY status (issue #25). */
  private latestByTaskId(
    threadTs: string,
    channelId: string,
    taskId: string,
  ): DelegationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND channel_id = ? AND task_id = ?
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(threadTs, channelId, taskId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toDelegationRow(row);
  }

  /** The thread's in-flight delegations — what keeps its watcher armed (#20). */
  listInFlightForThread(threadTs: string, channelId: string): DelegationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND channel_id = ? AND status = 'dispatched'
         ORDER BY dispatched_at`,
      )
      .all(threadTs, channelId) as Array<Record<string, unknown>>;
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
  listForThread(threadTs: string, channelId: string): DelegationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM delegations
         WHERE thread_ts = ? AND channel_id = ? ORDER BY dispatched_at`,
      )
      .all(threadTs, channelId) as Array<Record<string, unknown>>;
    return rows.map(toDelegationRow);
  }

  /** The thread's mailbox terminal handle, if one was ever created (issue #9). */
  getMailbox(threadTs: string, channelId: string): string | undefined {
    const row = this.db
      .prepare('SELECT handle FROM mailboxes WHERE thread_ts = ? AND channel_id = ?')
      .get(threadTs, channelId) as { handle: string } | undefined;
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
  getReconcileFingerprint(threadTs: string, channelId: string): string | undefined {
    const row = this.db
      .prepare('SELECT fingerprint FROM reconciliations WHERE thread_ts = ? AND channel_id = ?')
      .get(threadTs, channelId) as { fingerprint: string } | undefined;
    return row?.fingerprint;
  }

  /** Remembers what the thread's ⚠️ line last reported (issue #25). */
  setReconcileFingerprint(threadTs: string, channelId: string, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO reconciliations (thread_ts, channel_id, fingerprint, posted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(threadTs, channelId, fingerprint, this.now());
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
           (msg_id, thread_ts, channel_id, task_id, dispatch_id, worker_handle, worktree_name,
            kind, question, options, relay_ts, status, relayed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        row.msgId,
        row.threadTs,
        row.channelId,
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

  /**
   * The gate that owns a question NOW (issue #46): the end of the named
   * gate's re-ask chain, whatever its terminal status, so a caller's
   * pending/answered/closed handling applies to the one ask the worker
   * still listens on. A gate that was never superseded answers itself.
   * Undefined on an unknown msg id, a dangling pointer, a cycle or a
   * cross-thread hop (a hand-edited registry) — refuse rather than guess.
   * A cross-channel hop refuses the same way; a NULL on either side is a
   * pre-#93 row and never a mismatch.
   */
  liveGateFor(msgId: string): PendingGateRow | undefined {
    let current = this.getGate(msgId);
    if (current === undefined) return undefined;
    const threadTs = current.threadTs;
    const channelId = current.channelId;
    const seen = new Set<string>([current.msgId]);
    while (current.status === 'superseded') {
      if (current.supersededBy === null || seen.has(current.supersededBy)) return undefined;
      seen.add(current.supersededBy);
      const next = this.getGate(current.supersededBy);
      if (next === undefined || next.threadTs !== threadTs) return undefined;
      if (channelId !== null && next.channelId !== null && next.channelId !== channelId) {
        return undefined;
      }
      current = next;
    }
    return current;
  }

  /** All of a thread's relayed gates, oldest first. A NULL channel is a
   * pre-#93 row from the single-channel era — it matches any channel. */
  private listGatesForThread(threadTs: string, channelId: string): PendingGateRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_gates
         WHERE thread_ts = ? AND (channel_id = ? OR channel_id IS NULL)
         ORDER BY relayed_at, msg_id`,
      )
      .all(threadTs, channelId) as Array<Record<string, unknown>>;
    return rows.map(toPendingGateRow);
  }

  /** The thread's unanswered gates — what the root reaction and routing read. */
  listPendingGates(threadTs: string, channelId: string): PendingGateRow[] {
    return this.listGatesForThread(threadTs, channelId).filter(
      (gate) => gate.status === 'pending',
    );
  }

  /**
   * What the session's next turn must know about this thread's relayed state
   * (spec §6: the session routes "anchored on the registry"): every gate and
   * stall alert, oldest first, shaped for the turn context. Answered entries
   * ride along so the session can recognize — and refuse to re-route — a
   * late correction, and closed entries so it can tell a moot question apart
   * from an open one (issue #46). Superseded rows stay out: their question
   * lives on in the re-ask successor.
   */
  turnContextFor(
    threadTs: string,
    channelId: string,
  ): { gates: TurnContextGate[]; stalls: TurnContextStall[] } {
    const gates = this.listGatesForThread(threadTs, channelId)
      .filter(
        (gate): gate is PendingGateRow & { status: TurnContextGate['status'] } =>
          gate.status !== 'superseded',
      )
      .map(
        (gate): TurnContextGate => ({
          msgId: gate.msgId,
          kind: gate.kind,
          status: gate.status,
          question: gate.question,
          options: gate.options,
          worktreeName: gate.worktreeName,
          workerHandle: gate.workerHandle,
          ackRef:
            (gate.worktreeName === null ? null : worktreeIssueRef(gate.worktreeName)) ??
            gate.taskId ??
            gate.msgId,
        }),
      );
    const stalls = this.listStallsForThread(threadTs, channelId).map(
      (stall): TurnContextStall => ({
        dispatchId: stall.dispatchId,
        status: stall.status,
        worktreeName: stall.worktreeName,
        workerHandle: stall.workerHandle,
        lastOutput: stall.lastOutput,
        ackRef:
          (stall.worktreeName === null ? null : worktreeIssueRef(stall.worktreeName)) ??
          stall.dispatchId,
      }),
    );
    return { gates, stalls };
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
           (dispatch_id, thread_ts, channel_id, worker_handle, worktree_name,
            last_output, fingerprint, relay_ts, status, alerted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        row.dispatchId,
        row.threadTs,
        row.channelId,
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

  /** All of a thread's stall alerts, oldest first. A NULL channel is a
   * pre-#93 row from the single-channel era — it matches any channel. */
  private listStallsForThread(threadTs: string, channelId: string): StallAlertRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM stall_alerts
         WHERE thread_ts = ? AND (channel_id = ? OR channel_id IS NULL)
         ORDER BY alerted_at, dispatch_id`,
      )
      .all(threadTs, channelId) as Array<Record<string, unknown>>;
    return rows.map(toStallAlertRow);
  }

  /** The thread's unanswered stall alerts — sanctioned send targets, 🚨 state. */
  listPendingStalls(threadTs: string, channelId: string): StallAlertRow[] {
    return this.listStallsForThread(threadTs, channelId).filter(
      (stall) => stall.status === 'pending',
    );
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
    channelId: (row.channel_id ?? null) as string | null,
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
    channelId: (row.channel_id ?? null) as string | null,
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
    lastBusAt: (row.last_bus_at ?? null) as string | null,
    closedAt: row.closed_at as string | null,
  };
}

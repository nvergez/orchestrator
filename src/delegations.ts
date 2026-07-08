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

/**
 * The `delegations` + `mailboxes` half of the orchestrator state database
 * (spec §9), sharing the SQLite file with SessionStore — same synchronous
 * single-writer design. The delegations ledger is written at dispatch and
 * closed on `worker_done` (slice #20); it is what boot reconciliation and
 * the worker-cap count survive restarts on. The mailboxes table remembers
 * each thread's coordinator terminal (`slack-<thread_ts>`, issue #9) so a
 * thread's dispatches all share one origin handle across daemon restarts.
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
   * Closes the ledger row when the delegation leaves the in-flight set —
   * `worker_done` lands in slice #20, which pairs this with the
   * coordinator's `onDelegationClosed()` so the freed slot starts a wave.
   */
  closeDelegation(dispatchId: string, status: 'completed' | 'failed'): void {
    this.db
      .prepare('UPDATE delegations SET status = ?, closed_at = ? WHERE dispatch_id = ?')
      .run(status, this.now(), dispatchId);
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

  close(): void {
    this.db.close();
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

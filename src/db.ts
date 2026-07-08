import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** One row of the `sessions` table (spec §9). */
export interface SessionRow {
  threadTs: string;
  channelId: string;
  /** Claude Code session UUID — the durable anchor; null until the first init. */
  sessionId: string | null;
  rootUser: string;
  status: 'open' | 'closed';
  createdAt: string;
  lastActivityAt: string;
  turnCount: number;
  /** Populated by the cost-ledger slice; carried in the schema from day one. */
  costUsdTotal: number;
}

/**
 * The `sessions` half of the orchestrator state database
 * (`~/.local/state/orchestrator/orchestrator.db`, spec §9). Synchronous by
 * design: node:sqlite's DatabaseSync is plenty for a single-daemon writer,
 * and it keeps every state transition atomic with respect to the event loop.
 */
export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(dbPath: string, now: () => string = () => new Date().toISOString()) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_ts        TEXT NOT NULL,
        channel_id       TEXT NOT NULL,
        session_id       TEXT,
        root_user        TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'closed')),
        created_at       TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        turn_count       INTEGER NOT NULL DEFAULT 0,
        cost_usd_total   REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (thread_ts, channel_id)
      ) STRICT;
    `);
  }

  /** Opens the thread's row; a re-register of a known thread is a no-op. */
  register(threadTs: string, channelId: string, rootUser: string): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sessions
           (thread_ts, channel_id, root_user, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(threadTs, channelId, rootUser, now, now);
  }

  get(threadTs: string, channelId: string): SessionRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE thread_ts = ? AND channel_id = ?')
      .get(threadTs, channelId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      threadTs: row.thread_ts as string,
      channelId: row.channel_id as string,
      sessionId: row.session_id as string | null,
      rootUser: row.root_user as string,
      status: row.status as 'open' | 'closed',
      createdAt: row.created_at as string,
      lastActivityAt: row.last_activity_at as string,
      turnCount: Number(row.turn_count),
      costUsdTotal: Number(row.cost_usd_total),
    };
  }

  setSessionId(threadTs: string, channelId: string, sessionId: string): void {
    this.db
      .prepare(
        'UPDATE sessions SET session_id = ? WHERE thread_ts = ? AND channel_id = ?',
      )
      .run(sessionId, threadTs, channelId);
  }

  /** One completed turn: bumps the count and accumulates the SDK-reported cost. */
  recordTurn(threadTs: string, channelId: string, costUsd: number): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET turn_count = turn_count + 1,
                cost_usd_total = cost_usd_total + ?,
                last_activity_at = ?
          WHERE thread_ts = ? AND channel_id = ?`,
      )
      .run(costUsd, this.now(), threadTs, channelId);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as {
      n: number;
    };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}

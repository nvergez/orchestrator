import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The memory half of the orchestrator state database (issue #120, ADR 0009).
 * Same file as the sessions and the delegation ledger, opened on its own
 * connection the way both existing stores already do — and created on open,
 * which IS the forward migration: a database from before the feature simply
 * has no memory tables, and gains them the first time the daemon starts.
 *
 * Synchronous, like its neighbours: the portrait of every participant is
 * read on the spawn path, which returns synchronously, and a SQLite read is
 * fast enough that nothing about the session manager's turn queue changes.
 */

/** One thing the daemon remembers about one person (CONTEXT.md: Memory). */
export interface MemoryRow {
  /** The short stable id — the identity a human or a session points at. */
  id: string;
  /** Whose portrait this primarily belongs to. */
  subjectUserId: string;
  /** Who else was there; a shared memory is ONE row, in both portraits. */
  participantUserIds: string[];
  nature: 'durable' | 'moment';
  text: string;
  createdAt: string;
  sourceThreadTs: string | null;
  sourceChannelId: string | null;
  /** How many times the pass has seen this again — what promotes a running
   * joke from a moment into a durable fact. */
  recurrenceCount: number;
  lastSeenAt: string;
}

/** What the daemon knows about who spoke where — whose portraits to inject. */
export interface ParticipantRow {
  userId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The per-thread extraction bookkeeping — never the requester's business. */
export interface ExtractionRow {
  /** Slack ts: the transcript slice boundary, so a revived thread extracts
   * only the new part. */
  watermarkTs: string;
  /** The session's last_activity_at as of the last pass — the same clock the
   * sweep compares against, so "nothing new" costs no Slack call. */
  activityMark: string;
  /** Consecutive failures; the watermark holds until the limit, then moves. */
  attempts: number;
}

/** A thread whose last pass failed and still owes its slice another attempt. */
export interface PendingExtraction {
  threadTs: string;
  channelId: string;
  activityMark: string;
  attempts: number;
}

/** One memory-pass run, for the dashboard and the separate cost counter. */
export interface PassRow {
  threadTs: string;
  channelId: string;
  ranAt: string;
  outcome: 'wrote' | 'empty' | 'failed' | 'abandoned';
  written: number;
  dropped: number;
  costUsd: number;
}

/** Base32-ish, no vowels and no look-alikes: an id a human retypes from Slack. */
const ID_ALPHABET = '23456789bcdfghjkmnpqrstvwxz';
const ID_LENGTH = 6;

/** How long a deletion tombstone outlives the request. Long enough that no
 * pass in flight when the deletion landed can still be running; short enough
 * that a deletion is never a permanent ban on learning the same thing again. */
const DELETION_TOMBSTONE_MS = 7 * 86_400_000;

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly mintId: () => string;

  /**
   * `mintId` is injectable for the same reason `now` is: the demo database
   * has to seed identically twice, and a random id would make two seeds of
   * the same state look like different state.
   */
  constructor(
    dbPath: string,
    now: () => string = () => new Date().toISOString(),
    mintId: () => string = randomId,
  ) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.mintId = mintId;
    // WAL is load-bearing for the dashboard sidecar (ADR 0002), and this
    // connection must not undo what the other two stores set.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id                    TEXT PRIMARY KEY,
        subject_user_id       TEXT NOT NULL,
        participant_user_ids  TEXT NOT NULL DEFAULT '[]',
        nature                TEXT NOT NULL
                              CHECK (nature IN ('durable', 'moment')),
        text                  TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        source_thread_ts      TEXT,
        source_channel_id     TEXT,
        recurrence_count      INTEGER NOT NULL DEFAULT 1,
        last_seen_at          TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_extractions (
        thread_ts     TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        watermark_ts  TEXT NOT NULL DEFAULT '0',
        activity_mark TEXT NOT NULL DEFAULT '',
        attempts      INTEGER NOT NULL DEFAULT 0,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (thread_ts, channel_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_people (
        user_id      TEXT PRIMARY KEY,
        opted_out_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_participants (
        thread_ts     TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        user_id       TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        PRIMARY KEY (thread_ts, channel_id, user_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_passes (
        id         INTEGER PRIMARY KEY,
        thread_ts  TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        ran_at     TEXT NOT NULL,
        outcome    TEXT NOT NULL
                   CHECK (outcome IN ('wrote', 'empty', 'failed', 'abandoned')),
        written    INTEGER NOT NULL DEFAULT 0,
        dropped    INTEGER NOT NULL DEFAULT 0,
        cost_usd   REAL NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS memory_deletions (
        id              INTEGER PRIMARY KEY,
        subject_user_id TEXT NOT NULL,
        text            TEXT NOT NULL,
        deleted_at      TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memories_subject ON memories (subject_user_id);
      CREATE INDEX IF NOT EXISTS memory_deletions_at ON memory_deletions (deleted_at);
    `);
  }

  /**
   * Writes one memory and returns its id. The subject's opt-out tombstone is
   * checked here rather than at the caller: a pass that ran against a
   * transcript from before the opt-out must still write nothing for them.
   */
  add(memory: Omit<MemoryRow, 'id' | 'createdAt' | 'recurrenceCount' | 'lastSeenAt'>): string | undefined {
    if (this.isOptedOut(memory.subjectUserId)) return undefined;
    const participants = memory.participantUserIds.filter((id) => !this.isOptedOut(id));
    const now = this.now();
    const id = this.freshId();
    this.db
      .prepare(
        `INSERT INTO memories
           (id, subject_user_id, participant_user_ids, nature, text, created_at,
            source_thread_ts, source_channel_id, recurrence_count, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        memory.subjectUserId,
        JSON.stringify(participants),
        memory.nature,
        memory.text,
        now,
        memory.sourceThreadTs,
        memory.sourceChannelId,
        now,
      );
    return id;
  }

  /**
   * A person's whole portrait: what is about them, plus every shared record
   * they were part of. One row, two portraits — never two drifting copies.
   * Oldest first, insertion order breaking a same-millisecond tie: that is
   * the order eviction consumes, so it has to be exact rather than plausible.
   */
  listForPerson(userId: string): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
          WHERE subject_user_id = ?
             OR EXISTS (SELECT 1 FROM json_each(participant_user_ids) WHERE value = ?)
          ORDER BY created_at, rowid`,
      )
      .all(userId, userId) as Array<Record<string, unknown>>;
    return rows.map(toMemoryRow);
  }

  get(id: string): MemoryRow | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : toMemoryRow(row);
  }

  /** Deletes one memory outright — a shared record leaves both portraits. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
  }

  /**
   * A tombstone for a deletion somebody ASKED for — never for a memory
   * compaction retired. It is what stops a pass that was already running
   * when the request landed from writing the same thing back under a new id
   * a second later: its result is work from before the deletion, and absorb
   * checks these before it writes.
   *
   * Pruned on write: only deletions younger than a pass can possibly be are
   * ever consulted, and a permanent block would stop the daemon from ever
   * learning the same thing again if it became true again.
   */
  recordDeletion(memory: MemoryRow): void {
    const now = this.now();
    this.db
      .prepare('INSERT INTO memory_deletions (subject_user_id, text, deleted_at) VALUES (?, ?, ?)')
      .run(memory.subjectUserId, memory.text, now);
    this.db
      .prepare('DELETE FROM memory_deletions WHERE deleted_at < ?')
      .run(new Date(Date.parse(now) - DELETION_TOMBSTONE_MS).toISOString());
  }

  /** The deletions asked for since an instant — a pass older than one of
   * these must not write its subject back. */
  deletionsSince(sinceIso: string): Array<{ subjectUserId: string; text: string }> {
    const rows = this.db
      .prepare('SELECT subject_user_id, text FROM memory_deletions WHERE deleted_at >= ?')
      .all(sinceIso) as Array<{ subject_user_id: string; text: string }>;
    return rows.map((row) => ({ subjectUserId: row.subject_user_id, text: row.text }));
  }

  /** The pass saw an existing memory again: a recurring moment earns its keep. */
  noteRecurrence(id: string): number {
    this.db
      .prepare('UPDATE memories SET recurrence_count = recurrence_count + 1, last_seen_at = ? WHERE id = ?')
      .run(this.now(), id);
    return this.get(id)?.recurrenceCount ?? 0;
  }

  /** Compaction's other half: a moment that kept recurring becomes a fact. */
  promote(id: string): void {
    this.db.prepare(`UPDATE memories SET nature = 'durable' WHERE id = ?`).run(id);
  }

  /**
   * The opt-out (spec §12): purge the portrait and leave the tombstone that
   * makes it hold across restarts. Records where they were merely present
   * survive in someone else's portrait, with them struck out of it.
   */
  optOut(userId: string): number {
    const purged = this.db.prepare('DELETE FROM memories WHERE subject_user_id = ?').run(userId).changes;
    for (const row of this.listForPerson(userId)) {
      this.db
        .prepare('UPDATE memories SET participant_user_ids = ? WHERE id = ?')
        .run(JSON.stringify(row.participantUserIds.filter((id) => id !== userId)), row.id);
    }
    this.db
      .prepare(
        `INSERT INTO memory_people (user_id, opted_out_at) VALUES (?, ?)
           ON CONFLICT (user_id) DO UPDATE SET opted_out_at = excluded.opted_out_at`,
      )
      .run(userId, this.now());
    return Number(purged);
  }

  /** Lifts the tombstone; nothing purged comes back, and nothing should. */
  optIn(userId: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_people (user_id, opted_out_at) VALUES (?, NULL)
           ON CONFLICT (user_id) DO UPDATE SET opted_out_at = NULL`,
      )
      .run(userId);
  }

  isOptedOut(userId: string): boolean {
    const row = this.db
      .prepare('SELECT opted_out_at FROM memory_people WHERE user_id = ?')
      .get(userId) as { opted_out_at?: unknown } | undefined;
    return typeof row?.opted_out_at === 'string';
  }

  /**
   * Records that someone spoke in a thread. Only people who actually talk to
   * the bot are ever recorded — someone merely quoted in a transcript never
   * acquires a portrait.
   */
  noteParticipant(threadTs: string, channelId: string, userId: string): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO memory_participants
           (thread_ts, channel_id, user_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (thread_ts, channel_id, user_id)
           DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(threadTs, channelId, userId, now, now);
  }

  participants(threadTs: string, channelId: string): ParticipantRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_participants
          WHERE thread_ts = ? AND channel_id = ?
          ORDER BY first_seen_at, user_id`,
      )
      .all(threadTs, channelId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      userId: row.user_id as string,
      firstSeenAt: row.first_seen_at as string,
      lastSeenAt: row.last_seen_at as string,
    }));
  }

  extraction(threadTs: string, channelId: string): ExtractionRow {
    const row = this.db
      .prepare('SELECT * FROM memory_extractions WHERE thread_ts = ? AND channel_id = ?')
      .get(threadTs, channelId) as Record<string, unknown> | undefined;
    if (row === undefined) return { watermarkTs: '0', activityMark: '', attempts: 0 };
    return {
      watermarkTs: row.watermark_ts as string,
      activityMark: row.activity_mark as string,
      attempts: Number(row.attempts),
    };
  }

  /**
   * Threads still holding a slice a failed pass owes another attempt. The
   * sweep's own shortlist is the open sessions, and a thread closed between
   * the failure and the retry would otherwise fall off it forever — the
   * attempt counter says a retry was promised, so this is where it is kept.
   * A slice that was abandoned advances its marks and resets the counter, so
   * it is gone from here by construction.
   */
  pendingExtractions(): PendingExtraction[] {
    const rows = this.db
      .prepare(
        `SELECT thread_ts, channel_id, activity_mark, attempts FROM memory_extractions
          WHERE attempts > 0
          ORDER BY updated_at, thread_ts`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      threadTs: row.thread_ts as string,
      channelId: row.channel_id as string,
      activityMark: row.activity_mark as string,
      attempts: Number(row.attempts),
    }));
  }

  /** A pass landed (or was abandoned): both marks move, the counter resets. */
  advance(threadTs: string, channelId: string, watermarkTs: string, activityMark: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_extractions
           (thread_ts, channel_id, watermark_ts, activity_mark, attempts, updated_at)
         VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT (thread_ts, channel_id) DO UPDATE SET
             watermark_ts = excluded.watermark_ts,
             activity_mark = excluded.activity_mark,
             attempts = 0,
             updated_at = excluded.updated_at`,
      )
      .run(threadTs, channelId, watermarkTs, activityMark, this.now());
  }

  /** A pass failed: the slice is held for another attempt, and counted. */
  recordAttempt(threadTs: string, channelId: string): number {
    const current = this.extraction(threadTs, channelId);
    this.db
      .prepare(
        `INSERT INTO memory_extractions
           (thread_ts, channel_id, watermark_ts, activity_mark, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (thread_ts, channel_id) DO UPDATE SET
             attempts = excluded.attempts,
             updated_at = excluded.updated_at`,
      )
      .run(
        threadTs,
        channelId,
        current.watermarkTs,
        current.activityMark,
        current.attempts + 1,
        this.now(),
      );
    return current.attempts + 1;
  }

  recordPass(row: Omit<PassRow, 'ranAt'>): void {
    this.db
      .prepare(
        `INSERT INTO memory_passes
           (thread_ts, channel_id, ran_at, outcome, written, dropped, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.threadTs,
        row.channelId,
        this.now(),
        row.outcome,
        row.written,
        row.dropped,
        row.costUsd,
      );
  }

  /** What the passes have cost — its own counter, never a thread's total. */
  passCostUsdTotal(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM memory_passes').get() as {
      total: number;
    };
    return Number(row.total);
  }

  close(): void {
    this.db.close();
  }

  /** Short ids collide at a rate worth one retry loop and no more. */
  private freshId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.mintId();
      if (this.get(id) === undefined) return id;
    }
    throw new Error('could not mint a free memory id');
  }
}

function randomId(): string {
  let id = '';
  for (const byte of randomBytes(ID_LENGTH)) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function toMemoryRow(row: Record<string, unknown>): MemoryRow {
  return {
    id: row.id as string,
    subjectUserId: row.subject_user_id as string,
    participantUserIds: parseIds(row.participant_user_ids),
    nature: row.nature as MemoryRow['nature'],
    text: row.text as string,
    createdAt: row.created_at as string,
    sourceThreadTs: (row.source_thread_ts ?? null) as string | null,
    sourceChannelId: (row.source_channel_id ?? null) as string | null,
    recurrenceCount: Number(row.recurrence_count),
    lastSeenAt: row.last_seen_at as string,
  };
}

/** The column is JSON the daemon wrote; anything else reads as nobody. */
function parseIds(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

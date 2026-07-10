import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './db.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0EXAMPLE123';
const USER = 'U0EXAMPLE456';

describe('SessionStore', () => {
  const tempDirs: string[] = [];
  const stores: SessionStore[] = [];

  const memoryStore = (now?: () => string): SessionStore => {
    const store = new SessionStore(':memory:', now);
    stores.push(store);
    return store;
  };

  const tempDbPath = (...segments: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-db-'));
    tempDirs.push(dir);
    return join(dir, ...segments);
  };

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('registers a thread and reads it back with the spec §9 defaults', () => {
    const store = memoryStore(() => '2026-07-08T10:00:00.000Z');

    store.register(THREAD, CHANNEL, USER);

    expect(store.get(THREAD, CHANNEL)).toEqual({
      threadTs: THREAD,
      channelId: CHANNEL,
      sessionId: null,
      rootUser: USER,
      status: 'open',
      createdAt: '2026-07-08T10:00:00.000Z',
      lastActivityAt: '2026-07-08T10:00:00.000Z',
      turnCount: 0,
      costUsdTotal: 0,
      closedAt: null,
    });
  });

  it('returns undefined for a thread that was never registered', () => {
    const store = memoryStore();

    expect(store.get(THREAD, CHANNEL)).toBeUndefined();
  });

  it('keeps the original row when the same thread is registered twice', () => {
    const store = memoryStore();
    store.register(THREAD, CHANNEL, USER);
    store.setSessionId(THREAD, CHANNEL, 'sess-1');

    store.register(THREAD, CHANNEL, USER);

    expect(store.get(THREAD, CHANNEL)?.sessionId).toBe('sess-1');
  });

  it('persists the session_id — the durable anchor of spec §3', () => {
    const store = memoryStore();
    store.register(THREAD, CHANNEL, USER);

    store.setSessionId(THREAD, CHANNEL, '3fca8a24-9d13-4a5e-a1b2-000000000001');

    expect(store.get(THREAD, CHANNEL)?.sessionId).toBe(
      '3fca8a24-9d13-4a5e-a1b2-000000000001',
    );
  });

  it('recordTurn increments the turn count and refreshes last_activity_at', () => {
    const timestamps = [
      '2026-07-08T10:00:00.000Z',
      '2026-07-08T10:05:00.000Z',
      '2026-07-08T10:09:00.000Z',
    ];
    const store = memoryStore(() => timestamps.shift() ?? '2026-07-08T23:59:59.000Z');
    store.register(THREAD, CHANNEL, USER);

    store.recordTurn(THREAD, CHANNEL, 0);
    store.recordTurn(THREAD, CHANNEL, 0);

    const row = store.get(THREAD, CHANNEL);
    expect(row?.turnCount).toBe(2);
    expect(row?.lastActivityAt).toBe('2026-07-08T10:09:00.000Z');
    expect(row?.createdAt).toBe('2026-07-08T10:00:00.000Z');
  });

  it('recordTurn accumulates the per-turn cost into cost_usd_total (spec §7)', () => {
    const store = memoryStore();
    store.register(THREAD, CHANNEL, USER);

    store.recordTurn(THREAD, CHANNEL, 0.42);
    store.recordTurn(THREAD, CHANNEL, 1.08);

    expect(store.get(THREAD, CHANNEL)?.costUsdTotal).toBeCloseTo(1.5);
  });

  it('rows survive a close-and-reopen — the restart of the demo scenario', () => {
    const dbPath = tempDbPath('orchestrator.db');
    const first = new SessionStore(dbPath);
    first.register(THREAD, CHANNEL, USER);
    first.setSessionId(THREAD, CHANNEL, 'sess-persisted');
    first.recordTurn(THREAD, CHANNEL, 3.21);
    first.close();

    const reopened = new SessionStore(dbPath);
    stores.push(reopened);

    const row = reopened.get(THREAD, CHANNEL);
    expect(row?.sessionId).toBe('sess-persisted');
    expect(row?.turnCount).toBe(1);
    expect(row?.costUsdTotal).toBeCloseTo(3.21);
  });

  it('creates missing parent directories for the database path (spec §9 home)', () => {
    const dbPath = tempDbPath('state', 'orchestrator', 'orchestrator.db');

    const store = new SessionStore(dbPath);
    stores.push(store);
    store.register(THREAD, CHANNEL, USER);

    expect(store.count()).toBe(1);
  });

  it('touch refreshes last_activity_at without counting a turn', () => {
    const timestamps = ['2026-07-08T10:00:00.000Z', '2026-07-08T11:00:00.000Z'];
    const store = memoryStore(() => timestamps.shift() ?? '2026-07-08T23:59:59.000Z');
    store.register(THREAD, CHANNEL, USER);

    store.touch(THREAD, CHANNEL);

    const row = store.get(THREAD, CHANNEL);
    expect(row?.lastActivityAt).toBe('2026-07-08T11:00:00.000Z');
    expect(row?.turnCount).toBe(0);
  });

  it('closeSession flips the row to its terminal status and keeps the history (spec §3)', () => {
    const store = memoryStore();
    store.register(THREAD, CHANNEL, USER);
    store.recordTurn(THREAD, CHANNEL, 1.5);

    store.closeSession(THREAD, CHANNEL);

    const row = store.get(THREAD, CHANNEL);
    expect(row?.status).toBe('closed');
    expect(row?.turnCount).toBe(1);
    expect(row?.costUsdTotal).toBeCloseTo(1.5);
  });

  it('closeSession stamps when it happened — a sweep-closed dormant session closes NOW, not 7 days ago (issue #87)', () => {
    const timestamps = ['2026-07-01T10:00:00.000Z', '2026-07-08T10:00:00.000Z'];
    const store = memoryStore(() => timestamps.shift() ?? '2026-07-08T23:59:59.000Z');
    store.register(THREAD, CHANNEL, USER);

    store.closeSession(THREAD, CHANNEL);

    const row = store.get(THREAD, CHANNEL);
    expect(row?.closedAt).toBe('2026-07-08T10:00:00.000Z');
    // The dormancy clock is untouched — closing is not activity.
    expect(row?.lastActivityAt).toBe('2026-07-01T10:00:00.000Z');
  });

  it('migrates a pre-#87 sessions table in place — rows survive, closing stamps', () => {
    const dbPath = tempDbPath('orchestrator.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
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
    legacy
      .prepare(
        `INSERT INTO sessions (thread_ts, channel_id, root_user, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(THREAD, CHANNEL, USER, '2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z');
    legacy.close();

    const store = new SessionStore(dbPath, () => '2026-07-08T10:00:00.000Z');
    stores.push(store);

    expect(store.get(THREAD, CHANNEL)?.closedAt).toBeNull();
    store.closeSession(THREAD, CHANNEL);
    expect(store.get(THREAD, CHANNEL)?.closedAt).toBe('2026-07-08T10:00:00.000Z');
  });

  it('a closed row survives a close-and-reopen — closed is final across restarts', () => {
    const dbPath = tempDbPath('orchestrator.db');
    const first = new SessionStore(dbPath);
    first.register(THREAD, CHANNEL, USER);
    first.closeSession(THREAD, CHANNEL);
    first.close();

    const reopened = new SessionStore(dbPath);
    stores.push(reopened);

    expect(reopened.get(THREAD, CHANNEL)?.status).toBe('closed');
  });

  it('openSessionsInactiveSince shortlists only open rows idle past the cutoff, oldest first', () => {
    const timestamps = [
      '2026-06-20T00:00:00.000Z', // oldest — but will be closed
      '2026-07-01T00:00:00.000Z', // old and open — the sweep's target
      '2026-07-07T00:00:00.000Z', // recent — untouched
    ];
    const store = memoryStore(() => timestamps.shift() ?? '2026-07-08T00:00:00.000Z');
    store.register('1751970002.000300', CHANNEL, USER);
    store.register(THREAD, CHANNEL, USER);
    store.register('1751970001.000200', CHANNEL, USER);
    store.closeSession('1751970002.000300', CHANNEL);

    const dormant = store.openSessionsInactiveSince('2026-07-02T00:00:00.000Z');

    expect(dormant.map((row) => row.threadTs)).toEqual([THREAD]);
  });

  it('counts registered sessions for the boot log', () => {
    const store = memoryStore();
    store.register(THREAD, CHANNEL, USER);
    store.register('1751970001.000200', CHANNEL, USER);

    expect(store.count()).toBe(2);
  });

  it('puts the database file in WAL mode — the dashboard reader depends on it (ADR 0002)', () => {
    const dbPath = tempDbPath('orchestrator.db');
    const store = new SessionStore(dbPath);
    stores.push(store);
    store.register(THREAD, CHANNEL, USER);

    const reader = new DatabaseSync(dbPath, { readOnly: true });
    const mode = reader.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    reader.close();

    expect(mode.journal_mode).toBe('wal');
  });
});

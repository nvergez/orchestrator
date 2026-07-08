import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './db.ts';

const THREAD = '1751970000.000100';
const CHANNEL = 'C0ASJR3LAE6';
const USER = 'U09CC6M3W1W';

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

  it('counts registered sessions for the boot log', () => {
    const store = memoryStore();
    store.register(THREAD, CHANNEL, USER);
    store.register('1751970001.000200', CHANNEL, USER);

    expect(store.count()).toBe(2);
  });
});

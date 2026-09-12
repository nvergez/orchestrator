import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../daemon/db.ts';
import { MemoryStore } from './store.ts';

/**
 * The store and its forward migration, with the session store's migration
 * tests as prior art: a database that predates the feature opens, gains the
 * memory tables, and reads correctly — no manual step, nothing lost.
 */

const THREAD = '1751970000.000100';
const CHANNEL = 'C0EXAMPLE123';
const ALICE = 'U0ALICE';
const BOB = 'U0BOB';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orc-memory-'));
  dirs.push(dir);
  return join(dir, 'orchestrator.db');
};

const write = (
  store: MemoryStore,
  subject: string,
  text: string,
  nature: 'durable' | 'moment' = 'moment',
  participants: string[] = [],
): string => {
  const id = store.add({
    subjectUserId: subject,
    participantUserIds: participants,
    nature,
    text,
    sourceThreadTs: THREAD,
    sourceChannelId: CHANNEL,
  });
  if (id === undefined) throw new Error('expected the memory to be written');
  return id;
};

describe('MemoryStore — forward migration', () => {
  it('adds the memory tables to a database that predates the feature and keeps its sessions', () => {
    const dbPath = tempDbPath();
    const sessions = new SessionStore(dbPath);
    sessions.register(THREAD, CHANNEL, ALICE);
    sessions.close();

    const memory = new MemoryStore(dbPath);
    const id = write(memory, ALICE, 'Lives in the webapp repo.', 'durable');
    expect(memory.listForPerson(ALICE).map((row) => row.id)).toEqual([id]);
    memory.close();

    const reopened = new SessionStore(dbPath);
    expect(reopened.get(THREAD, CHANNEL)?.rootUser).toBe(ALICE);
    reopened.close();
  });

  it('adds the deletion tombstones to a database from before they existed', () => {
    const dbPath = tempDbPath();
    // A database written by the first version of the feature: memories, no
    // tombstones. Opening it must gain the table and lose nothing.
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, subject_user_id TEXT NOT NULL,
        participant_user_ids TEXT NOT NULL DEFAULT '[]',
        nature TEXT NOT NULL CHECK (nature IN ('durable', 'moment')),
        text TEXT NOT NULL, created_at TEXT NOT NULL,
        source_thread_ts TEXT, source_channel_id TEXT,
        recurrence_count INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO memories VALUES ('ab12cd', '${ALICE}', '[]', 'durable', 'Lives in webapp.',
        '2026-09-01T10:00:00.000Z', NULL, NULL, 1, '2026-09-01T10:00:00.000Z');
    `);
    old.close();

    const store = new MemoryStore(dbPath);
    const row = store.get('ab12cd')!;
    expect(row.text).toBe('Lives in webapp.');
    store.recordDeletion(row);
    expect(store.deletionsSince('2026-09-01T00:00:00.000Z')).toEqual([
      { subjectUserId: ALICE, text: 'Lives in webapp.' },
    ]);
    store.close();
  });

  it('survives a reopen of its own database and keeps WAL on', () => {
    const dbPath = tempDbPath();
    const first = new MemoryStore(dbPath);
    const id = write(first, ALICE, 'Wants a PR, never a patch.', 'durable');
    first.optOut(BOB);
    first.close();

    const second = new MemoryStore(dbPath);
    expect(second.get(id)?.text).toBe('Wants a PR, never a patch.');
    expect(second.isOptedOut(BOB)).toBe(true);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    expect(String((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode)).toBe('wal');
    db.close();
    second.close();
  });
});

describe('MemoryStore — portraits', () => {
  it('puts one shared record in both portraits and removes it from both at once', () => {
    const store = new MemoryStore(':memory:');
    const shared = write(store, ALICE, 'Argued about the gate policy, loudly.', 'moment', [BOB]);
    const alone = write(store, ALICE, 'Works in webapp.', 'durable');

    expect(store.listForPerson(ALICE).map((row) => row.id)).toEqual([shared, alone]);
    expect(store.listForPerson(BOB).map((row) => row.id)).toEqual([shared]);

    expect(store.delete(shared)).toBe(true);
    expect(store.listForPerson(BOB)).toEqual([]);
    expect(store.listForPerson(ALICE).map((row) => row.id)).toEqual([alone]);
    store.close();
  });

  it('mints distinct short ids a human can retype', () => {
    const store = new MemoryStore(':memory:');
    const ids = Array.from({ length: 40 }, (_, i) => write(store, ALICE, `thing ${i}`));
    expect(new Set(ids).size).toBe(40);
    expect(ids.every((id) => /^[2-9bcdfghjkmnpqrstvwxz]{6}$/.test(id))).toBe(true);
    store.close();
  });

  it('promotes a recurring moment into a durable fact', () => {
    const store = new MemoryStore(':memory:');
    const id = write(store, ALICE, 'Calls the deploy script "the goat".');
    expect(store.noteRecurrence(id)).toBe(2);
    expect(store.noteRecurrence(id)).toBe(3);
    store.promote(id);
    expect(store.get(id)?.nature).toBe('durable');
    store.close();
  });
});

describe('MemoryStore — opt-out', () => {
  it('purges the portrait, tombstones the person, and refuses later writes', () => {
    const store = new MemoryStore(':memory:');
    write(store, ALICE, 'Works in webapp.', 'durable');
    const shared = write(store, BOB, 'Laughed about the toaster.', 'moment', [ALICE]);

    expect(store.optOut(ALICE)).toBe(1);
    expect(store.listForPerson(ALICE)).toEqual([]);
    // Someone else's record survives — with them struck out of it.
    expect(store.get(shared)?.participantUserIds).toEqual([]);
    expect(store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'durable',
      text: 'still here', sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })).toBeUndefined();
    // And they are never added as a participant of someone else's memory.
    const later = write(store, BOB, 'Shipped the CSV export.', 'moment', [ALICE]);
    expect(store.get(later)?.participantUserIds).toEqual([]);

    store.optIn(ALICE);
    expect(store.isOptedOut(ALICE)).toBe(false);
    store.close();
  });
});

describe('MemoryStore — participants and extraction bookkeeping', () => {
  it('records only who spoke, in arrival order', () => {
    let clock = 0;
    const store = new MemoryStore(':memory:', () => new Date(1_700_000_000_000 + (clock += 1000)).toISOString());
    store.noteParticipant(THREAD, CHANNEL, ALICE);
    store.noteParticipant(THREAD, CHANNEL, BOB);
    store.noteParticipant(THREAD, CHANNEL, ALICE);
    expect(store.participants(THREAD, CHANNEL).map((row) => row.userId)).toEqual([ALICE, BOB]);
    store.close();
  });

  it('lists the threads a failed pass still owes an attempt, and nothing else', () => {
    const store = new MemoryStore(':memory:');
    store.advance(THREAD, CHANNEL, '1751970005.000100', '2026-09-11T10:00:00.000Z');
    expect(store.pendingExtractions()).toEqual([]);
    store.recordAttempt(THREAD, CHANNEL);
    // Whether the session is still open is not this table's business: the
    // retry was promised here, so it is owed here (spec §12).
    expect(store.pendingExtractions()).toEqual([
      { threadTs: THREAD, channelId: CHANNEL, activityMark: '2026-09-11T10:00:00.000Z', attempts: 1 },
    ]);
    store.advance(THREAD, CHANNEL, '1751970009.000100', '2026-09-11T11:00:00.000Z');
    expect(store.pendingExtractions()).toEqual([]);
    store.close();
  });

  it('remembers a deletion for a while, so a pass in flight cannot undo it', () => {
    let clock = Date.parse('2026-09-11T10:00:00.000Z');
    const store = new MemoryStore(':memory:', () => new Date(clock).toISOString());
    const id = write(store, ALICE, 'Calls the deploy script the goat.', 'moment');
    const row = store.get(id)!;
    store.delete(id);
    store.recordDeletion(row);
    expect(store.deletionsSince('2026-09-11T09:00:00.000Z')).toEqual([
      { subjectUserId: ALICE, text: 'Calls the deploy script the goat.' },
    ]);
    // A pass that started AFTER the deletion has nothing to hold back.
    expect(store.deletionsSince('2026-09-11T10:00:01.000Z')).toEqual([]);

    // And a tombstone is not a life sentence: weeks later the daemon may
    // learn the same thing again, because it became true again.
    clock = Date.parse('2026-10-11T10:00:00.000Z');
    store.recordDeletion({ ...row, subjectUserId: BOB, text: 'Something else.' });
    expect(store.deletionsSince('2026-09-11T09:00:00.000Z')).toEqual([
      { subjectUserId: BOB, text: 'Something else.' },
    ]);
    store.close();
  });

  it('holds the slice for the attempt limit, then advances it', () => {
    const store = new MemoryStore(':memory:');
    expect(store.extraction(THREAD, CHANNEL)).toEqual({ watermarkTs: '0', activityMark: '', attempts: 0 });
    store.advance(THREAD, CHANNEL, '1751970005.000100', '2026-09-11T10:00:00.000Z');
    expect(store.recordAttempt(THREAD, CHANNEL)).toBe(1);
    expect(store.recordAttempt(THREAD, CHANNEL)).toBe(2);
    // A held slice keeps both marks exactly where the last pass left them.
    expect(store.extraction(THREAD, CHANNEL)).toEqual({
      watermarkTs: '1751970005.000100', activityMark: '2026-09-11T10:00:00.000Z', attempts: 2,
    });
    store.advance(THREAD, CHANNEL, '1751970009.000100', '2026-09-11T11:00:00.000Z');
    expect(store.extraction(THREAD, CHANNEL).attempts).toBe(0);
    store.close();
  });

  it('counts pass spend on its own meter', () => {
    const store = new MemoryStore(':memory:');
    expect(store.passCostUsdTotal()).toBe(0);
    store.recordPass({ threadTs: THREAD, channelId: CHANNEL, outcome: 'wrote', written: 2, dropped: 1, costUsd: 0.02 });
    store.recordPass({ threadTs: THREAD, channelId: CHANNEL, outcome: 'empty', written: 0, dropped: 0, costUsd: 0.01 });
    expect(store.passCostUsdTotal()).toBeCloseTo(0.03, 6);
    store.close();
  });
});

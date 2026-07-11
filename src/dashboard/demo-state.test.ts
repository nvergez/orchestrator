import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedDemoState } from './demo-state.ts';
import { readSnapshot, type StateSnapshot } from './snapshot.ts';

/**
 * Demo state's contract (issue #94), observed through the dashboard's own
 * read model: whatever `now` the seed is given, every section renders, and
 * a reseed starts from scratch. The exact content at a pinned clock stays
 * the HTTP-seam suite's business (server.test.ts) — these tests pin the
 * properties that hold for ANY clock.
 */

const tempDirs: string[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-demo-state-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const snapshotAt = (dbPath: string, now: string): Promise<StateSnapshot> =>
  readSnapshot({
    dbPath,
    now: () => now,
    daemonUnitState: () => Promise.resolve('active'),
    linkIssues: (rows) => Promise.resolve(rows),
  });

// Nothing about this instant is special — the point is that it isn't.
const SOME_NOW = '2026-03-05T21:17:00.000Z';

describe('seedDemoState — a representative database for any clock', () => {
  it('makes every dashboard section render from a single seed', async () => {
    const dbPath = join(tempDir(), 'demo.db');

    seedDemoState(dbPath, new Date(SOME_NOW));
    const state = await snapshotAt(dbPath, SOME_NOW);

    // The live session card carries the in-flight delegation, its bus
    // heartbeat already recorded; the orphaned in-flight thread gets its
    // own card rather than hiding behind the missing session row.
    expect(state.noStateYet).toBe(false);
    expect(state.sessions.map((card) => card.status)).toEqual(['open', 'unknown']);
    const [live, orphan] = state.sessions;
    expect(live?.delegations.map((row) => row.status)).toEqual(['dispatched']);
    expect(live?.delegations[0]?.lastBusAt).not.toBeNull();
    expect(orphan?.delegations.map((row) => row.status)).toEqual(['dispatched']);

    // One pending decision gate and one pending escalation — the answered
    // gate must have left the pending list.
    expect(state.pendingGates.map((gate) => gate.kind)).toEqual(['decision_gate', 'escalation']);
    expect(state.pendingStalls).toHaveLength(1);

    // Recently closed: one completed and one failed delegation inside the
    // ~48h window, the older completion aged out; one swept session.
    expect(
      state.recentlyClosed.delegations.map((row) => row.status).toSorted(),
    ).toEqual(['completed', 'failed']);
    expect(state.recentlyClosed.sessions).toHaveLength(1);
  });

  it('seeded yesterday, still fresh today — recent content outlives a day of aging', async () => {
    const dbPath = join(tempDir(), 'demo.db');
    const YESTERDAY = '2026-03-04T21:17:00.000Z';

    seedDemoState(dbPath, new Date(YESTERDAY));
    const state = await snapshotAt(dbPath, SOME_NOW);

    // The live and orphan cards persist by construction; the closed
    // delegations (16–18h before seed) must still sit inside the ~48h
    // window a full day later. The swept session's close is pinned at 26h
    // by the HTTP-seam suite's exact assertions, so it ages out of the
    // window the way real data would — reseeding is the freshness ritual.
    expect(state.sessions).toHaveLength(2);
    expect(state.recentlyClosed.delegations).toHaveLength(2);
    expect(state.pendingGates).toHaveLength(2);
    expect(state.pendingStalls).toHaveLength(1);
  });

  it('reseeds from scratch — a second seed leaves no trace of the first', async () => {
    const dbPath = join(tempDir(), 'demo.db');
    const LATER = '2026-03-06T09:00:00.000Z';

    seedDemoState(dbPath, new Date(SOME_NOW));
    seedDemoState(dbPath, new Date(LATER));

    // Indistinguishable from a single seed at the later clock: no
    // accumulated turns or costs, no stale closed-at stamps.
    const fresh = join(tempDir(), 'fresh.db');
    seedDemoState(fresh, new Date(LATER));
    expect(await snapshotAt(dbPath, LATER)).toEqual(await snapshotAt(fresh, LATER));
  });
});

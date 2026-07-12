import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../daemon/db.ts';
import { DelegationStore } from '../delegation/delegations.ts';
import { CHANNEL, seedDemoState, THREAD, THREAD_CLOSED, THREAD_ORPHAN, USER } from './demo-state.ts';
import { startDashboard, type DashboardHandle } from './server.ts';
import { readSnapshot, type SnapshotDeps, type StateSnapshot } from './snapshot.ts';

/**
 * The one new seam of issue #87: what an HTTP client of the sidecar sees.
 * The temp SQLite file is populated through the real daemon stores — the
 * shared demo state (demo-state.ts) writes via SessionStore and
 * DelegationStore exactly like their own suites do — so these tests pin
 * the /api/state contract the frontend consumes without ever asserting on
 * internal queries.
 */

const NOW = '2026-07-10T12:00:00.000Z';

const tempDirs: string[] = [];
const handles: DashboardHandle[] = [];

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestrator-dashboard-'));
  tempDirs.push(dir);
  return dir;
};

const snapshotDeps = (dbPath: string, overrides: Partial<SnapshotDeps> = {}): SnapshotDeps => ({
  dbPath,
  now: () => NOW,
  daemonUnitState: () => Promise.resolve('active'),
  linkIssues: (rows) => Promise.resolve(rows),
  ...overrides,
});

const serve = async (
  deps: SnapshotDeps,
  assetsDir: string | null = null,
): Promise<{ baseUrl: string }> => {
  const handle = await startDashboard({
    bind: '127.0.0.1',
    port: 0,
    assetsDir,
    snapshot: () => readSnapshot(deps),
  });
  handles.push(handle);
  return { baseUrl: `http://127.0.0.1:${handle.port}` };
};

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/state — the snapshot contract', () => {
  it('renders a calm "no state yet" when the database has never existed', async () => {
    const dbPath = join(tempDir(), 'orchestrator.db');
    const { baseUrl } = await serve(snapshotDeps(dbPath));

    const response = await fetch(`${baseUrl}/api/state`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      asOf: NOW,
      noStateYet: true,
      daemon: { unitState: 'active' },
      sessions: [],
      pendingGates: [],
      pendingStalls: [],
      recentlyClosed: { delegations: [], sessions: [] },
    });
  });

  it('never creates the database file — observing must not disturb (ADR 0002)', async () => {
    const dbPath = join(tempDir(), 'orchestrator.db');
    const { baseUrl } = await serve(snapshotDeps(dbPath));

    await fetch(`${baseUrl}/api/state`);

    expect(existsSync(dbPath)).toBe(false);
  });

  it('reports the daemon unit state even with no database — down is never "all quiet"', async () => {
    const dbPath = join(tempDir(), 'orchestrator.db');
    const { baseUrl } = await serve(
      snapshotDeps(dbPath, { daemonUnitState: () => Promise.resolve('failed') }),
    );

    const state = (await (await fetch(`${baseUrl}/api/state`)).json()) as {
      daemon: { unitState: string };
    };

    expect(state.daemon.unitState).toBe('failed');
  });
});

/**
 * A database as the daemon leaves it — the shared demo state (issue #94)
 * pinned to NOW, so the ~48h recently-closed window opens at
 * 2026-07-08T12:00Z and every asserted timestamp below stays exact.
 */
const populatedDb = (): string => {
  const dbPath = join(tempDir(), 'orchestrator.db');
  seedDemoState(dbPath, new Date(NOW));
  return dbPath;
};

describe('GET /api/state — live state off a daemon-written database', () => {
  it('keeps equal timestamps in different channels as separate session cards', async () => {
    const dbPath = join(tempDir(), 'orchestrator.db');
    const sessions = new SessionStore(dbPath, () => '2026-07-10T10:00:00.000Z');
    sessions.register(THREAD, 'C0FIRST', 'U0FIRST');
    sessions.register(THREAD, 'C0SECOND', 'U0SECOND');
    sessions.close();
    const delegations = new DelegationStore(dbPath, () => '2026-07-10T10:01:00.000Z');
    for (const [dispatchId, channelId] of [
      ['ctx_first', 'C0FIRST'],
      ['ctx_second', 'C0SECOND'],
    ] as const) {
      delegations.recordDispatch({
        dispatchId,
        taskId: `task_${dispatchId}`,
        worktreeId: null,
        worktreeName: null,
        worktreePath: null,
        repo: null,
        issueNumber: null,
        agent: null,
        workerHandle: null,
        threadTs: THREAD,
        channelId,
        cardTs: null,
        title: null,
      });
    }
    delegations.close();

    const state = await readSnapshot(snapshotDeps(dbPath));
    const cards = [...state.sessions].sort((a, b) => (a.channelId ?? '').localeCompare(b.channelId ?? ''));
    expect(cards.map((session) => [session.channelId, session.rootUser])).toEqual([
      ['C0FIRST', 'U0FIRST'],
      ['C0SECOND', 'U0SECOND'],
    ]);
    expect(cards.map((session) => session.delegations[0]?.dispatchId)).toEqual([
      'ctx_first',
      'ctx_second',
    ]);
  });

  it('snapshots sessions, in-flight delegations, gates verbatim, stalls and the 48h window', async () => {
    const { baseUrl } = await serve(snapshotDeps(populatedDb()));

    const response = await fetch(`${baseUrl}/api/state`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      asOf: NOW,
      noStateYet: false,
      daemon: { unitState: 'active' },
      sessions: [
        {
          threadTs: THREAD,
          channelId: CHANNEL,
          rootUser: USER,
          status: 'open',
          createdAt: '2026-07-09T09:00:00.000Z',
          lastActivityAt: '2026-07-10T08:00:00.000Z',
          turnCount: 2,
          costUsdTotal: 1.5,
          delegations: [
            {
              dispatchId: 'ctx_live',
              threadTs: THREAD,
              channelId: CHANNEL,
              repo: 'webapp',
              issueNumber: 84,
              agent: 'claude',
              worktreeName: 'webapp-84-dashboard',
              title: 'Dashboard read-only web view',
              status: 'dispatched',
              dispatchedAt: '2026-07-10T09:00:00.000Z',
              lastBusAt: '2026-07-10T11:58:00.000Z',
              closedAt: null,
            },
          ],
        },
        // A thread with in-flight work but no session row still shows.
        {
          threadTs: THREAD_ORPHAN,
          channelId: CHANNEL,
          rootUser: null,
          status: 'unknown',
          createdAt: null,
          lastActivityAt: null,
          turnCount: 0,
          costUsdTotal: 0,
          delegations: [
            {
              dispatchId: 'ctx_orphan',
              threadTs: THREAD_ORPHAN,
              channelId: CHANNEL,
              repo: 'sandbox',
              issueNumber: 21,
              agent: 'codex',
              worktreeName: 'sandbox-21-bench',
              title: 'bench harness',
              status: 'dispatched',
              dispatchedAt: '2026-07-10T10:00:00.000Z',
              lastBusAt: null,
              closedAt: null,
            },
          ],
        },
      ],
      pendingGates: [
        {
          msgId: 'msg_gate',
          threadTs: THREAD,
          channelId: CHANNEL,
          kind: 'decision_gate',
          question: 'Migrations diverge — rebase or merge?',
          options: ['rebase', 'merge'],
          worktreeName: 'webapp-84-dashboard',
          relayedAt: '2026-07-10T11:00:00.000Z',
        },
        {
          msgId: 'msg_escalation',
          threadTs: THREAD,
          channelId: CHANNEL,
          kind: 'escalation',
          question: 'CI is red on main — halt the merge?',
          options: [],
          worktreeName: 'webapp-84-dashboard',
          relayedAt: '2026-07-10T11:30:00.000Z',
        },
      ],
      pendingStalls: [
        {
          dispatchId: 'ctx_live',
          threadTs: THREAD,
          channelId: CHANNEL,
          worktreeName: 'webapp-84-dashboard',
          lastOutput: '… waiting at a permissions prompt',
          alertedAt: '2026-07-10T11:45:00.000Z',
        },
      ],
      recentlyClosed: {
        delegations: [
          {
            dispatchId: 'ctx_fail',
            threadTs: THREAD,
            channelId: CHANNEL,
            repo: 'webapp',
            issueNumber: 84,
            agent: 'claude',
            worktreeName: 'webapp-84-dashboard',
            title: 'Dashboard read-only web view',
            status: 'failed',
            dispatchedAt: '2026-07-09T19:00:00.000Z',
            lastBusAt: null,
            closedAt: '2026-07-09T20:00:00.000Z',
          },
          {
            dispatchId: 'ctx_done',
            threadTs: THREAD,
            channelId: CHANNEL,
            repo: 'webapp',
            issueNumber: 84,
            agent: 'claude',
            worktreeName: 'webapp-84-dashboard',
            title: 'Dashboard read-only web view',
            status: 'completed',
            dispatchedAt: '2026-07-09T15:00:00.000Z',
            lastBusAt: null,
            closedAt: '2026-07-09T18:00:00.000Z',
          },
        ],
        sessions: [
          {
            threadTs: THREAD_CLOSED,
            channelId: CHANNEL,
            rootUser: USER,
            createdAt: '2026-07-05T10:00:00.000Z',
            lastActivityAt: '2026-07-05T10:00:00.000Z',
            closedAt: '2026-07-09T10:00:00.000Z',
            turnCount: 0,
            costUsdTotal: 0,
          },
        ],
      },
    } satisfies StateSnapshot);
  });

  it('links delegations to their GitHub issues through the injected registry lookup', async () => {
    const { baseUrl } = await serve(
      snapshotDeps(populatedDb(), {
        linkIssues: (rows) =>
          Promise.resolve(
            rows.map((row) =>
              row.repo === 'webapp' && row.issueNumber !== null
                ? { ...row, issueUrl: `https://github.com/acme/webapp/issues/${row.issueNumber}` }
                : row,
            ),
          ),
      }),
    );

    const state = (await (await fetch(`${baseUrl}/api/state`)).json()) as StateSnapshot;

    expect(state.sessions[0]?.delegations[0]?.issueUrl).toBe(
      'https://github.com/acme/webapp/issues/84',
    );
    // The orphan repo has no link — the row simply carries none.
    expect(state.sessions[1]?.delegations[0]?.issueUrl).toBeUndefined();
    expect(state.recentlyClosed.delegations.map((row) => row.issueUrl)).toEqual([
      'https://github.com/acme/webapp/issues/84',
      'https://github.com/acme/webapp/issues/84',
    ]);
  });

  it('serves the built frontend at / and its hashed assets, and 404s the rest', async () => {
    const assetsDir = tempDir();
    mkdirSync(join(assetsDir, 'assets'), { recursive: true });
    writeFileSync(join(assetsDir, 'index.html'), '<!doctype html><title>Dashboard</title>');
    writeFileSync(join(assetsDir, 'assets', 'index-abc123.js'), 'console.log("dashboard")');
    const { baseUrl } = await serve(snapshotDeps(join(tempDir(), 'orchestrator.db')), assetsDir);

    const page = await fetch(`${baseUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>Dashboard</title>');

    const script = await fetch(`${baseUrl}/assets/index-abc123.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');

    expect((await fetch(`${baseUrl}/nope.js`)).status).toBe(404);
  });

  it('shrugs off malformed percent-encoding — one bad request must never kill the sidecar', async () => {
    const assetsDir = tempDir();
    writeFileSync(join(assetsDir, 'index.html'), 'ok');
    const { baseUrl } = await serve(snapshotDeps(join(tempDir(), 'orchestrator.db')), assetsDir);

    const bad = await fetch(`${baseUrl}/%zz`);

    expect(bad.status).toBe(404);
    // The process survived: the page is still being served.
    expect((await fetch(`${baseUrl}/api/state`)).status).toBe(200);
  });

  it('refuses path traversal out of the assets dir', async () => {
    const parent = tempDir();
    const assetsDir = join(parent, 'web');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, 'index.html'), 'ok');
    writeFileSync(join(parent, 'secret.txt'), 'never served');
    const { baseUrl } = await serve(snapshotDeps(join(tempDir(), 'orchestrator.db')), assetsDir);

    const response = await fetch(`${baseUrl}/..%2Fsecret.txt`);

    expect(response.status).toBe(404);
  });

  it('explains itself at / when the frontend was never built, instead of erroring', async () => {
    const { baseUrl } = await serve(snapshotDeps(join(tempDir(), 'orchestrator.db')), null);

    const page = await fetch(`${baseUrl}/`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('npm run build:web');
  });

  it('keeps reading while a live daemon keeps writing — WAL coexistence (ADR 0002)', async () => {
    const dbPath = join(tempDir(), 'orchestrator.db');
    const sessions = new SessionStore(dbPath);
    sessions.register(THREAD, CHANNEL, USER);
    const { baseUrl } = await serve(snapshotDeps(dbPath));

    const before = (await (await fetch(`${baseUrl}/api/state`)).json()) as StateSnapshot;
    // The daemon writes between two polls — neither side may trip.
    sessions.recordTurn(THREAD, CHANNEL, 0.25);
    const after = (await (await fetch(`${baseUrl}/api/state`)).json()) as StateSnapshot;
    sessions.close();

    expect(before.sessions[0]?.turnCount).toBe(0);
    expect(after.sessions[0]?.turnCount).toBe(1);
    expect(after.sessions[0]?.costUsdTotal).toBeCloseTo(0.25);
  });
});

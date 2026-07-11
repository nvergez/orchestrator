import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readSnapshot } from './snapshot.ts';

/**
 * The explicit command itself (`npm run seed:demo`): it writes `.dev/demo.db`
 * under the working directory and nowhere else. ORCHESTRATOR_DB_PATH means
 * "where the real database lives" everywhere else in the project, so the
 * destructive reseed must not honor it — ambient daemon env could otherwise
 * aim it at a real database (CONTEXT.md: Demo state, "never by accident").
 */

const SEED_DEMO = fileURLToPath(new URL('./seed-demo.ts', import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('seed-demo — the explicit command', () => {
  it('seeds .dev/demo.db under the working directory, never the env-configured database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-seed-demo-'));
    tempDirs.push(dir);
    const realDb = join(dir, 'real-daemon.db');

    const run = spawnSync(process.execPath, [SEED_DEMO], {
      cwd: dir,
      env: { ...process.env, ORCHESTRATOR_DB_PATH: realDb },
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);
    expect(existsSync(realDb)).toBe(false);
    const snapshot = await readSnapshot({
      dbPath: join(dir, '.dev', 'demo.db'),
      now: () => new Date().toISOString(),
      daemonUnitState: () => Promise.resolve('inactive'),
      linkIssues: (rows) => Promise.resolve(rows),
    });
    expect(snapshot.noStateYet).toBe(false);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.pendingGates).toHaveLength(2);
  });
});

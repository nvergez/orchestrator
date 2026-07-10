import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, resolveDashboardAddress, type DashboardAddress } from '../kernel/config.ts';
import { createLogger } from '../kernel/logger.ts';
import { execFileRunner, safeRegistryIssueUrls } from '../kernel/orca.ts';
import { unitActiveState } from '../kernel/systemd.ts';
import { resolveDefaultDbPath } from '../kernel/xdg.ts';
import { startDashboard } from './server.ts';
import { readSnapshot } from './snapshot.ts';

/**
 * The dashboard sidecar boot — what `orc dashboard` runs, and what the
 * `orchestrator-dashboard` systemd unit supervises. Deliberately thin like
 * the daemon boot: env config and process lifecycle live here; everything
 * testable lives behind the server/snapshot seams. It needs none of the
 * daemon's Slack tokens — the ops view must come up exactly when the
 * daemon cannot (ADR 0002).
 */

/**
 * The built frontend: `dist/web` — one hop up from this module's compiled
 * home (`dist/dashboard/`), two-plus-`dist` when running from `src/` under
 * type stripping. Null when never built; the server then explains itself.
 */
function resolveAssetsDir(): string | null {
  for (const candidate of ['../web/', '../../dist/web/']) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

export async function runDashboard(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
  let address: DashboardAddress;
  try {
    address = resolveDashboardAddress(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.fatal(error.message);
      process.exit(1);
    }
    throw error;
  }

  const dbPath = process.env.ORCHESTRATOR_DB_PATH ?? resolveDefaultDbPath(process.env);
  const assetsDir = resolveAssetsDir();
  if (assetsDir === null) {
    logger.warn('frontend assets not found — serving the build hint at / (run `npm run build:web`)');
  }

  const handle = await startDashboard({
    bind: address.bind,
    port: address.port,
    assetsDir,
    snapshot: () =>
      readSnapshot({
        dbPath,
        now: () => new Date().toISOString(),
        daemonUnitState: async () => (await unitActiveState(execFileRunner, 'orchestrator')).state,
        // One `orca repo list` per poll; when Orca is down the batch helper
        // degrades to unlinked rows, never to a failed snapshot.
        linkIssues: (rows) => safeRegistryIssueUrls(execFileRunner, logger, rows),
      }),
  });
  logger.info(
    { bind: address.bind, port: handle.port, dbPath, assetsDir },
    'dashboard sidecar listening — read-only, localhost-bound unless DASHBOARD_BIND says otherwise',
  );
}

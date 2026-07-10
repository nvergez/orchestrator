/**
 * Boot-time Orca reachability probe (spec §10). User units cannot order
 * against the Orca system unit, so at boot Orca may legitimately be down:
 * one read-only CLI call, outcome logged, never blocking and never fatal.
 */

import { execFileRunner, listRegistryRepos, type CommandRunner } from './orca.ts';

/** What the reporter needs from a pino logger — kept minimal for the tests. */
export interface HealthLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export type HealthReport =
  | { status: 'reachable'; repoCount: number }
  | { status: 'unreachable'; reason: string };

export async function probeOrca(run: CommandRunner): Promise<HealthReport> {
  try {
    const repos = await listRegistryRepos(run);
    return { status: 'reachable', repoCount: repos.length };
  } catch (error) {
    return { status: 'unreachable', reason: describeFailure(error) };
  }
}

/**
 * Fire the probe and log its outcome. Callers `void` the returned promise —
 * startup never waits on it — and it cannot reject: probeOrca funnels every
 * failure into an `unreachable` report.
 */
export async function reportOrcaHealth(
  logger: HealthLogger,
  run: CommandRunner = execFileRunner,
): Promise<void> {
  try {
    const report = await probeOrca(run);
    if (report.status === 'reachable') {
      logger.info({ repoCount: report.repoCount }, 'boot healthcheck: Orca runtime reachable');
    } else {
      logger.warn({ reason: report.reason }, 'boot healthcheck: Orca runtime unavailable');
    }
  } catch {
    // Even a throwing logger must not become an unhandled rejection — the
    // healthcheck is strictly best-effort, and there is nothing left to log with.
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'orca CLI not found on PATH';
    }
    return error.message;
  }
  return String(error);
}

/**
 * Boot-time Orca reachability probe (spec §10). User units cannot order
 * against the Orca system unit, so at boot Orca may legitimately be down:
 * one read-only CLI call, outcome logged, never blocking and never fatal.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Command-runner seam: resolves with stdout, rejects like execFile does. */
export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

/** What the reporter needs from a pino logger — kept minimal for the tests. */
export interface HealthLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/** A probe that hangs must not linger forever; generous, since nothing waits on it. */
export const ORCA_PROBE_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

export const execFileRunner: CommandRunner = (command, args) =>
  execFileAsync(command, args, { timeout: ORCA_PROBE_TIMEOUT_MS });

export type HealthReport =
  | { status: 'reachable'; repoCount: number }
  | { status: 'unreachable'; reason: string };

export async function probeOrca(run: CommandRunner): Promise<HealthReport> {
  try {
    const { stdout } = await run('orca', ['repo', 'list', '--json']);
    const envelope = JSON.parse(stdout) as { result: { repos: unknown[] } };
    return { status: 'reachable', repoCount: envelope.result.repos.length };
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
  const report = await probeOrca(run);
  if (report.status === 'reachable') {
    logger.info({ repoCount: report.repoCount }, 'boot healthcheck: Orca runtime reachable');
  } else {
    logger.warn({ reason: report.reason }, 'boot healthcheck: Orca runtime unavailable');
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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The one seam to the orca CLI's read surface: the promisified runner and the
 * `repo list` decoder, shared by the boot healthcheck (orca-health.ts) and
 * the routing allow-list (routing.ts). Spec §10: every orca call is wrapped —
 * callers turn a throw into a log line or a fail-closed denial, never a crash.
 */

/** Command-runner seam: resolves with stdout, rejects like execFile does. */
export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

/** One orca call must hang neither the boot probe nor a suspended tool call. */
const ORCA_CLI_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

export const execFileRunner: CommandRunner = (command, args) =>
  execFileAsync(command, args, { timeout: ORCA_CLI_TIMEOUT_MS });

export interface RegistryRepo {
  id: string;
  /** The registry `displayName` — what a routing-hints entry's `name` pins. */
  name: string;
}

/** `orca repo list --json` → the living registry. Throws when Orca is down. */
export async function listRegistryRepos(run: CommandRunner): Promise<RegistryRepo[]> {
  const { stdout } = await run('orca', ['repo', 'list', '--json']);
  const envelope = JSON.parse(stdout) as { ok?: boolean; result?: { repos?: unknown } };
  const repos = envelope.result?.repos;
  if (envelope.ok !== true || !Array.isArray(repos)) {
    throw new Error('unexpected `orca repo list` response shape');
  }
  // An entry without id or displayName cannot be matched — dropping it only
  // narrows the delegable surface, which is the fail-closed direction.
  return repos.flatMap((repo: unknown) => {
    const record = repo as { id?: unknown; displayName?: unknown };
    return typeof record.id === 'string' && typeof record.displayName === 'string'
      ? [{ id: record.id, name: record.displayName }]
      : [];
  });
}

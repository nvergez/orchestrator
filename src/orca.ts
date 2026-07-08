import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The one seam to the orca CLI: the promisified runner, the `--json`
 * envelope decoder, and the daemon-side calls — `repo list` for the boot
 * healthcheck (orca-health.ts) and the routing allow-list (routing.ts),
 * terminal list/create for the delegation coordinator's mailboxes
 * (dispatch.ts). Spec §10: every orca call is wrapped — callers turn a
 * throw into a log line or a fail-closed denial, never a crash.
 */

/** Command-runner seam: resolves with stdout, rejects like execFile does. */
export type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

/** One orca call must hang neither the boot probe nor a suspended tool call. */
const ORCA_CLI_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

/** A runner with its own deadline — the gate watcher's blocking `check
 * --wait` child needs its window plus grace, not the default 10s. */
export function makeExecFileRunner(timeoutMs: number): CommandRunner {
  return (command, args) => execFileAsync(command, args, { timeout: timeoutMs });
}

export const execFileRunner: CommandRunner = makeExecFileRunner(ORCA_CLI_TIMEOUT_MS);

export interface RegistryRepo {
  id: string;
  /** The registry `displayName` — what a routing-hints entry's `name` pins. */
  name: string;
  /** `github.com/<owner>/<repo>` — absent on folder repos with no remote. */
  canonicalKey?: string;
}

/**
 * The orca CLI `--json` envelope: the `result` object iff `ok` is true,
 * null for anything else — an error blob, a compound command's mixed
 * output, or plain non-JSON.
 */
export function parseOrcaEnvelope(stdout: string): Record<string, unknown> | null {
  try {
    const envelope = JSON.parse(stdout.trim()) as { ok?: unknown; result?: unknown };
    if (envelope.ok === true && typeof envelope.result === 'object' && envelope.result !== null) {
      return envelope.result as Record<string, unknown>;
    }
  } catch {
    // fall through to null
  }
  return null;
}

/** `orca repo list --json` → the living registry. Throws when Orca is down. */
export async function listRegistryRepos(run: CommandRunner): Promise<RegistryRepo[]> {
  const { stdout } = await run('orca', ['repo', 'list', '--json']);
  const repos = parseOrcaEnvelope(stdout)?.repos;
  if (!Array.isArray(repos)) {
    throw new Error('unexpected `orca repo list` response shape');
  }
  // An entry without id or displayName cannot be matched — dropping it only
  // narrows the delegable surface, which is the fail-closed direction.
  return repos.flatMap((repo: unknown) => {
    const record = repo as {
      id?: unknown;
      displayName?: unknown;
      gitRemoteIdentity?: { canonicalKey?: unknown };
    };
    if (typeof record.id !== 'string' || typeof record.displayName !== 'string') return [];
    const canonicalKey = record.gitRemoteIdentity?.canonicalKey;
    return [
      {
        id: record.id,
        name: record.displayName,
        ...(typeof canonicalKey === 'string' && { canonicalKey }),
      },
    ];
  });
}

/**
 * One orchestration task as `task-list --json` reports it. Statuses observed
 * on the live runtime: `pending`, `ready`, `dispatched`, `completed`,
 * `failed` — boot reconciliation (issue #25) only distinguishes the two
 * terminal ones and treats everything else as "not finished yet".
 */
export interface OrchestrationTask {
  id: string;
  status: string;
}

/** `orca orchestration task-list --json` → every task on the runtime bus. */
export async function listOrchestrationTasks(run: CommandRunner): Promise<OrchestrationTask[]> {
  const { stdout } = await run('orca', ['orchestration', 'task-list', '--json']);
  const tasks = parseOrcaEnvelope(stdout)?.tasks;
  if (!Array.isArray(tasks)) {
    throw new Error('unexpected `orca orchestration task-list` response shape');
  }
  return tasks.flatMap((task: unknown) => {
    const record = task as { id?: unknown; status?: unknown };
    if (typeof record.id !== 'string' || typeof record.status !== 'string') return [];
    return [{ id: record.id, status: record.status }];
  });
}

/** One worktree's live state as `worktree ps --json` reports it (issue #25). */
export interface WorktreeProcess {
  /** `repoId::path[::workspace:<n>]` — the same id family `worktree create` issues. */
  worktreeId: string;
  path: string;
  isArchived: boolean;
  liveTerminalCount: number;
  /** Epoch ms of the last terminal output — the "last sign"; null when unknown. */
  lastOutputAt: number | null;
}

/** `orca worktree ps --json` → every worktree's liveness. Throws when Orca is down. */
export async function listWorktreeProcesses(run: CommandRunner): Promise<WorktreeProcess[]> {
  const { stdout } = await run('orca', ['worktree', 'ps', '--json']);
  const worktrees = parseOrcaEnvelope(stdout)?.worktrees;
  if (!Array.isArray(worktrees)) {
    throw new Error('unexpected `orca worktree ps` response shape');
  }
  // Absent liveness fields degrade to "no signs of life" — reconciliation
  // then reports a stall instead of inventing activity it never observed.
  return worktrees.flatMap((worktree: unknown) => {
    const record = worktree as {
      worktreeId?: unknown;
      path?: unknown;
      isArchived?: unknown;
      liveTerminalCount?: unknown;
      lastOutputAt?: unknown;
    };
    if (typeof record.worktreeId !== 'string' || typeof record.path !== 'string') return [];
    return [
      {
        worktreeId: record.worktreeId,
        path: record.path,
        isArchived: record.isArchived === true,
        liveTerminalCount:
          typeof record.liveTerminalCount === 'number' ? record.liveTerminalCount : 0,
        lastOutputAt:
          typeof record.lastOutputAt === 'number' && record.lastOutputAt > 0
            ? record.lastOutputAt
            : null,
      },
    ];
  });
}

/** Every live terminal handle on the runtime. Throws when Orca is down. */
export async function listLiveTerminalHandles(run: CommandRunner): Promise<Set<string>> {
  const { stdout } = await run('orca', ['terminal', 'list', '--json']);
  const terminals = parseOrcaEnvelope(stdout)?.terminals;
  if (!Array.isArray(terminals)) {
    throw new Error('unexpected `orca terminal list` response shape');
  }
  return new Set(
    terminals.flatMap((terminal: unknown) => {
      const handle = (terminal as { handle?: unknown }).handle;
      return typeof handle === 'string' ? [handle] : [];
    }),
  );
}

/** Creates a titled terminal in a worktree; resolves with its runtime handle. */
export async function createTerminal(
  run: CommandRunner,
  opts: { worktreePath: string; title: string },
): Promise<string> {
  const { stdout } = await run('orca', [
    'terminal',
    'create',
    '--worktree',
    `path:${opts.worktreePath}`,
    '--title',
    opts.title,
    '--json',
  ]);
  const terminal = parseOrcaEnvelope(stdout)?.terminal as { handle?: unknown } | undefined;
  if (typeof terminal?.handle !== 'string') {
    throw new Error('unexpected `orca terminal create` response shape');
  }
  return terminal.handle;
}

import { accessSync, constants, existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { ConfigError, loadConfig } from './config.ts';
import { execFileRunner, type CommandRunner } from './orca.ts';
import { probeOrca } from './orca-health.ts';
import { readPackageMeta } from './pkg.ts';
import { loadRoutingHints, RoutingHintsError, type RepoHint } from './routing.ts';
import { systemdUnitPath } from './service.ts';
import { resolveDefaultDbPath, resolveRoutingHintsPath } from './xdg.ts';

/**
 * `orc doctor` (issue #70 + #74 addendum): read-only diagnosis of the
 * install — env vars, routing hints, state dir, node version, Orca
 * reachability, and (only once the unit is installed) unit enablement and
 * linger, so doctor stays green through the pre-install phase of the
 * golden path. Non-zero exit on any failure. Nothing here writes.
 */

export interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  env: Record<string, string | undefined>;
  /** The orca probe's runner — doctor reuses the boot healthcheck. */
  runOrca: CommandRunner;
  /** systemctl / loginctl runner for the unit + linger checks. */
  runSystem: CommandRunner;
  nodeVersion: string;
  enginesNode: string | undefined;
  fileExists(path: string): boolean;
  dirWritable(dir: string): boolean;
  loadHints(path: string): RepoHint[];
  username: string;
  unitPath: string;
}

export function realDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    runOrca: execFileRunner,
    runSystem: execFileRunner,
    nodeVersion: process.versions.node,
    enginesNode: readPackageMeta().enginesNode,
    fileExists: existsSync,
    dirWritable: nearestAncestorWritable,
    loadHints: loadRoutingHints,
    username: userInfo().username,
    unitPath: systemdUnitPath(),
  };
}

/**
 * Read-only writability probe: the state dir may not exist yet (the DB
 * layer mkdirs at boot), so walk up to the deepest existing ancestor —
 * whether THAT is writable decides whether the mkdir would succeed.
 */
export function nearestAncestorWritable(dir: string): boolean {
  let current = dir;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    accessSync(current, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `>=X.Y(.Z)` minimum out of an engines range, null if unparseable. */
function minimumFromEngines(range: string | undefined): string | null {
  const match = /^>=\s*(\d+(?:\.\d+){0,2})/.exec(range ?? '');
  return match?.[1] ?? null;
}

function versionAtLeast(version: string, minimum: string): boolean {
  const have = version.split('.').map(Number);
  const need = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export async function runDoctorChecks(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  try {
    loadConfig(deps.env);
    checks.push({ label: 'env', ok: true, detail: 'required variables present with the right prefixes' });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    checks.push({ label: 'env', ok: false, detail: error.message });
  }

  const hintsPath = resolveRoutingHintsPath(deps.env);
  try {
    const hints = deps.loadHints(hintsPath);
    checks.push({
      label: 'routing hints',
      ok: true,
      detail: `${hints.length} repo${hints.length === 1 ? '' : 's'} at ${hintsPath}`,
    });
  } catch (error) {
    if (!(error instanceof RoutingHintsError)) throw error;
    checks.push({ label: 'routing hints', ok: false, detail: error.message });
  }

  const dbPath = deps.env.ORCHESTRATOR_DB_PATH ?? resolveDefaultDbPath(deps.env);
  const stateDir = dirname(dbPath);
  checks.push(
    deps.dirWritable(stateDir)
      ? { label: 'state dir', ok: true, detail: `${stateDir} is writable` }
      : { label: 'state dir', ok: false, detail: `${stateDir} is not writable` },
  );

  const minimum = minimumFromEngines(deps.enginesNode);
  if (minimum === null) {
    checks.push({ label: 'node', ok: true, detail: `running ${deps.nodeVersion} (no engines minimum declared)` });
  } else {
    checks.push(
      versionAtLeast(deps.nodeVersion, minimum)
        ? { label: 'node', ok: true, detail: `${deps.nodeVersion} satisfies >=${minimum}` }
        : { label: 'node', ok: false, detail: `${deps.nodeVersion} is below the required >=${minimum}` },
    );
  }

  // Reuses the boot healthcheck: one read-only `orca repo list` probe covers
  // both "orca on PATH" (ENOENT reads as such) and "runtime reachable".
  const report = await probeOrca(deps.runOrca);
  checks.push(
    report.status === 'reachable'
      ? { label: 'orca', ok: true, detail: `runtime reachable — ${report.repoCount} registered repo${report.repoCount === 1 ? '' : 's'}` }
      : { label: 'orca', ok: false, detail: report.reason },
  );

  // #74 addendum: unit + linger are failures ONLY when the unit is installed.
  if (!deps.fileExists(deps.unitPath)) {
    checks.push({
      label: 'service',
      ok: true,
      detail: 'unit not installed — run `orc service install` when ready',
    });
    return checks;
  }
  try {
    const { stdout } = await deps.runSystem('systemctl', ['--user', 'is-enabled', 'orchestrator']);
    const state = stdout.trim();
    checks.push(
      state === 'enabled'
        ? { label: 'service', ok: true, detail: `unit installed and enabled (${deps.unitPath})` }
        : { label: 'service', ok: false, detail: `unit installed but "${state}" — re-run \`orc service install\`` },
    );
  } catch {
    checks.push({
      label: 'service',
      ok: false,
      detail: 'unit installed but not enabled — re-run `orc service install`',
    });
  }
  try {
    const { stdout } = await deps.runSystem('loginctl', ['show-user', deps.username, '--property=Linger']);
    checks.push(
      stdout.trim() === 'Linger=yes'
        ? { label: 'linger', ok: true, detail: 'on — the service survives logout and starts at boot' }
        : {
            label: 'linger',
            ok: false,
            detail: `off — the service dies at logout and skips boots; enable with: sudo loginctl enable-linger ${deps.username}`,
          },
    );
  } catch {
    checks.push({
      label: 'linger',
      ok: false,
      detail: `could not determine — check: loginctl show-user ${deps.username} --property=Linger`,
    });
  }
  return checks;
}

export interface DoctorIo {
  out(line: string): void;
  err(line: string): void;
}

export async function runDoctor(deps: DoctorDeps, io: DoctorIo): Promise<number> {
  const checks = await runDoctorChecks(deps);
  for (const check of checks) {
    io.out(`${check.ok ? '✔' : '✖'} ${check.label}: ${check.detail}`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  if (failed > 0) {
    io.err(`${failed} check${failed === 1 ? '' : 's'} failed`);
    return 1;
  }
  io.out('all checks passed');
  return 0;
}

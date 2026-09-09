import { imageAttachmentsEnabled, slackIdentity, userNamesEnabled } from '../kernel/slack.ts';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { ConfigError, loadConfig, resolveDashboardAddress } from '../kernel/config.ts';
import { parseEnvFile } from '../kernel/env-file.ts';
import { execFileRunner, type CommandRunner } from '../kernel/orca.ts';
import { probeOrca } from '../kernel/orca-health.ts';
import { describeMailboxHome, MailboxHomeError, resolveMailboxHome } from '../kernel/mailbox-home.ts';
import { readPackageMeta } from './pkg.ts';
import { loadRoutingHints, RoutingHintsError, type RepoHint } from '../kernel/routing.ts';
import { loadPersona, PersonaError } from '../kernel/persona.ts';
import { unitActiveState, userBusFixLine, userBusUnreachable } from '../kernel/systemd.ts';
import { dashboardUnitPath, systemdUnitPath } from './service.ts';
import {
  resolveDefaultDbPath,
  resolveEnvFilePath,
  resolvePersonaPath,
  resolveRoutingHintsPath,
} from '../kernel/xdg.ts';

/**
 * `orc doctor` (issue #70 + #74 addendum): read-only diagnosis of the
 * install — env vars, routing hints, the optional persona, state dir,
 * node version, Orca reachability, and (only once the unit is installed)
 * unit enablement, the unit's pinned ExecStart paths, and linger, so
 * doctor stays green through the pre-install phase of the golden path.
 * Non-zero exit on any failure. Nothing here writes.
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
  /** The daemon's working directory — a mailbox-home candidate (ADR 0007). */
  cwd: string;
  /** systemctl / loginctl runner for the unit + linger checks. */
  runSystem: CommandRunner;
  nodeVersion: string;
  enginesNode: string | undefined;
  fileExists(path: string): boolean;
  /** Reads the canonical env file for the doctor-only fallback — throws like readFileSync. */
  readFile(path: string): string;
  dirWritable(dir: string): boolean;
  loadHints(path: string): RepoHint[];
  /** The operator's voice file; `undefined` means none configured. */
  loadPersona(path: string): string | undefined;
  username: string;
  uid: number;
  unitPath: string;
  dashboardUnitPath: string;
  /** Slack identity check, including granted scopes from its response headers. */
  slackAuth(token: string): Promise<{ scopes: string[] }>;
  /** GET a local URL — the dashboard port probe. Rejects like fetch does. */
  httpGet(url: string): Promise<{ status: number }>;
}

export function realDoctorDeps(): DoctorDeps {
  return {
    env: process.env,
    runOrca: execFileRunner,
    cwd: process.cwd(),
    runSystem: execFileRunner,
    nodeVersion: process.versions.node,
    enginesNode: readPackageMeta().enginesNode,
    fileExists: existsSync,
    readFile: (path) => readFileSync(path, 'utf8'),
    dirWritable: nearestAncestorWritable,
    loadHints: loadRoutingHints,
    loadPersona,
    username: userInfo().username,
    uid: userInfo().uid,
    unitPath: systemdUnitPath(),
    dashboardUnitPath: dashboardUnitPath(),
    slackAuth: slackIdentity,
    httpGet: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      return { status: response.status };
    },
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

/**
 * The env check validates process.env first (what a systemd-launched daemon
 * sees), and only when that fails falls back to the canonical env file — a
 * bare shell has none of the vars exported, yet the install can be perfect.
 * The file wins over process.env in the fallback, mirroring EnvironmentFile.
 */
function checkEnv(deps: DoctorDeps): DoctorCheck & { token?: string } {
  const present = (source: string, token: string): DoctorCheck & { token: string } => ({
    token,
    label: 'env',
    ok: true,
    detail: `required variables present with the right prefixes (from ${source})`,
  });
  let processEnvError: ConfigError;
  try {
    const config = loadConfig(deps.env);
    return present('process.env', config.slackBotToken);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    processEnvError = error;
  }
  const envFilePath = resolveEnvFilePath(deps.env);
  let fileVars: Record<string, string>;
  try {
    fileVars = parseEnvFile(deps.readFile(envFilePath));
  } catch {
    return {
      label: 'env',
      ok: false,
      detail: `${processEnvError.message} (checked process.env; ${envFilePath} is missing — run \`orc init\`)`,
    };
  }
  try {
    const config = loadConfig({ ...deps.env, ...fileVars });
    return present(envFilePath, config.slackBotToken);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return {
      label: 'env',
      ok: false,
      detail: `${error.message} (checked process.env and ${envFilePath})`,
    };
  }
}

/**
 * Where the thread mailboxes would be created (ADR 0007) — the same
 * resolution the daemon runs at its first mailbox, so a packaged install
 * whose cwd is no checkout learns here, not at the first delegation, that
 * its default repo's checkout hosts them (or that nothing does).
 * `ORCHESTRATOR_MAILBOX_WORKTREE` is read like the env check reads: from
 * process.env, else from the canonical env file.
 */
async function checkMailboxHome(deps: DoctorDeps, hints: RepoHint[]): Promise<DoctorCheck> {
  const configured = deps.env.ORCHESTRATOR_MAILBOX_WORKTREE ?? envFileValue(deps, 'ORCHESTRATOR_MAILBOX_WORKTREE');
  const defaultRepo = hints.find((hint) => hint.default)?.name;
  try {
    const home = await resolveMailboxHome(deps.runOrca, {
      ...(configured !== undefined && configured !== '' && { configured }),
      cwd: deps.cwd,
      ...(defaultRepo !== undefined && { defaultRepo }),
    });
    return { label: 'mailbox home', ok: true, detail: describeMailboxHome(home) };
  } catch (error) {
    if (error instanceof MailboxHomeError) return { label: 'mailbox home', ok: false, detail: error.message };
    return {
      label: 'mailbox home',
      ok: false,
      detail: `could not ask Orca for the mailbox worktree — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** One variable off the canonical env file, undefined when the file is absent. */
function envFileValue(deps: DoctorDeps, key: string): string | undefined {
  try {
    return parseEnvFile(deps.readFile(resolveEnvFilePath(deps.env)))[key];
  } catch {
    return undefined;
  }
}

/** What both unit checks say when systemd itself could not be asked. */
function busUnreachableDetail(deps: DoctorDeps, unitPath: string): string {
  return (
    `unit file present (${unitPath}) but cannot reach the user service manager — ` +
    `${userBusFixLine(deps.uid)}`
  );
}

/** The `>=X.Y(.Z)` minimum out of an engines range, null if unparseable. */
function minimumFromEngines(range: string | undefined): string | null {
  const match = /^>=\s*(\d+(?:\.\d+){0,2})/.exec(range ?? '');
  return match?.[1] ?? null;
}

/**
 * The generated unit pins absolute paths (node binary + entry point); a
 * node/nvm upgrade leaves them dangling while the in-memory daemon keeps
 * running — invisible until the next restart fails. `orc update` is a no-op
 * at latest, so this is the only place the rot gets diagnosed.
 */
function checkUnitPaths(deps: DoctorDeps): DoctorCheck {
  let content: string;
  try {
    content = deps.readFile(deps.unitPath);
  } catch {
    return { label: 'unit paths', ok: false, detail: `could not read ${deps.unitPath}` };
  }
  const execStart = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('ExecStart='));
  if (execStart === undefined) {
    return {
      label: 'unit paths',
      ok: false,
      detail: `no ExecStart in ${deps.unitPath} — re-run \`orc service install\``,
    };
  }
  const missing = execStart
    .slice('ExecStart='.length)
    .trim()
    .split(/\s+/)
    .filter((path) => !deps.fileExists(path));
  return missing.length === 0
    ? { label: 'unit paths', ok: true, detail: 'ExecStart paths exist (node binary + entry point)' }
    : {
        label: 'unit paths',
        ok: false,
        detail:
          `ExecStart points at missing ${missing.join(', ')} — stale after a node upgrade? ` +
          're-run `orc service install`, then restart',
      };
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

  const { token, ...envCheck } = checkEnv(deps);
  checks.push(envCheck);
  let imageDetail = 'unknown — configure the bot token first';
  let namesDetail = 'unknown — configure the bot token first';
  if (token) {
    try {
      const { scopes } = await deps.slackAuth(token);
      imageDetail = imageAttachmentsEnabled(scopes) ? 'enabled' : 'disabled — bot token lacks files:read';
      namesDetail = userNamesEnabled(scopes) ? 'enabled' : 'disabled — bot token lacks users:read';
    } catch {
      imageDetail = 'unknown — Slack identity check failed';
      namesDetail = 'unknown — Slack identity check failed';
    }
  }
  checks.push({ label: 'image attachments', ok: true, detail: imageDetail });
  checks.push({ label: 'user names', ok: true, detail: namesDetail });

  const hintsPath = resolveRoutingHintsPath(deps.env);
  let hints: RepoHint[] | undefined;
  try {
    hints = deps.loadHints(hintsPath);
    checks.push({
      label: 'routing hints',
      ok: true,
      detail: `${hints.length} repo${hints.length === 1 ? '' : 's'} at ${hintsPath}; default repo: ${hints.find((hint) => hint.default)?.name ?? (hints.length === 1 ? hints[0]!.name : 'not configured')}`,
    });
  } catch (error) {
    if (!(error instanceof RoutingHintsError)) throw error;
    checks.push({ label: 'routing hints', ok: false, detail: error.message });
  }

  // Optional (persona.ts): none is a normal, green install — the check is
  // here so a persona that IS configured proves it is being read.
  const personaPath = resolvePersonaPath(deps.env);
  try {
    const persona = deps.loadPersona(personaPath);
    checks.push({
      label: 'persona',
      ok: true,
      detail:
        persona === undefined
          ? `none at ${personaPath} — stock voice (optional)`
          : `${persona.length} characters at ${personaPath}`,
    });
  } catch (error) {
    if (!(error instanceof PersonaError)) throw error;
    checks.push({ label: 'persona', ok: false, detail: error.message });
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
  // Only askable while Orca answers and the hints loaded — an unreachable
  // runtime or a broken hints file is already the failure above, not a
  // second one about the mailbox home.
  if (report.status === 'reachable' && hints !== undefined) checks.push(await checkMailboxHome(deps, hints));

  // #74 addendum: unit, dashboard + linger are failures ONLY once installed.
  if (!deps.fileExists(deps.unitPath)) {
    checks.push({
      label: 'service',
      ok: true,
      detail: 'unit not installed — run `orc service install` when ready',
    });
  } else {
    try {
      const { stdout } = await deps.runSystem('systemctl', ['--user', 'is-enabled', 'orchestrator']);
      const state = stdout.trim();
      checks.push(
        state === 'enabled'
          ? { label: 'service', ok: true, detail: `unit installed and enabled (${deps.unitPath})` }
          : { label: 'service', ok: false, detail: `unit installed but "${state}" — re-run \`orc service install\`` },
      );
    } catch (error) {
      checks.push(
        userBusUnreachable(error)
          ? { label: 'service', ok: false, detail: busUnreachableDetail(deps, deps.unitPath) }
          : {
              label: 'service',
              ok: false,
              detail: 'unit installed but not enabled — re-run `orc service install`',
            },
      );
    }
    checks.push(checkUnitPaths(deps));
  }

  checks.push(...(await checkDashboard(deps)));

  if (!deps.fileExists(deps.unitPath) && !deps.fileExists(deps.dashboardUnitPath)) {
    return checks;
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

/**
 * The dashboard sidecar's health (issue #87), gated like the daemon's unit
 * check: not installed is a fact, not a failure. Once installed, two
 * questions — is the unit active, and does the port actually answer? The
 * probe address mirrors EnvironmentFile: env-file values win over the
 * shell's, and a non-local DASHBOARD_BIND is probed where it points.
 */
async function checkDashboard(deps: DoctorDeps): Promise<DoctorCheck[]> {
  if (!deps.fileExists(deps.dashboardUnitPath)) {
    return [
      {
        label: 'dashboard',
        ok: true,
        detail: 'unit not installed — `orc service install` installs it alongside the daemon',
      },
    ];
  }

  const checks: DoctorCheck[] = [];
  const { state, busUnreachable } = await unitActiveState(deps.runSystem, 'orchestrator-dashboard');
  if (state === 'active') {
    checks.push({ label: 'dashboard', ok: true, detail: `unit active (${deps.dashboardUnitPath})` });
  } else if (busUnreachable) {
    checks.push({
      label: 'dashboard',
      ok: false,
      detail: busUnreachableDetail(deps, deps.dashboardUnitPath),
    });
  } else {
    checks.push({
      label: 'dashboard',
      ok: false,
      detail: `unit installed but "${state}" — check: journalctl --user -u orchestrator-dashboard -e`,
    });
  }

  let url: string;
  try {
    const fileVars = readEnvFileVars(deps);
    const { bind, port } = resolveDashboardAddress({ ...deps.env, ...fileVars });
    const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
    url = `http://${host}:${port}/api/state`;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    checks.push({ label: 'dashboard http', ok: false, detail: error.message });
    return checks;
  }
  try {
    const { status } = await deps.httpGet(url);
    checks.push(
      status === 200
        ? { label: 'dashboard http', ok: true, detail: `answering at ${url}` }
        : { label: 'dashboard http', ok: false, detail: `${url} answered HTTP ${status}` },
    );
  } catch {
    checks.push({
      label: 'dashboard http',
      ok: false,
      detail: `nothing answering at ${url} — check: journalctl --user -u orchestrator-dashboard -e`,
    });
  }
  return checks;
}

/** The canonical env file's variables; a missing file simply adds nothing. */
function readEnvFileVars(deps: DoctorDeps): Record<string, string> {
  try {
    return parseEnvFile(deps.readFile(resolveEnvFilePath(deps.env)));
  } catch {
    return {};
  }
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

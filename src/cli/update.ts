import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeExecFileRunner, type CommandRunner } from '../kernel/orca.ts';
import { probeUserBus, userBusFixLine } from '../kernel/systemd.ts';
import { readPackageMeta } from './pkg.ts';
import { systemdUnitPath } from './service.ts';

/**
 * `orc update`: the whole documented update ritual as one command — registry
 * check, `npm install -g`, unit regeneration, service restart. It only
 * manages the install method it owns (a global npm install; dev checkouts
 * use git), a no-op at latest never touches the service, and a breaking
 * (major) release is refused until re-run with `--yes`. After the install
 * step the old in-memory code only orchestrates — the freshly installed
 * binary regenerates the unit (docs/adr/0001).
 */

/** npm talks to the network and installs; systemctl waits for a stop — none fit the 10s orca deadline. */
const UPDATE_STEP_TIMEOUT_MS = 300_000;

export interface UpdateDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  packageName: string;
  installedVersion: string;
  /** Shown when a breaking release is gated — absent only if package.json lost its repository URL. */
  releasesUrl: string | undefined;
  /** Captured-output runner: `npm root -g`, `npm view`, `systemctl restart`. */
  run: CommandRunner;
  /** Inherited-stdio runner for the steps whose output the user must see (`npm install -g`, the new binary's `service install`) — resolves with the exit code. */
  runVisible: (command: string, args: string[]) => Promise<number>;
  /** Realpath of this running package's root — where its package.json lives. */
  packageRoot: () => string;
  /** Realpath of `path`, null when it does not exist. */
  realpath: (path: string) => string | null;
  /** Whether `path` is itself a symlink (an `npm link`ed checkout), null when missing. */
  isSymlink: (path: string) => boolean | null;
  fileExists: (path: string) => boolean;
  unitPath: string;
  /** Names this user's runtime dir in the unreachable-bus fix line. */
  uid: number;
  /** The running node — interpreter for the freshly installed entry point. */
  execPath: string;
}

export function realUpdateDeps(): UpdateDeps {
  const meta = readPackageMeta();
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    packageName: meta.name,
    installedVersion: meta.version,
    releasesUrl: meta.releasesUrl,
    run: makeExecFileRunner(UPDATE_STEP_TIMEOUT_MS),
    runVisible: (command, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit' });
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 1));
      }),
    packageRoot: () => realpathSync(fileURLToPath(new URL('../..', import.meta.url))),
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return null;
      }
    },
    isSymlink: (path) => {
      try {
        return lstatSync(path).isSymbolicLink();
      } catch {
        return null;
      }
    },
    fileExists: existsSync,
    unitPath: systemdUnitPath(),
    uid: userInfo().uid,
    execPath: process.execPath,
  };
}

/** Strict x.y.z triple; dist-tags.latest under this repo's release pipeline is never a prerelease. */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function runUpdate(deps: UpdateDeps, opts: { yes: boolean }): Promise<number> {
  // Precondition: this process must BE the global npm install — update never
  // touches a dev checkout (git's job) or an `npm link` (a checkout in disguise).
  let globalRoot: string;
  try {
    const { stdout } = await deps.run('npm', ['root', '-g']);
    globalRoot = stdout.trim();
  } catch (error) {
    deps.err(`✖ could not run \`npm root -g\`: ${String(error)}`);
    return 1;
  }
  const installDir = join(globalRoot, deps.packageName);
  if (deps.isSymlink(installDir) === true) {
    deps.err(
      `✖ ${installDir} is an npm link to a checkout — update only manages global npm ` +
        'installs; update your checkout with git instead',
    );
    return 1;
  }
  const runningRoot = deps.packageRoot();
  if (deps.realpath(installDir) !== runningRoot) {
    deps.err(
      `✖ this orc is not the global npm install (running from ${runningRoot}) — update ` +
        'only manages global npm installs; dev checkouts use git',
    );
    return 1;
  }

  let latest: string;
  try {
    const { stdout } = await deps.run('npm', ['view', deps.packageName, 'dist-tags.latest']);
    latest = stdout.trim();
  } catch (error) {
    deps.err(`✖ could not query the npm registry for ${deps.packageName}: ${String(error)}`);
    return 1;
  }
  const installed = parseVersion(deps.installedVersion);
  const next = parseVersion(latest);
  if (installed === null || next === null) {
    deps.err(`✖ unparseable version — installed "${deps.installedVersion}", registry latest "${latest}"`);
    return 1;
  }
  const direction = compareVersions(next, installed);
  if (direction === 0) {
    deps.out(`already up to date (${deps.installedVersion})`);
    return 0;
  }
  if (direction < 0) {
    deps.out(
      `installed ${deps.installedVersion} is ahead of the registry (latest ${latest}) — nothing to do`,
    );
    return 0;
  }

  if (next[0] > installed[0] && !opts.yes) {
    deps.err(`✖ ${latest} is a breaking release (${deps.installedVersion} → ${latest} crosses a major)`);
    if (deps.releasesUrl !== undefined) deps.err(`  read the release notes first: ${deps.releasesUrl}`);
    deps.err('  then re-run as: orc update --yes');
    return 1;
  }

  // The update is one indivisible ritual (CONTEXT.md, "Update"), so the last
  // thing that can refuse it must refuse BEFORE npm swaps the code (issue #91):
  // a run that cannot reach the user bus regenerates no unit and restarts no
  // service, and would otherwise leave the new version installed while the old
  // one keeps running under stale units. Only the installed-unit case cares —
  // a package-only update never touches systemd.
  if (deps.fileExists(deps.unitPath)) {
    const bus = await probeUserBus(deps.run);
    if (bus === 'unreachable') {
      deps.err(
        `✖ cannot reach the systemd user bus from this shell — nothing was installed. ` +
          `${userBusFixLine(deps.uid)}, then re-run \`orc update\``,
      );
      return 1;
    }
    if (bus === 'absent') {
      deps.err(
        `✖ systemd user manager unreachable — nothing was installed. ${deps.unitPath} exists ` +
          'but cannot be regenerated or restarted from here; update under the supervisor that runs `orc`',
      );
      return 1;
    }
  }

  deps.out(`updating ${deps.installedVersion} → ${latest}`);
  let installExit: number;
  try {
    installExit = await deps.runVisible('npm', ['install', '-g', `${deps.packageName}@${latest}`]);
  } catch (error) {
    deps.err(`✖ could not spawn npm: ${String(error)}`);
    return 1;
  }
  if (installExit !== 0) {
    deps.err(`✖ npm install -g ${deps.packageName}@${latest} exited ${installExit} — nothing was restarted; re-run \`orc update\``);
    return installExit;
  }

  if (!deps.fileExists(deps.unitPath)) {
    deps.out(`✔ updated ${deps.installedVersion} → ${latest} (package only)`);
    deps.out('⚠ no systemd unit installed — restart your daemon by hand to pick up the new version');
    return 0;
  }

  // docs/adr/0001: from here the old code only orchestrates — the unit must
  // be generated by the version that will run under it.
  const newEntry = join(installDir, 'dist', 'index.js');
  let serviceExit: number;
  try {
    serviceExit = await deps.runVisible(deps.execPath, [newEntry, 'service', 'install']);
  } catch (error) {
    deps.err(`✖ could not spawn the freshly installed orc (${newEntry}): ${String(error)}`);
    return 1;
  }
  if (serviceExit !== 0) {
    deps.err(
      `✖ the new version's \`orc service install\` exited ${serviceExit} — fix it, then ` +
        'run `orc service install && systemctl --user restart orchestrator` yourself',
    );
    return serviceExit;
  }

  try {
    // Both units in one restart (issue #87): the update ritual is indivisible,
    // so daemon and dashboard versions never skew.
    await deps.run('systemctl', ['--user', 'restart', 'orchestrator', 'orchestrator-dashboard']);
  } catch (error) {
    deps.err(
      '✖ restart failed — the OLD code is still running; run ' +
        `\`systemctl --user restart orchestrator orchestrator-dashboard\` yourself: ${String(error)}`,
    );
    return 1;
  }

  deps.out(`✔ updated ${deps.installedVersion} → ${latest} — units regenerated, services restarted`);
  deps.out('  run `orc doctor` to verify');
  return 0;
}

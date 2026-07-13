import { describe, expect, it } from 'vitest';
import { runUpdate, type UpdateDeps } from './update.ts';

const GLOBAL_ROOT = '/usr/lib/node_modules';
const PKG = '@nvergez/orchestrator';
const INSTALL_DIR = `${GLOBAL_ROOT}/${PKG}`;
const UNIT_PATH = '/home/op/.config/systemd/user/orchestrator.service';
const RELEASES_URL = 'https://github.com/nvergez/orchestrator/releases';

interface Harness {
  deps: UpdateDeps;
  out: string[];
  err: string[];
  /** Every run/runVisible invocation, flattened to [command, ...args]. */
  calls: string[][];
}

const makeDeps = (latest = '0.1.1'): Harness => {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const deps: UpdateDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    packageName: PKG,
    installedVersion: '0.1.0',
    releasesUrl: RELEASES_URL,
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === 'npm' && args[0] === 'root') return Promise.resolve({ stdout: `${GLOBAL_ROOT}\n` });
      if (command === 'npm' && args[0] === 'view') return Promise.resolve({ stdout: `${latest}\n` });
      if (command === 'systemctl') return Promise.resolve({ stdout: '' });
      return Promise.reject(new Error(`unexpected run: ${command} ${args.join(' ')}`));
    },
    runVisible: (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve(0);
    },
    packageRoot: () => INSTALL_DIR,
    realpath: (path) => (path === INSTALL_DIR ? INSTALL_DIR : null),
    isSymlink: (path) => (path === INSTALL_DIR ? false : null),
    fileExists: () => true,
    unitPath: UNIT_PATH,
    uid: 1000,
    execPath: '/usr/bin/node',
  };
  return { deps, out, err, calls };
};

/** Did the service actually get touched? The read-only bus probe does not count. */
const restarted = (calls: string[][]): boolean =>
  calls.some((call) => call[0] === 'systemctl' && call.includes('restart'));

/**
 * A runner whose `show-environment` preflight fails — with `stderr` for the
 * unreachable-bus case, bare for the no-systemd case — and answers the npm
 * probes normally, so the refusal is the only thing under test.
 */
const failShowEnvironment =
  (calls: string[][], failure: { stderr?: string }): UpdateDeps['run'] =>
  (command, args) => {
    calls.push([command, ...args]);
    if (command === 'npm' && args[0] === 'root') return Promise.resolve({ stdout: `${GLOBAL_ROOT}\n` });
    if (command === 'npm' && args[0] === 'view') return Promise.resolve({ stdout: '0.1.1\n' });
    return Promise.reject(Object.assign(new Error('systemctl failed'), failure));
  };

describe('runUpdate', () => {
  it('runs the whole ritual in order: view, install, NEW binary service install, restart', async () => {
    const { deps, out, calls } = makeDeps('0.1.1');
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(0);
    expect(calls).toEqual([
      ['npm', 'root', '-g'],
      ['npm', 'view', PKG, 'dist-tags.latest'],
      // Issue #91: the bus preflight comes BEFORE npm — a doomed ritual must
      // refuse while the install is still untouched.
      ['systemctl', '--user', 'show-environment'],
      ['npm', 'install', '-g', `${PKG}@0.1.1`],
      // ADR-0001: the freshly installed entry point regenerates the unit, not
      // the old in-memory code.
      ['/usr/bin/node', `${INSTALL_DIR}/dist/index.js`, 'service', 'install'],
      // Both units restart in the same indivisible ritual (issue #87) —
      // daemon and dashboard versions never skew.
      ['systemctl', '--user', 'restart', 'orchestrator', 'orchestrator-dashboard'],
    ]);
    expect(out).toContain('updating 0.1.0 → 0.1.1');
    expect(out).toContain('✔ updated 0.1.0 → 0.1.1 — units regenerated, services restarted');
    expect(out.at(-1)).toContain('orc doctor');
  });

  it('is a pure no-op at latest — exit 0, service untouched', async () => {
    const { deps, out, calls } = makeDeps('0.1.0');
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(0);
    expect(out).toEqual(['already up to date (0.1.0)']);
    expect(calls.some((call) => call[1] === 'install' || call[0] === 'systemctl')).toBe(false);
  });

  it('is a no-op when the install is ahead of the registry', async () => {
    const { deps, out } = makeDeps('0.0.9');
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(0);
    expect(out).toEqual(['installed 0.1.0 is ahead of the registry (latest 0.0.9) — nothing to do']);
  });

  it('refuses a major jump without --yes, pointing at the release notes', async () => {
    const { deps, err, calls } = makeDeps('1.0.0');
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('breaking release');
    expect(err.join('\n')).toContain(RELEASES_URL);
    expect(err.join('\n')).toContain('orc update --yes');
    expect(calls.some((call) => call[1] === 'install')).toBe(false);
  });

  it('applies a major jump with --yes', async () => {
    const { deps, out } = makeDeps('1.0.0');
    await expect(runUpdate(deps, { yes: true })).resolves.toBe(0);
    expect(out).toContain('✔ updated 0.1.0 → 1.0.0 — units regenerated, services restarted');
  });

  it('refuses when this orc is not the global npm install (dev checkout)', async () => {
    const { deps, err, calls } = makeDeps();
    deps.packageRoot = () => '/home/op/checkouts/orchestrator';
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('not the global npm install');
    expect(err[0]).toContain('/home/op/checkouts/orchestrator');
    expect(calls).toEqual([['npm', 'root', '-g']]);
  });

  it('refuses an npm-linked checkout even though its realpath matches', async () => {
    const { deps, err } = makeDeps();
    deps.isSymlink = () => true;
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('npm link');
  });

  it('refuses when the package is missing from the global root', async () => {
    const { deps, err } = makeDeps();
    deps.realpath = () => null;
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('not the global npm install');
  });

  it('skips the service steps loudly when no unit is installed', async () => {
    const { deps, out, calls } = makeDeps('0.1.1');
    deps.fileExists = () => false;
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(0);
    expect(calls.at(-1)).toEqual(['npm', 'install', '-g', `${PKG}@0.1.1`]);
    expect(out).toContain('✔ updated 0.1.0 → 0.1.1 (package only)');
    expect(out.at(-1)).toContain('restart your daemon by hand');
  });

  // Issue #91: npm install -g used to run first, so an unreachable bus left the
  // new version on disk while the OLD code kept running under stale units.
  it('refuses an unreachable user bus BEFORE npm installs anything, with the export fix', async () => {
    const { deps, err, calls } = makeDeps('0.1.1');
    deps.run = failShowEnvironment(calls, {
      stderr: 'Failed to connect to bus: No medium found\n',
    });

    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err.join('\n')).toContain('export XDG_RUNTIME_DIR=/run/user/1000');
    expect(err.join('\n')).toContain('nothing was installed');
    expect(err.join('\n')).toContain('re-run `orc update`');
    expect(calls.some((call) => call[1] === 'install')).toBe(false);
    expect(calls.at(-1)).toEqual(['systemctl', '--user', 'show-environment']);
  });

  it('refuses before npm when the unit exists but systemd itself cannot be asked', async () => {
    const { deps, err, calls } = makeDeps('0.1.1');
    deps.run = failShowEnvironment(calls, {});

    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err.join('\n')).toContain('systemd user manager unreachable');
    expect(err.join('\n')).toContain('nothing was installed');
    expect(calls.some((call) => call[1] === 'install')).toBe(false);
  });

  it('never probes the bus for a package-only update — no unit, no systemd', async () => {
    const { deps, calls } = makeDeps('0.1.1');
    deps.fileExists = () => false;
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(0);
    expect(calls.some((call) => call[0] === 'systemctl')).toBe(false);
  });

  it('propagates an npm install failure without touching the service', async () => {
    const { deps, err, calls } = makeDeps('0.1.1');
    deps.runVisible = (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve(command === 'npm' ? 7 : 0);
    };
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(7);
    expect(err[0]).toContain('nothing was restarted');
    expect(restarted(calls)).toBe(false);
    expect(calls.some((call) => call[2] === 'service')).toBe(false);
  });

  it('propagates a failure of the new binary’s service install, skipping the restart', async () => {
    const { deps, err, calls } = makeDeps('0.1.1');
    deps.runVisible = (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve(command === '/usr/bin/node' ? 1 : 0);
    };
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('`orc service install` exited 1');
    expect(restarted(calls)).toBe(false);
  });

  it('fails loudly when the restart fails — the old code is still running', async () => {
    const { deps, err } = makeDeps('0.1.1');
    const run = deps.run;
    // Only the restart fails: the preflight bus probe answers, so the ritual
    // gets all the way to the step that leaves the old code running.
    deps.run = (command, args) =>
      command === 'systemctl' && args.includes('restart')
        ? Promise.reject(new Error('bus down'))
        : run(command, args);
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('OLD code is still running');
  });

  it('fails when the registry is unreachable', async () => {
    const { deps, err } = makeDeps();
    const run = deps.run;
    deps.run = (command, args) =>
      args[0] === 'view' ? Promise.reject(new Error('ETIMEDOUT')) : run(command, args);
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('npm registry');
  });

  it('fails when npm itself cannot run', async () => {
    const { deps, err } = makeDeps();
    deps.run = () => Promise.reject(new Error('spawn npm ENOENT'));
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('npm root -g');
  });

  it('fails on an unparseable registry version instead of guessing', async () => {
    const { deps, err } = makeDeps('not-a-version');
    await expect(runUpdate(deps, { yes: false })).resolves.toBe(1);
    expect(err[0]).toContain('unparseable version');
  });
});

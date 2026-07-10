import { describe, expect, it } from 'vitest';
import { parseEnvFile, runDoctor, runDoctorChecks, type DoctorDeps } from './doctor.ts';
import { RoutingHintsError, type RepoHint } from './routing.ts';

const UNIT_PATH = '/home/op/.config/systemd/user/orchestrator.service';

const validEnv = {
  SLACK_BOT_TOKEN: 'xoxb-1111-2222-abc',
  SLACK_APP_TOKEN: 'xapp-1-A111-222-abc',
  SLACK_CHANNEL_ID: 'C0EXAMPLE123',
  SLACK_ALLOWED_USER_ID: 'U0EXAMPLE456',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc123',
};

const hint = (name: string): RepoHint => ({
  name,
  description: `${name} description.`,
  aliases: [],
  keywords: [],
});

/** The orca CLI `repo list --json` success envelope, two repos. */
const registryStdout = JSON.stringify({
  id: 'call-1',
  ok: true,
  result: { repos: [{ id: 'u1', displayName: 'webapp' }, { id: 'u2', displayName: 'sandbox' }] },
});

const ENV_FILE_PATH = '/home/op/.config/orchestrator/env';

/** ENOENT-style rejection — the doctor env fallback must survive a missing file. */
const noEnvFile = (): never => {
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${ENV_FILE_PATH}'`), {
    code: 'ENOENT',
  });
};

const NODE_PATH = '/usr/bin/node';
const ENTRY_PATH = '/usr/lib/node_modules/@nvergez/orchestrator/dist/index.js';

const UNIT_CONTENT = ['[Service]', `ExecStart=${NODE_PATH} ${ENTRY_PATH}`, ''].join('\n');

/** readFile serves the unit for the unit-paths check, everything else goes to the env-file impl. */
const readFiles =
  (envImpl: (path: string) => string): DoctorDeps['readFile'] =>
  (path) =>
    path === UNIT_PATH ? UNIT_CONTENT : envImpl(path);

const envFileContent = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

const greenDeps = (): DoctorDeps => ({
  env: { ...validEnv, XDG_CONFIG_HOME: '/home/op/.config' },
  runOrca: () => Promise.resolve({ stdout: registryStdout }),
  runSystem: (command) =>
    Promise.resolve({ stdout: command === 'loginctl' ? 'Linger=yes\n' : 'enabled\n' }),
  nodeVersion: '22.18.0',
  enginesNode: '>=22.18',
  fileExists: () => true,
  readFile: readFiles(noEnvFile),
  dirWritable: () => true,
  loadHints: () => [hint('webapp'), hint('sandbox')],
  username: 'op',
  uid: 1000,
  unitPath: UNIT_PATH,
});

const failures = (checks: { label: string; ok: boolean }[]): string[] =>
  checks.filter((check) => !check.ok).map((check) => check.label);

describe('runDoctorChecks', () => {
  it('passes across the board on a healthy, service-installed box', async () => {
    const checks = await runDoctorChecks(greenDeps());
    expect(failures(checks)).toEqual([]);
    expect(checks.map((check) => check.label)).toEqual([
      'env',
      'routing hints',
      'state dir',
      'node',
      'orca',
      'service',
      'unit paths',
      'linger',
    ]);
  });

  it('reports the repo count and the resolved hints path', async () => {
    const deps = greenDeps();
    deps.env.ORCHESTRATOR_ROUTING_HINTS_PATH = '/srv/hints.json';
    const checks = await runDoctorChecks(deps);
    const hints = checks.find((check) => check.label === 'routing hints');
    expect(hints?.detail).toBe('2 repos at /srv/hints.json');
  });

  it('passes env from process.env without touching the env file, naming the source', async () => {
    const deps = greenDeps();
    deps.readFile = readFiles(() => {
      throw new Error('must not be read when process.env validates');
    });
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
    expect(checks.find((check) => check.label === 'env')?.detail).toBe(
      'required variables present with the right prefixes (from process.env)',
    );
  });

  it('falls back to the canonical env file when process.env lacks the variables', async () => {
    const deps = greenDeps();
    deps.env = { XDG_CONFIG_HOME: '/home/op/.config' };
    const readPaths: string[] = [];
    deps.readFile = readFiles((path) => {
      readPaths.push(path);
      return envFileContent(validEnv);
    });
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
    expect(readPaths).toEqual([ENV_FILE_PATH]);
    expect(checks.find((check) => check.label === 'env')?.detail).toBe(
      `required variables present with the right prefixes (from ${ENV_FILE_PATH})`,
    );
  });

  it('parses template-style env files: comments, blanks, export, quotes', async () => {
    const deps = greenDeps();
    deps.env = { XDG_CONFIG_HOME: '/home/op/.config' };
    deps.readFile = readFiles(() =>
      [
        '# Bot User OAuth Token — starts with xoxb-',
        `SLACK_BOT_TOKEN="${validEnv.SLACK_BOT_TOKEN}"`,
        '',
        `export SLACK_APP_TOKEN='${validEnv.SLACK_APP_TOKEN}'`,
        `SLACK_CHANNEL_ID=${validEnv.SLACK_CHANNEL_ID}`,
        `SLACK_ALLOWED_USER_ID=${validEnv.SLACK_ALLOWED_USER_ID}`,
        `CLAUDE_CODE_OAUTH_TOKEN=${validEnv.CLAUDE_CODE_OAUTH_TOKEN}`,
        '#LOG_LEVEL=info',
      ].join('\n'),
    );
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
  });

  it('applies the same prefix rules to env-file values, naming both sources', async () => {
    const deps = greenDeps();
    deps.env = { XDG_CONFIG_HOME: '/home/op/.config' };
    deps.readFile = readFiles(() => envFileContent({ ...validEnv, SLACK_BOT_TOKEN: 'not-a-bot-token' }));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['env']);
    const detail = checks.find((check) => check.label === 'env')?.detail;
    expect(detail).toContain('SLACK_BOT_TOKEN must start with "xoxb-"');
    expect(detail).toContain(`checked process.env and ${ENV_FILE_PATH}`);
  });

  it('env-file values win over mis-prefixed process.env ones, like EnvironmentFile', async () => {
    const deps = greenDeps();
    deps.env = { ...validEnv, XDG_CONFIG_HOME: '/home/op/.config', SLACK_BOT_TOKEN: 'not-a-bot-token' };
    deps.readFile = readFiles(() => envFileContent({ SLACK_BOT_TOKEN: validEnv.SLACK_BOT_TOKEN }));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
    expect(checks.find((check) => check.label === 'env')?.detail).toContain(
      `from ${ENV_FILE_PATH}`,
    );
  });

  it('fails env listing both consulted sources when the env file is missing too', async () => {
    const deps = greenDeps();
    deps.env = { XDG_CONFIG_HOME: '/home/op/.config' };
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['env']);
    const detail = checks.find((check) => check.label === 'env')?.detail;
    expect(detail).toContain('SLACK_BOT_TOKEN is missing');
    expect(detail).toContain(`${ENV_FILE_PATH} is missing`);
    expect(detail).toContain('orc init');
  });

  it('fails routing hints when the file is missing or malformed', async () => {
    const deps = greenDeps();
    deps.loadHints = () => {
      throw new RoutingHintsError('routing hints not found at /x — run `orc init` …');
    };
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['routing hints']);
  });

  it('fails when the state dir is not writable', async () => {
    const deps = greenDeps();
    deps.dirWritable = () => false;
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['state dir']);
  });

  it('checks the state dir of an ORCHESTRATOR_DB_PATH override, not the default', async () => {
    const deps = greenDeps();
    deps.env.ORCHESTRATOR_DB_PATH = '/srv/db/orchestrator.db';
    const seen: string[] = [];
    deps.dirWritable = (dir) => {
      seen.push(dir);
      return true;
    };
    await runDoctorChecks(deps);
    expect(seen).toEqual(['/srv/db']);
  });

  it('fails node when the running version is below the engines floor', async () => {
    const deps = greenDeps();
    deps.nodeVersion = '20.11.0';
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['node']);
    expect(checks.find((check) => check.label === 'node')?.detail).toContain('>=22.18');
  });

  it('passes node at exactly the floor', async () => {
    const deps = greenDeps();
    deps.nodeVersion = '22.18.0';
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
  });

  it('fails orca when the probe cannot reach the runtime', async () => {
    const deps = greenDeps();
    deps.runOrca = () => Promise.reject(Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' }));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['orca']);
    expect(checks.find((check) => check.label === 'orca')?.detail).toContain('PATH');
  });

  it('skips unit + linger entirely while the unit is not installed (#74 addendum)', async () => {
    const deps = greenDeps();
    deps.fileExists = () => false;
    deps.runSystem = () => Promise.reject(new Error('must not be called'));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
    const service = checks.find((check) => check.label === 'service');
    expect(service?.detail).toContain('orc service install');
    expect(checks.some((check) => check.label === 'linger')).toBe(false);
  });

  it('fails service when the unit is installed but not enabled', async () => {
    const deps = greenDeps();
    deps.runSystem = (command) =>
      command === 'systemctl'
        ? Promise.reject(Object.assign(new Error('exit 1'), { stdout: 'disabled\n', stderr: '' }))
        : Promise.resolve({ stdout: 'Linger=yes\n' });
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['service']);
    expect(checks.find((check) => check.label === 'service')?.detail).toContain(
      'not enabled — re-run `orc service install`',
    );
  });

  it('reports an unreachable user bus distinctly, never claiming the unit is disabled', async () => {
    const deps = greenDeps();
    deps.runSystem = (command) =>
      command === 'systemctl'
        ? Promise.reject(
            Object.assign(new Error('exit 1'), {
              stderr: 'Failed to connect to user scope bus via local transport: No medium found\n',
            }),
          )
        : Promise.resolve({ stdout: 'Linger=yes\n' });
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['service']);
    const detail = checks.find((check) => check.label === 'service')?.detail;
    expect(detail).toContain('cannot reach the user service manager');
    expect(detail).toContain('export XDG_RUNTIME_DIR=/run/user/1000');
    expect(detail).toContain(`unit file present (${UNIT_PATH})`);
    expect(detail).not.toContain('enabled');
  });

  it('fails unit paths when a pinned ExecStart path is dangling (node/nvm upgrade)', async () => {
    const deps = greenDeps();
    deps.fileExists = (path) => path !== NODE_PATH;
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['unit paths']);
    const detail = checks.find((check) => check.label === 'unit paths')?.detail;
    expect(detail).toContain(NODE_PATH);
    expect(detail).not.toContain(ENTRY_PATH);
    expect(detail).toContain('orc service install');
  });

  it('fails unit paths when the unit has no ExecStart line at all', async () => {
    const deps = greenDeps();
    deps.readFile = (path) => (path === UNIT_PATH ? '[Service]\n' : noEnvFile());
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['unit paths']);
    expect(checks.find((check) => check.label === 'unit paths')?.detail).toContain('no ExecStart');
  });

  it('fails linger when the unit is installed and linger is off, with the one-liner', async () => {
    const deps = greenDeps();
    deps.runSystem = (command) =>
      Promise.resolve({ stdout: command === 'loginctl' ? 'Linger=no\n' : 'enabled\n' });
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['linger']);
    expect(checks.find((check) => check.label === 'linger')?.detail).toContain(
      'sudo loginctl enable-linger op',
    );
  });
});

describe('parseEnvFile', () => {
  it('keeps an empty value empty, so `KEY=` still reads as missing', () => {
    expect(parseEnvFile('SLACK_BOT_TOKEN=\n')).toEqual({ SLACK_BOT_TOKEN: '' });
  });

  it('ignores lines without an equals sign', () => {
    expect(parseEnvFile('garbage line\nKEY=value\n')).toEqual({ KEY: 'value' });
  });

  it('does not strip mismatched quotes', () => {
    expect(parseEnvFile(`KEY="value'`)).toEqual({ KEY: `"value'` });
  });
});

describe('runDoctor', () => {
  const collect = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
  };

  it('exits 0 and prints one ✔ line per check when everything passes', async () => {
    const { io, out } = collect();
    await expect(runDoctor(greenDeps(), io)).resolves.toBe(0);
    expect(out.filter((line) => line.startsWith('✔'))).toHaveLength(8);
    expect(out.at(-1)).toBe('all checks passed');
  });

  it('exits non-zero on any failure, tallying it on stderr', async () => {
    const deps = greenDeps();
    deps.dirWritable = () => false;
    const { io, out, err } = collect();
    await expect(runDoctor(deps, io)).resolves.toBe(1);
    expect(out.some((line) => line.startsWith('✖ state dir:'))).toBe(true);
    expect(err).toEqual(['1 check failed']);
  });
});

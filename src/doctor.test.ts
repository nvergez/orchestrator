import { describe, expect, it } from 'vitest';
import { runDoctor, runDoctorChecks, type DoctorDeps } from './doctor.ts';
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

const greenDeps = (): DoctorDeps => ({
  env: { ...validEnv },
  runOrca: () => Promise.resolve({ stdout: registryStdout }),
  runSystem: (command) =>
    Promise.resolve({ stdout: command === 'loginctl' ? 'Linger=yes\n' : 'enabled\n' }),
  nodeVersion: '22.18.0',
  enginesNode: '>=22.18',
  fileExists: () => true,
  dirWritable: () => true,
  loadHints: () => [hint('webapp'), hint('sandbox')],
  username: 'op',
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

  it('fails env when required variables are missing or mis-prefixed', async () => {
    const deps = greenDeps();
    deps.env = { ...validEnv, SLACK_BOT_TOKEN: 'not-a-bot-token' };
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['env']);
    expect(checks.find((check) => check.label === 'env')?.detail).toContain('SLACK_BOT_TOKEN');
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
        ? Promise.reject(new Error('disabled'))
        : Promise.resolve({ stdout: 'Linger=yes\n' });
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['service']);
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

describe('runDoctor', () => {
  const collect = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) }, out, err };
  };

  it('exits 0 and prints one ✔ line per check when everything passes', async () => {
    const { io, out } = collect();
    await expect(runDoctor(greenDeps(), io)).resolves.toBe(0);
    expect(out.filter((line) => line.startsWith('✔'))).toHaveLength(7);
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

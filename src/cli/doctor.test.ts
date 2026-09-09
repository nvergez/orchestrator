import { slackIdentity } from '../kernel/slack.ts';
import { describe, expect, it, vi } from 'vitest';
import { runDoctor, runDoctorChecks, type DoctorDeps } from './doctor.ts';
import { RoutingHintsError, type RepoHint } from '../kernel/routing.ts';
import { PersonaError, WORKER_PERSONA_MAX_CHARS } from '../kernel/persona.ts';

const UNIT_PATH = '/home/op/.config/systemd/user/orchestrator.service';
const DASHBOARD_UNIT_PATH = '/home/op/.config/systemd/user/orchestrator-dashboard.service';

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
  default: name === 'webapp',
});

const WEBAPP_CHECKOUT = '/home/op/projects/webapp';

/** The orca CLI `repo list --json` success envelope, two repos. */
const registryStdout = JSON.stringify({
  id: 'call-1',
  ok: true,
  result: {
    repos: [
      { id: 'u1', displayName: 'webapp', path: WEBAPP_CHECKOUT },
      { id: 'u2', displayName: 'sandbox', path: '/home/op/projects/sandbox' },
    ],
  },
});

/** `worktree show --worktree path:<p>`: the registered checkouts resolve, anything else is `selector_not_found`. */
const worktreeShow = (args: string[]): Promise<{ stdout: string }> => {
  const path = (args[args.indexOf('--worktree') + 1] ?? '').replace(/^path:/, '');
  if (path === WEBAPP_CHECKOUT || path === '/home/op/projects/sandbox') {
    return Promise.resolve({ stdout: JSON.stringify({ id: 'w', ok: true, result: { worktree: { id: `u::${path}`, path } } }) });
  }
  return Promise.reject(
    Object.assign(new Error('Command failed: orca worktree show'), {
      code: 1,
      stdout: JSON.stringify({ id: 'w', ok: false, error: { code: 'selector_not_found', message: 'selector_not_found' } }),
    }),
  );
};

/** The healthy orca runner: the registry, plus the worktree lookup behind the mailbox-home check. */
const greenRunOrca: DoctorDeps['runOrca'] = (_command, args) =>
  args[0] === 'worktree' && args[1] === 'show' ? worktreeShow(args) : Promise.resolve({ stdout: registryStdout });

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

/** Answers is-enabled/is-active/loginctl the way a healthy box does. */
const greenRunSystem: DoctorDeps['runSystem'] = (command, args) => {
  if (command === 'loginctl') return Promise.resolve({ stdout: 'Linger=yes\n' });
  if (args.includes('is-active')) return Promise.resolve({ stdout: 'active\n' });
  return Promise.resolve({ stdout: 'enabled\n' });
};

const greenDeps = (): DoctorDeps => ({
  env: { ...validEnv, XDG_CONFIG_HOME: '/home/op/.config' },
  runOrca: greenRunOrca,
  cwd: '/home/op',
  runSystem: greenRunSystem,
  nodeVersion: '22.18.0',
  enginesNode: '>=22.18',
  fileExists: () => true,
  readFile: readFiles(noEnvFile),
  dirWritable: () => true,
  loadHints: () => [hint('webapp'), hint('sandbox')],
  loadPersona: () => undefined,
  username: 'op',
  uid: 1000,
  unitPath: UNIT_PATH,
  dashboardUnitPath: DASHBOARD_UNIT_PATH,
  slackAuth: () => Promise.resolve({ scopes: ['files:read'] }),
  httpGet: () => Promise.resolve({ status: 200 }),
});

const failures = (checks: { label: string; ok: boolean }[]): string[] =>
  checks.filter((check) => !check.ok).map((check) => check.label);

describe('runDoctorChecks', () => {
  it.each([
    [['files:read', 'chat:write'], 'enabled'],
    [['chat:write'], 'disabled — bot token lacks files:read'],
  ])('reports image attachment availability without failing the check: %s', async (scopes, detail) => {
    const deps = greenDeps();
    deps.slackAuth = () => Promise.resolve({ scopes });
    const checks = await runDoctorChecks(deps);
    expect(checks.find((check) => check.label === 'image attachments')).toEqual({ label: 'image attachments', ok: true, detail });
    expect(failures(checks)).toEqual([]);
  });

  it.each([
    [['users:read', 'chat:write'], 'enabled'],
    [['chat:write'], 'disabled — bot token lacks users:read'],
  ])('reports user-name availability without failing the check: %s', async (scopes, detail) => {
    const deps = greenDeps();
    deps.slackAuth = () => Promise.resolve({ scopes });
    const checks = await runDoctorChecks(deps);
    expect(checks.find((check) => check.label === 'user names')).toEqual({ label: 'user names', ok: true, detail });
    expect(failures(checks)).toEqual([]);
  });

  it('reads granted scopes from the identity response header using the configured env-file token', async () => {
    const deps = greenDeps();
    deps.env = { XDG_CONFIG_HOME: '/home/op/.config' };
    deps.readFile = readFiles(() => envFileContent(validEnv));
    deps.slackAuth = slackIdentity;
    const request = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { headers: { 'x-oauth-scopes': 'chat:write, files:read' } })));
    vi.stubGlobal('fetch', request);
    try {
      const checks = await runDoctorChecks(deps);
      expect(checks.find((check) => check.label === 'image attachments')?.detail).toBe('enabled');
      expect(request).toHaveBeenCalledWith('https://slack.com/api/auth.test', expect.objectContaining({ headers: { Authorization: `Bearer ${validEnv.SLACK_BOT_TOKEN}` } }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a Slack identity failure as informational without failing other checks', async () => {
    const deps = greenDeps();
    deps.slackAuth = () => Promise.reject(new Error('offline'));
    const checks = await runDoctorChecks(deps);
    expect(checks.find((check) => check.label === 'image attachments')).toEqual({ label: 'image attachments', ok: true, detail: 'unknown — Slack identity check failed' });
    expect(checks.find((check) => check.label === 'user names')).toEqual({ label: 'user names', ok: true, detail: 'unknown — Slack identity check failed' });
    expect(failures(checks)).toEqual([]);
  });

  it('passes across the board on a healthy, service-installed box', async () => {
    const checks = await runDoctorChecks(greenDeps());
    expect(failures(checks)).toEqual([]);
    expect(checks.map((check) => check.label)).toEqual([
      'env',
      'image attachments',
      'user names',
      'routing hints',
      'persona',
      'worker persona',
      'state dir',
      'node',
      'orca',
      'mailbox home',
      'service',
      'unit paths',
      'dashboard',
      'dashboard http',
      'linger',
    ]);
  });

  it('names the mailbox home — the default repo checkout when the cwd is no worktree (ADR 0007)', async () => {
    const checks = await runDoctorChecks(greenDeps());
    expect(checks.find((check) => check.label === 'mailbox home')).toEqual({
      label: 'mailbox home',
      ok: true,
      detail: `${WEBAPP_CHECKOUT} (default repo "webapp" checkout)`,
    });
  });

  it('prefers a checkout cwd, then an explicit ORCHESTRATOR_MAILBOX_WORKTREE — read from the env file too', async () => {
    const fromCwd = greenDeps();
    fromCwd.cwd = '/home/op/projects/sandbox';
    expect((await runDoctorChecks(fromCwd)).find((check) => check.label === 'mailbox home')?.detail).toBe(
      "/home/op/projects/sandbox (the daemon's working directory)",
    );

    const fromFile = greenDeps();
    fromFile.env = { XDG_CONFIG_HOME: '/home/op/.config' };
    fromFile.readFile = readFiles(() =>
      envFileContent({ ...validEnv, ORCHESTRATOR_MAILBOX_WORKTREE: '/home/op/projects/sandbox' }),
    );
    const checks = await runDoctorChecks(fromFile);
    expect(failures(checks)).toEqual([]);
    expect(checks.find((check) => check.label === 'mailbox home')?.detail).toBe(
      '/home/op/projects/sandbox (ORCHESTRATOR_MAILBOX_WORKTREE)',
    );
  });

  it('fails the mailbox home when the configured worktree is unknown to Orca, or nothing hosts it', async () => {
    const misconfigured = greenDeps();
    misconfigured.env.ORCHESTRATOR_MAILBOX_WORKTREE = '/srv/nowhere';
    const configuredChecks = await runDoctorChecks(misconfigured);
    expect(failures(configuredChecks)).toEqual(['mailbox home']);
    expect(configuredChecks.find((check) => check.label === 'mailbox home')?.detail).toContain('/srv/nowhere is not a worktree Orca lists');

    const homeless = greenDeps();
    homeless.loadHints = () => [];
    const homelessChecks = await runDoctorChecks(homeless);
    expect(homelessChecks.find((check) => check.label === 'mailbox home')).toMatchObject({ ok: false });
    expect(homelessChecks.find((check) => check.label === 'mailbox home')?.detail).toContain('ORCHESTRATOR_MAILBOX_WORKTREE');
  });

  it('reports the repo count and the resolved hints path', async () => {
    const deps = greenDeps();
    deps.env.ORCHESTRATOR_ROUTING_HINTS_PATH = '/srv/hints.json';
    const checks = await runDoctorChecks(deps);
    const hints = checks.find((check) => check.label === 'routing hints');
    expect(hints?.detail).toBe('2 repos at /srv/hints.json; default repo: webapp');
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
    // Consulted by the env fallback, by the mailbox-home check and again by
    // the dashboard port probe — never anything but the canonical file.
    expect(readPaths).toEqual([ENV_FILE_PATH, ENV_FILE_PATH, ENV_FILE_PATH]);
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

  it('reports the persona: none by default, its size once configured', async () => {
    const deps = greenDeps();
    deps.env.ORCHESTRATOR_PERSONA_PATH = '/srv/persona.md';
    const none = await runDoctorChecks(deps);
    expect(none.find((check) => check.label === 'persona')?.detail).toBe(
      'none at /srv/persona.md — stock voice (optional)',
    );
    expect(failures(none)).toEqual([]);

    deps.loadPersona = () => 'Write like me.';
    const configured = await runDoctorChecks(deps);
    expect(configured.find((check) => check.label === 'persona')?.detail).toBe(
      '14 characters at /srv/persona.md',
    );
  });

  it('reports the worker register and the cap it is read under', async () => {
    const deps = greenDeps();
    deps.env.ORCHESTRATOR_WORKER_PERSONA_PATH = '/srv/workers.md';
    const caps: Array<number | undefined> = [];
    deps.loadPersona = (_path, maxChars) => {
      caps.push(maxChars);
      return maxChars === undefined ? undefined : 'direct, minuscules';
    };
    const checks = await runDoctorChecks(deps);
    expect(checks.find((check) => check.label === 'worker persona')?.detail).toBe(
      '18 characters at /srv/workers.md, in every brief',
    );
    expect(caps).toEqual([undefined, WORKER_PERSONA_MAX_CHARS]);
  });

  it.each([
    ['persona.md', 'persona'],
    ['persona-workers.md', 'worker persona'],
  ])('fails only the %s check when that file cannot be honored', async (file, label) => {
    const deps = greenDeps();
    deps.loadPersona = (path) => {
      if (!path.endsWith(file)) return undefined;
      throw new PersonaError(`/x/${file}: the persona is 9001 characters, over the cap …`);
    };
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([label]);
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

  it('skips unit, dashboard + linger entirely while nothing is installed (#74 addendum)', async () => {
    const deps = greenDeps();
    deps.fileExists = () => false;
    deps.runSystem = () => Promise.reject(new Error('must not be called'));
    deps.httpGet = () => Promise.reject(new Error('must not be probed'));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
    const service = checks.find((check) => check.label === 'service');
    expect(service?.detail).toContain('orc service install');
    expect(checks.find((check) => check.label === 'dashboard')?.detail).toContain(
      'orc service install',
    );
    expect(checks.some((check) => check.label === 'dashboard http')).toBe(false);
    expect(checks.some((check) => check.label === 'linger')).toBe(false);
  });

  it('fails service when the unit is installed but not enabled', async () => {
    const deps = greenDeps();
    deps.runSystem = (command, args) =>
      command === 'systemctl' && args.includes('is-enabled')
        ? Promise.reject(Object.assign(new Error('exit 1'), { stdout: 'disabled\n', stderr: '' }))
        : greenRunSystem(command, args);
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
    expect(failures(checks)).toEqual(['service', 'dashboard']);
    const detail = checks.find((check) => check.label === 'service')?.detail;
    expect(detail).toContain('cannot reach the user service manager');
    expect(detail).toContain('export XDG_RUNTIME_DIR=/run/user/1000');
    expect(detail).toContain(`unit file present (${UNIT_PATH})`);
    expect(detail).not.toContain('enabled');
    // The dashboard unit-state check degrades the same honest way.
    expect(checks.find((check) => check.label === 'dashboard')?.detail).toContain(
      'cannot reach the user service manager',
    );
  });

  it('fails dashboard when its unit is installed but not active (issue #87)', async () => {
    const deps = greenDeps();
    deps.runSystem = (command, args) =>
      command === 'systemctl' && args.includes('is-active')
        ? Promise.reject(Object.assign(new Error('exit 3'), { stdout: 'failed\n', stderr: '' }))
        : greenRunSystem(command, args);
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['dashboard']);
    const detail = checks.find((check) => check.label === 'dashboard')?.detail;
    expect(detail).toContain('"failed"');
    expect(detail).toContain('journalctl --user -u orchestrator-dashboard');
  });

  it('fails dashboard http when nothing answers on the port', async () => {
    const deps = greenDeps();
    deps.httpGet = () => Promise.reject(new Error('ECONNREFUSED'));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['dashboard http']);
    const detail = checks.find((check) => check.label === 'dashboard http')?.detail;
    expect(detail).toContain('http://127.0.0.1:8787/api/state');
    expect(detail).toContain('journalctl --user -u orchestrator-dashboard');
  });

  it('probes the address the canonical env file configures, like EnvironmentFile would', async () => {
    const deps = greenDeps();
    deps.readFile = readFiles(() => envFileContent({ DASHBOARD_PORT: '9000' }));
    const probed: string[] = [];
    deps.httpGet = (url) => {
      probed.push(url);
      return Promise.resolve({ status: 200 });
    };
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual([]);
    expect(probed).toEqual(['http://127.0.0.1:9000/api/state']);
  });

  it('fails dashboard http on a malformed DASHBOARD_PORT instead of probing a guess', async () => {
    const deps = greenDeps();
    deps.env.DASHBOARD_PORT = 'http';
    deps.httpGet = () => Promise.reject(new Error('must not be probed'));
    const checks = await runDoctorChecks(deps);
    expect(failures(checks)).toEqual(['dashboard http']);
    expect(checks.find((check) => check.label === 'dashboard http')?.detail).toContain(
      'DASHBOARD_PORT',
    );
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
    deps.runSystem = (command, args) =>
      command === 'loginctl'
        ? Promise.resolve({ stdout: 'Linger=no\n' })
        : greenRunSystem(command, args);
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
    expect(out.filter((line) => line.startsWith('✔'))).toHaveLength(15);
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

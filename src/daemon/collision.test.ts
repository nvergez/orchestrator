import { describe, expect, it } from 'vitest';
import { serviceCollision, type CollisionDeps } from './collision.ts';

/**
 * The dev-instance collision guard (ADR 0003). The fakes stand where
 * systemctl and the canonical env file stand: XDG vars pin the resolved
 * paths so the assertions never depend on the runner's real home.
 */

const SERVICE_ENV_FILE = 'SLACK_APP_TOKEN=xapp-1-SERVICE\n';

const deps = (overrides: Partial<CollisionDeps> = {}): CollisionDeps => ({
  env: {
    XDG_CONFIG_HOME: '/cfg',
    XDG_STATE_HOME: '/state',
    SLACK_APP_TOKEN: 'xapp-1-SERVICE',
  },
  run: () => Promise.resolve({ stdout: 'active\n' }),
  readFile: () => SERVICE_ENV_FILE,
  ...overrides,
});

describe('serviceCollision', () => {
  it('refuses when the unit is active and the daemon holds the service Slack app token', async () => {
    const refusal = await serviceCollision(deps());

    expect(refusal).toContain('SLACK_APP_TOKEN');
    expect(refusal).toContain('dev Slack app');
  });

  it('refuses when both would write the same database, even with distinct Slack apps', async () => {
    const refusal = await serviceCollision(
      deps({
        env: { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state', SLACK_APP_TOKEN: 'xapp-1-DEV' },
      }),
    );

    expect(refusal).toContain('/state/orchestrator/orchestrator.db');
    expect(refusal).toContain('ORCHESTRATOR_DB_PATH');
  });

  it('compares resolved paths — the service default against an explicit dev path spelled differently', async () => {
    const refusal = await serviceCollision(
      deps({
        env: {
          XDG_CONFIG_HOME: '/cfg',
          XDG_STATE_HOME: '/state',
          SLACK_APP_TOKEN: 'xapp-1-DEV',
          ORCHESTRATOR_DB_PATH: '/state/orchestrator/../orchestrator/orchestrator.db',
        },
      }),
    );

    expect(refusal).not.toBeNull();
  });

  it('lets an isolated dev instance boot — own Slack app, own database', async () => {
    const refusal = await serviceCollision(
      deps({
        env: {
          XDG_CONFIG_HOME: '/cfg',
          XDG_STATE_HOME: '/state',
          SLACK_APP_TOKEN: 'xapp-1-DEV',
          ORCHESTRATOR_DB_PATH: '/checkout/.dev/orchestrator.db',
        },
      }),
    );

    expect(refusal).toBeNull();
  });

  it('never fires under systemd itself — the unit process carries $INVOCATION_ID', async () => {
    const refusal = await serviceCollision(
      deps({
        env: {
          XDG_CONFIG_HOME: '/cfg',
          XDG_STATE_HOME: '/state',
          SLACK_APP_TOKEN: 'xapp-1-SERVICE',
          INVOCATION_ID: 'abc123',
        },
      }),
    );

    expect(refusal).toBeNull();
  });

  it('fails open when the unit is not active — a full token match proves nothing then', async () => {
    const refusal = await serviceCollision(deps({ run: () => Promise.resolve({ stdout: 'inactive\n' }) }));

    expect(refusal).toBeNull();
  });

  it('fails open on an unknown unit state — is-active answered nothing usable', async () => {
    const refusal = await serviceCollision(
      deps({
        run: () => Promise.reject(Object.assign(new Error('systemctl failed'), { stdout: '', stderr: '' })),
      }),
    );

    expect(refusal).toBeNull();
  });

  it('fails open when systemd cannot be asked — an unreachable bus is ignorance, not a state', async () => {
    const refusal = await serviceCollision(
      deps({
        run: () =>
          Promise.reject(
            Object.assign(new Error('systemctl failed'), {
              stdout: '',
              stderr: 'Failed to connect to user scope bus via local transport',
            }),
          ),
      }),
    );

    expect(refusal).toBeNull();
  });

  it('fails open when the canonical env file is unreadable — nothing provable without it', async () => {
    const refusal = await serviceCollision(
      deps({
        readFile: () => {
          throw new Error('ENOENT');
        },
      }),
    );

    expect(refusal).toBeNull();
  });
});

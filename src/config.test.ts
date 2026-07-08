import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const validEnv = {
  SLACK_BOT_TOKEN: 'xoxb-1111-2222-abc',
  SLACK_APP_TOKEN: 'xapp-1-A111-222-abc',
  SLACK_CHANNEL_ID: 'C0ASJR3LAE6',
  SLACK_ALLOWED_USER_ID: 'U09CC6M3W1W',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc123',
};

describe('loadConfig', () => {
  it('returns the config when every required key is present and well-formed', () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      slackBotToken: 'xoxb-1111-2222-abc',
      slackAppToken: 'xapp-1-A111-222-abc',
      slackChannelId: 'C0ASJR3LAE6',
      slackAllowedUserId: 'U09CC6M3W1W',
      claudeCodeOauthToken: 'sk-ant-oat01-abc123',
      logLevel: 'info',
      dbPath: join(homedir(), '.local', 'state', 'orchestrator', 'orchestrator.db'),
      warmTtlMs: 30 * 60_000,
      costWarnThresholdsUsd: [5, 10],
      liveSessionCap: 5,
      workerCap: 3,
      autoCloseAfterMs: 7 * 24 * 60 * 60_000,
      sweepIntervalMs: 60 * 60_000,
    });
  });

  it('fails fast, naming every missing key at once', () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
    expect(() => loadConfig({})).toThrowError(
      /SLACK_BOT_TOKEN.*SLACK_APP_TOKEN.*SLACK_CHANNEL_ID.*SLACK_ALLOWED_USER_ID.*CLAUDE_CODE_OAUTH_TOKEN/s,
    );
  });

  it.each([
    ['SLACK_BOT_TOKEN', 'xapp-not-a-bot-token', 'xoxb-'],
    ['SLACK_APP_TOKEN', 'xoxb-not-an-app-token', 'xapp-'],
    ['SLACK_CHANNEL_ID', 'U09CC6M3W1W', 'C'],
    ['SLACK_ALLOWED_USER_ID', 'C0ASJR3LAE6', 'U'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'xoxb-not-an-oauth-token', 'sk-ant-'],
  ])('rejects a malformed %s (must start with %s)', (key, badValue) => {
    const env = { ...validEnv, [key]: badValue };

    expect(() => loadConfig(env)).toThrowError(ConfigError);
    expect(() => loadConfig(env)).toThrowError(new RegExp(key));
  });

  it('honors LOG_LEVEL when provided', () => {
    const config = loadConfig({ ...validEnv, LOG_LEVEL: 'debug' });

    expect(config.logLevel).toBe('debug');
  });

  it('rejects a LOG_LEVEL pino does not know', () => {
    const env = { ...validEnv, LOG_LEVEL: 'verbose' };

    expect(() => loadConfig(env)).toThrowError(ConfigError);
    expect(() => loadConfig(env)).toThrowError(/LOG_LEVEL/);
  });

  it('honors the ORCHESTRATOR_DB_PATH override (spec §9)', () => {
    const config = loadConfig({
      ...validEnv,
      ORCHESTRATOR_DB_PATH: '/var/tmp/test-orchestrator.db',
    });

    expect(config.dbPath).toBe('/var/tmp/test-orchestrator.db');
  });

  it('honors SESSION_WARM_TTL_MINUTES when provided', () => {
    const config = loadConfig({ ...validEnv, SESSION_WARM_TTL_MINUTES: '5' });

    expect(config.warmTtlMs).toBe(5 * 60_000);
  });

  it.each([['0'], ['-3'], ['soon']])(
    'rejects a SESSION_WARM_TTL_MINUTES of %s (must be a positive number)',
    (badValue) => {
      const env = { ...validEnv, SESSION_WARM_TTL_MINUTES: badValue };

      expect(() => loadConfig(env)).toThrowError(ConfigError);
      expect(() => loadConfig(env)).toThrowError(/SESSION_WARM_TTL_MINUTES/);
    },
  );

  it('defaults the cost warning thresholds to $5 then $10 (spec §7)', () => {
    expect(loadConfig(validEnv).costWarnThresholdsUsd).toEqual([5, 10]);
  });

  it('honors COST_WARN_THRESHOLDS_USD when provided', () => {
    const config = loadConfig({ ...validEnv, COST_WARN_THRESHOLDS_USD: '2.5, 20, 100' });

    expect(config.costWarnThresholdsUsd).toEqual([2.5, 20, 100]);
  });

  it.each([['ten'], ['0'], ['-5,10'], ['10,5'], ['5,5'], ['']])(
    'rejects a COST_WARN_THRESHOLDS_USD of "%s" (ascending positive amounts only)',
    (badValue) => {
      const env = { ...validEnv, COST_WARN_THRESHOLDS_USD: badValue };

      expect(() => loadConfig(env)).toThrowError(ConfigError);
      expect(() => loadConfig(env)).toThrowError(/COST_WARN_THRESHOLDS_USD/);
    },
  );

  it('defaults the live-session cap to 5 (spec §3)', () => {
    expect(loadConfig(validEnv).liveSessionCap).toBe(5);
  });

  it('honors SESSION_LIVE_CAP when provided', () => {
    expect(loadConfig({ ...validEnv, SESSION_LIVE_CAP: '2' }).liveSessionCap).toBe(2);
  });

  it.each([['0'], ['-1'], ['2.5'], ['many']])(
    'rejects a SESSION_LIVE_CAP of %s (must be a positive integer)',
    (badValue) => {
      const env = { ...validEnv, SESSION_LIVE_CAP: badValue };

      expect(() => loadConfig(env)).toThrowError(ConfigError);
      expect(() => loadConfig(env)).toThrowError(/SESSION_LIVE_CAP/);
    },
  );

  it('honors WORKER_CAP when provided', () => {
    expect(loadConfig({ ...validEnv, WORKER_CAP: '5' }).workerCap).toBe(5);
  });

  it.each([['0'], ['-1'], ['2.5'], ['many']])(
    'rejects a WORKER_CAP of %s (must be a positive integer)',
    (badValue) => {
      const env = { ...validEnv, WORKER_CAP: badValue };

      expect(() => loadConfig(env)).toThrowError(ConfigError);
      expect(() => loadConfig(env)).toThrowError(/WORKER_CAP/);
    },
  );

  it('defaults the auto-close span to 7 days dormant (spec §3)', () => {
    expect(loadConfig(validEnv).autoCloseAfterMs).toBe(7 * 24 * 60 * 60_000);
  });

  it('honors SESSION_AUTO_CLOSE_DAYS when provided', () => {
    const config = loadConfig({ ...validEnv, SESSION_AUTO_CLOSE_DAYS: '14' });

    expect(config.autoCloseAfterMs).toBe(14 * 24 * 60 * 60_000);
  });

  it.each([['0'], ['-7'], ['never']])(
    'rejects a SESSION_AUTO_CLOSE_DAYS of %s (must be a positive number)',
    (badValue) => {
      const env = { ...validEnv, SESSION_AUTO_CLOSE_DAYS: badValue };

      expect(() => loadConfig(env)).toThrowError(ConfigError);
      expect(() => loadConfig(env)).toThrowError(/SESSION_AUTO_CLOSE_DAYS/);
    },
  );

  it('defaults the sweep interval to an hour and honors the override', () => {
    expect(loadConfig(validEnv).sweepIntervalMs).toBe(60 * 60_000);
    expect(
      loadConfig({ ...validEnv, SESSION_SWEEP_INTERVAL_MINUTES: '15' }).sweepIntervalMs,
    ).toBe(15 * 60_000);
  });

  it.each([['0'], ['-10'], ['hourly']])(
    'rejects a SESSION_SWEEP_INTERVAL_MINUTES of %s (must be a positive number)',
    (badValue) => {
      const env = { ...validEnv, SESSION_SWEEP_INTERVAL_MINUTES: badValue };

      expect(() => loadConfig(env)).toThrowError(ConfigError);
      expect(() => loadConfig(env)).toThrowError(/SESSION_SWEEP_INTERVAL_MINUTES/);
    },
  );
});

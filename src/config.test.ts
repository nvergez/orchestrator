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
});

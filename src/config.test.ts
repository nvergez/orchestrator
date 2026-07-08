import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const validEnv = {
  SLACK_BOT_TOKEN: 'xoxb-1111-2222-abc',
  SLACK_APP_TOKEN: 'xapp-1-A111-222-abc',
  SLACK_CHANNEL_ID: 'C0ASJR3LAE6',
  SLACK_ALLOWED_USER_ID: 'U09CC6M3W1W',
};

describe('loadConfig', () => {
  it('returns the config when every required key is present and well-formed', () => {
    const config = loadConfig(validEnv);

    expect(config).toEqual({
      slackBotToken: 'xoxb-1111-2222-abc',
      slackAppToken: 'xapp-1-A111-222-abc',
      slackChannelId: 'C0ASJR3LAE6',
      slackAllowedUserId: 'U09CC6M3W1W',
      logLevel: 'info',
    });
  });

  it('fails fast, naming every missing key at once', () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
    expect(() => loadConfig({})).toThrowError(
      /SLACK_BOT_TOKEN.*SLACK_APP_TOKEN.*SLACK_CHANNEL_ID.*SLACK_ALLOWED_USER_ID/s,
    );
  });

  it.each([
    ['SLACK_BOT_TOKEN', 'xapp-not-a-bot-token', 'xoxb-'],
    ['SLACK_APP_TOKEN', 'xoxb-not-an-app-token', 'xapp-'],
    ['SLACK_CHANNEL_ID', 'U09CC6M3W1W', 'C'],
    ['SLACK_ALLOWED_USER_ID', 'C0ASJR3LAE6', 'U'],
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
});

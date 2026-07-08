/**
 * Boot configuration, read from process.env only (spec §10: no dotenv —
 * systemd provides EnvironmentFile, dev runs use `node --env-file=.env`).
 */
export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  slackAllowedUserId: string;
  logLevel: string;
}

export class ConfigError extends Error {}

const PINO_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];

  const required = (key: string, prefix: string): string => {
    const value = env[key];
    if (!value) {
      problems.push(`${key} is missing`);
      return '';
    }
    if (!value.startsWith(prefix)) {
      problems.push(`${key} must start with "${prefix}"`);
      return '';
    }
    return value;
  };

  const config: Config = {
    slackBotToken: required('SLACK_BOT_TOKEN', 'xoxb-'),
    slackAppToken: required('SLACK_APP_TOKEN', 'xapp-'),
    slackChannelId: required('SLACK_CHANNEL_ID', 'C'),
    slackAllowedUserId: required('SLACK_ALLOWED_USER_ID', 'U'),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
  if (!PINO_LEVELS.includes(config.logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${PINO_LEVELS.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  }
  return config;
}

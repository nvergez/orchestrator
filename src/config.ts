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

const REQUIRED_KEYS: ReadonlyArray<readonly [key: string, prefix: string]> = [
  ['SLACK_BOT_TOKEN', 'xoxb-'],
  ['SLACK_APP_TOKEN', 'xapp-'],
  ['SLACK_CHANNEL_ID', 'C'],
  ['SLACK_ALLOWED_USER_ID', 'U'],
];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  for (const [key, prefix] of REQUIRED_KEYS) {
    const value = env[key];
    if (!value) {
      problems.push(`${key} is missing`);
    } else if (!value.startsWith(prefix)) {
      problems.push(`${key} must start with "${prefix}"`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  }

  return {
    slackBotToken: env.SLACK_BOT_TOKEN as string,
    slackAppToken: env.SLACK_APP_TOKEN as string,
    slackChannelId: env.SLACK_CHANNEL_ID as string,
    slackAllowedUserId: env.SLACK_ALLOWED_USER_ID as string,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}

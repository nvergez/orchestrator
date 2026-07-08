import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Boot configuration, read from process.env only (spec §10: no dotenv —
 * systemd provides EnvironmentFile, dev runs use `node --env-file=.env`).
 */
export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  slackAllowedUserId: string;
  /** Daemon auth from `claude setup-token` — subscription-billed (spec §10). */
  claudeCodeOauthToken: string;
  logLevel: string;
  /** SQLite home, `ORCHESTRATOR_DB_PATH` override (spec §9). */
  dbPath: string;
  /** How long a finished-turn session keeps its live process (spec §3). */
  warmTtlMs: number;
}

export class ConfigError extends Error {}

const PINO_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

const DEFAULT_WARM_TTL_MINUTES = 30;

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

  const warmTtlMinutes = Number(env.SESSION_WARM_TTL_MINUTES ?? DEFAULT_WARM_TTL_MINUTES);
  if (!Number.isFinite(warmTtlMinutes) || warmTtlMinutes <= 0) {
    problems.push('SESSION_WARM_TTL_MINUTES must be a positive number of minutes');
  }

  const config: Config = {
    slackBotToken: required('SLACK_BOT_TOKEN', 'xoxb-'),
    slackAppToken: required('SLACK_APP_TOKEN', 'xapp-'),
    slackChannelId: required('SLACK_CHANNEL_ID', 'C'),
    slackAllowedUserId: required('SLACK_ALLOWED_USER_ID', 'U'),
    claudeCodeOauthToken: required('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-'),
    logLevel: env.LOG_LEVEL ?? 'info',
    dbPath:
      env.ORCHESTRATOR_DB_PATH ??
      join(homedir(), '.local', 'state', 'orchestrator', 'orchestrator.db'),
    warmTtlMs: warmTtlMinutes * 60_000,
  };
  if (!PINO_LEVELS.includes(config.logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${PINO_LEVELS.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  }
  return config;
}

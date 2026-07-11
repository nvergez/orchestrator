import { resolveDefaultDbPath } from './xdg.ts';

/**
 * Boot configuration, read from process.env only (spec §10: no dotenv —
 * systemd provides EnvironmentFile, dev runs use `node --env-file-if-exists=.env`,
 * so a missing file surfaces here as the full missing-variable list).
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
  /** Per-session 💸 warning thresholds, ascending USD (spec §7: 5 then 10). */
  costWarnThresholdsUsd: number[];
  /** Global cap on live sessions — dormant ones don't count (spec §3: 5). */
  liveSessionCap: number;
  /** Global cap on concurrent Orca workers (spec §5) — fan-out waves beyond it. */
  workerCap: number;
  /** One gate-watcher `check --wait` window before it rolls (spec §6, #20). */
  watchWindowMs: number;
  /** How often the stalled-worker watchdog sweeps in-flight worktrees (#22). */
  watchdogSweepIntervalMs: number;
  /** Silence across every worktree signal before a worker counts stalled (#22). */
  watchdogStallAfterMs: number;
  /** In-flight age with a mute bus before the ⚠️ needs-attention alert (#48). */
  watchdogMaxInflightMs: number;
  /** Dormancy span after which the sweep auto-closes a session (spec §3: 7 days). */
  autoCloseAfterMs: number;
  /** How often the dormancy sweep runs. */
  sweepIntervalMs: number;
}

export class ConfigError extends Error {}

const PINO_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

const DEFAULT_WARM_TTL_MINUTES = 30;

const DEFAULT_COST_WARN_THRESHOLDS_USD = [5, 10];

const DEFAULT_LIVE_SESSION_CAP = 5;

const DEFAULT_WORKER_CAP = 3;

const DEFAULT_AUTO_CLOSE_DAYS = 7;

const DEFAULT_WATCH_WINDOW_MINUTES = 15;

const DEFAULT_WATCHDOG_SWEEP_MINUTES = 2;

const DEFAULT_WATCHDOG_STALL_MINUTES = 10;

const DEFAULT_WATCHDOG_MAX_INFLIGHT_MINUTES = 30;

const DEFAULT_SWEEP_INTERVAL_MINUTES = 60;

export const DAY_MS = 24 * 60 * 60_000;

const DEFAULT_DASHBOARD_PORT = 8787;

const DEFAULT_DASHBOARD_BIND = '127.0.0.1';

/** Where the dashboard sidecar listens — bind address + port (issue #87). */
export interface DashboardAddress {
  bind: string;
  port: number;
}

/**
 * Where the dashboard sidecar listens (issue #87). Localhost is the default
 * security boundary — the project never terminates remote traffic, so
 * exposing the page beyond the machine means the operator changing
 * DASHBOARD_BIND (or tunneling) on their own authority (ADR 0002). Lives
 * here, not in loadConfig: the sidecar must boot without the daemon's Slack
 * tokens, and doctor reads it without either.
 */
export function resolveDashboardAddress(
  env: Record<string, string | undefined>,
): DashboardAddress {
  const port = Number(env.DASHBOARD_PORT ?? DEFAULT_DASHBOARD_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError('invalid configuration: DASHBOARD_PORT must be a port number (1-65535)');
  }
  return { bind: env.DASHBOARD_BIND ?? DEFAULT_DASHBOARD_BIND, port };
}

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

  const positiveNumber = (key: string, fallback: number, unit: string): number => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`${key} must be a positive number of ${unit}`);
    }
    return value;
  };

  const warmTtlMinutes = positiveNumber(
    'SESSION_WARM_TTL_MINUTES',
    DEFAULT_WARM_TTL_MINUTES,
    'minutes',
  );

  const liveSessionCap = Number(env.SESSION_LIVE_CAP ?? DEFAULT_LIVE_SESSION_CAP);
  if (!Number.isInteger(liveSessionCap) || liveSessionCap <= 0) {
    problems.push('SESSION_LIVE_CAP must be a positive integer');
  }

  const workerCap = Number(env.WORKER_CAP ?? DEFAULT_WORKER_CAP);
  if (!Number.isInteger(workerCap) || workerCap <= 0) {
    problems.push('WORKER_CAP must be a positive integer');
  }

  const autoCloseDays = positiveNumber(
    'SESSION_AUTO_CLOSE_DAYS',
    DEFAULT_AUTO_CLOSE_DAYS,
    'days',
  );

  const watchWindowMinutes = positiveNumber(
    'WATCH_WINDOW_MINUTES',
    DEFAULT_WATCH_WINDOW_MINUTES,
    'minutes',
  );

  const watchdogSweepMinutes = positiveNumber(
    'WATCHDOG_SWEEP_INTERVAL_MINUTES',
    DEFAULT_WATCHDOG_SWEEP_MINUTES,
    'minutes',
  );

  const watchdogStallMinutes = positiveNumber(
    'WATCHDOG_STALL_MINUTES',
    DEFAULT_WATCHDOG_STALL_MINUTES,
    'minutes',
  );

  const watchdogMaxInflightMinutes = positiveNumber(
    'WATCHDOG_MAX_INFLIGHT_MINUTES',
    DEFAULT_WATCHDOG_MAX_INFLIGHT_MINUTES,
    'minutes',
  );

  const sweepIntervalMinutes = positiveNumber(
    'SESSION_SWEEP_INTERVAL_MINUTES',
    DEFAULT_SWEEP_INTERVAL_MINUTES,
    'minutes',
  );

  let costWarnThresholdsUsd = [...DEFAULT_COST_WARN_THRESHOLDS_USD];
  if (env.COST_WARN_THRESHOLDS_USD !== undefined) {
    const parsed = env.COST_WARN_THRESHOLDS_USD.split(',').map((v) => Number(v.trim()));
    const ascending = parsed.every((n, i) => i === 0 || n > (parsed[i - 1] ?? NaN));
    if (parsed.some((n) => !Number.isFinite(n) || n <= 0) || !ascending) {
      problems.push(
        'COST_WARN_THRESHOLDS_USD must be ascending positive dollar amounts, e.g. "5,10"',
      );
    } else {
      costWarnThresholdsUsd = parsed;
    }
  }

  const config: Config = {
    slackBotToken: required('SLACK_BOT_TOKEN', 'xoxb-'),
    slackAppToken: required('SLACK_APP_TOKEN', 'xapp-'),
    slackChannelId: required('SLACK_CHANNEL_ID', 'C'),
    slackAllowedUserId: required('SLACK_ALLOWED_USER_ID', 'U'),
    claudeCodeOauthToken: required('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-'),
    logLevel: env.LOG_LEVEL ?? 'info',
    dbPath: env.ORCHESTRATOR_DB_PATH ?? resolveDefaultDbPath(env),
    warmTtlMs: warmTtlMinutes * 60_000,
    costWarnThresholdsUsd,
    liveSessionCap,
    workerCap,
    watchWindowMs: watchWindowMinutes * 60_000,
    watchdogSweepIntervalMs: watchdogSweepMinutes * 60_000,
    watchdogStallAfterMs: watchdogStallMinutes * 60_000,
    watchdogMaxInflightMs: watchdogMaxInflightMinutes * 60_000,
    autoCloseAfterMs: autoCloseDays * DAY_MS,
    sweepIntervalMs: sweepIntervalMinutes * 60_000,
  };
  if (!PINO_LEVELS.includes(config.logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${PINO_LEVELS.join(', ')}`);
  }

  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  }
  return config;
}

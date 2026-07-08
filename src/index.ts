import { App } from '@slack/bolt';
import { pino } from 'pino';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createLogger, toBoltLogger } from './logger.ts';
import { registerHandlers } from './app.ts';
import { reportOrcaHealth } from './orca-health.ts';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    pino().fatal(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger(config.logLevel);

// Fire-and-forget: the probe runs while we connect to Slack and logs whenever
// it lands — Orca being down must never crash or delay startup (spec §10).
void reportOrcaHealth(logger);

try {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logger: toBoltLogger(logger),
    // Without this, the constructor fires its own auth.test in the background
    // and a bad token dies as an unhandled rejection instead of down in our catch.
    deferInitialization: true,
  });
  await app.init();

  // auth.test both verifies the bot token before we connect (fail fast on an
  // invalid key) and tells us our own user id for the filter's self-check.
  const auth = await app.client.auth.test();
  if (!auth.user_id) {
    throw new Error('auth.test returned no user_id — cannot build the event filter');
  }
  const guard = {
    channelId: config.slackChannelId,
    allowedUserId: config.slackAllowedUserId,
    botUserId: auth.user_id,
  };

  registerHandlers(app, guard, logger);
  await app.start();
  logger.info(
    { botUserId: guard.botUserId, channelId: guard.channelId },
    'connected to Slack over Socket Mode',
  );
} catch (error) {
  logger.fatal({ err: error }, 'boot failed');
  process.exit(1);
}

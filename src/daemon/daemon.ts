import { readFileSync } from 'node:fs';
import { App } from '@slack/bolt';
import { pino } from 'pino';
import { ConfigError, loadConfig, type Config } from '../kernel/config.ts';
import { createLogger, toBoltLogger } from '../kernel/logger.ts';
import { registerHandlers } from './app.ts';
import { reportOrcaHealth } from '../kernel/orca-health.ts';
import { execFileRunner } from '../kernel/orca.ts';
import { createProcessFactory } from './claude.ts';
import { serviceCollision } from './collision.ts';
import { buildRuntime } from './runtime.ts';
import type { Surface } from '../delegation/thread-surface.ts';
import { loadRoutingHints } from '../kernel/routing.ts';
import { resolveRoutingHintsPath } from '../kernel/xdg.ts';

/**
 * The daemon boot — what bare `orc` runs (the CLI dispatch lives in cli.ts).
 * Deliberately thin: env config, the Bolt connection and the process
 * lifecycle live here; everything wired from them lives in runtime.ts,
 * where the composition is testable.
 */
export async function runDaemon(): Promise<void> {
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

  // A checkout-run daemon must not collide with the installed service —
  // same Slack app or same database corrupts both worlds (ADR 0003).
  const refusal = await serviceCollision({
    env: process.env,
    run: execFileRunner,
    readFile: (path) => readFileSync(path, 'utf8'),
  });
  if (refusal !== null) {
    logger.fatal(refusal);
    process.exit(1);
  }

  // Fire-and-forget: the probe runs while we connect to Slack and logs whenever
  // it lands — Orca being down must never crash or delay startup (spec §10).
  void reportOrcaHealth(logger);

  try {
    // The routing hints double as the delegation allow-list (spec §4/§7) — a
    // missing or malformed file must fail the boot, never narrow the list
    // silently. Resolution (issue #70): ORCHESTRATOR_ROUTING_HINTS_PATH, else
    // the XDG config dir — never the package install dir.
    const hints = loadRoutingHints(resolveRoutingHintsPath(process.env));
    logger.info(
      { repos: hints.map((hint) => hint.name) },
      'routing hints loaded — the delegation allow-list',
    );

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

    // The raw Slack adapter under everything the runtime posts — threads,
    // gates, voices, reactions — pinned to the one configured channel.
    const surface: Surface = {
      post: async (threadTs, text) => {
        const result = await app.client.chat.postMessage({
          channel: config.slackChannelId,
          thread_ts: threadTs,
          text,
        });
        if (result.ts === undefined) {
          throw new Error('chat.postMessage returned no ts');
        }
        return result.ts;
      },
      update: async (ts, text) => {
        await app.client.chat.update({ channel: config.slackChannelId, ts, text });
      },
      react: async (ts, name) => {
        await app.client.reactions.add({ channel: config.slackChannelId, timestamp: ts, name });
      },
      unreact: async (ts, name) => {
        await app.client.reactions.remove({ channel: config.slackChannelId, timestamp: ts, name });
      },
    };

    const runtime = buildRuntime({
      config,
      hints,
      surface,
      createProcesses: (seams) => createProcessFactory({ cwd: process.cwd(), logger, ...seams }),
      // Mailbox terminals live in the daemon's own checkout — the one worktree
      // that always exists and never gets archived with a delegation.
      mailboxWorktreePath: process.cwd(),
      logger,
    });
    await runtime.boot();

    registerHandlers(app, guard, runtime.sessions, runtime.gates, runtime.relay, logger);
    await app.start();
    logger.info(
      { botUserId: guard.botUserId, channelId: guard.channelId },
      'connected to Slack over Socket Mode',
    );

    runtime.startDormancySweep();
  } catch (error) {
    logger.fatal({ err: error }, 'boot failed');
    process.exit(1);
  }
}

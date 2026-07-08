import { join } from 'node:path';
import { App } from '@slack/bolt';
import { pino } from 'pino';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createLogger, toBoltLogger } from './logger.ts';
import { registerHandlers } from './app.ts';
import { reportOrcaHealth } from './orca-health.ts';
import { SessionStore } from './db.ts';
import { DelegationStore } from './delegations.ts';
import { DelegationCoordinator } from './dispatch.ts';
import { SessionManager } from './sessions.ts';
import { GateWatcher } from './watcher.ts';
import { BootReconciler } from './reconcile.ts';
import { GateRelay } from './relay.ts';
import { createProcessFactory } from './claude.ts';
import { GateKeeper } from './gate.ts';
import { Voice } from './voice.ts';
import { loadRoutingHints, RepoAllowList, routingInstructions } from './routing.ts';

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
  // The routing hints double as the delegation allow-list (spec §4/§7) — a
  // malformed file must fail the boot, never narrow the list silently.
  const hints = loadRoutingHints(join(import.meta.dirname, '..', 'routing-hints.json'));
  logger.info(
    { repos: hints.map((hint) => hint.name) },
    'routing hints loaded — the delegation allow-list',
  );

  const store = new SessionStore(config.dbPath);
  const delegationStore = new DelegationStore(config.dbPath);
  // Boot rule (spec §3): rows survive the restart, every session comes back
  // dormant, and nothing below wakes one — the next human message does.
  logger.info(
    { dbPath: config.dbPath, sessions: store.count(), inFlight: delegationStore.inFlightCount() },
    'state database open — all sessions dormant',
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

  const postToThread = async (threadTs: string, text: string): Promise<string> => {
    const result = await app.client.chat.postMessage({
      channel: config.slackChannelId,
      thread_ts: threadTs,
      text,
    });
    if (result.ts === undefined) {
      throw new Error('chat.postMessage returned no ts');
    }
    return result.ts;
  };

  // 🚦 gates post as their own thread messages (spec §8: anything requiring
  // the human is a new message, never an edit of the streaming voice).
  const gates = new GateKeeper({
    allowedUserId: config.slackAllowedUserId,
    post: postToThread,
    logger,
  });

  const allowList = new RepoAllowList({ hints, logger });

  // One Slack surface for the delegation coordinator and the gate watcher —
  // thread posts, card edits, root reactions on and off.
  const surface = {
    post: postToThread,
    update: async (ts: string, text: string): Promise<void> => {
      await app.client.chat.update({ channel: config.slackChannelId, ts, text });
    },
    react: async (ts: string, name: string): Promise<void> => {
      await app.client.reactions.add({ channel: config.slackChannelId, timestamp: ts, name });
    },
    unreact: async (ts: string, name: string): Promise<void> => {
      await app.client.reactions.remove({ channel: config.slackChannelId, timestamp: ts, name });
    },
  };

  // Boot reconciliation (spec §7, issue #25): crash recovery without waking
  // sessions — dispatched rows reconciled against task-list + worktree ps,
  // one truthful ⚠️ line per affected thread, completions missed during the
  // outage closed right here. Deliberately BEFORE the coordinator (so the
  // worker-cap count below excludes what the outage already ended) and
  // BEFORE the watcher re-arm (so a closed row never arms a watcher that
  // would double-report it as a wake).
  await new BootReconciler({ store: delegationStore, surface, logger }).reconcile();

  // The delegation coordinator (issue #19): worker cap, mailbox terminals,
  // delegation cards and the `delegations` ledger — the daemon half of §5.
  const delegations = new DelegationCoordinator({
    store: delegationStore,
    surface,
    channelId: config.slackChannelId,
    workerCap: config.workerCap,
    // Mailbox terminals live in the daemon's own checkout — the one worktree
    // that always exists and never gets archived with a delegation.
    mailboxWorktreePath: process.cwd(),
    // Evaluated at dispatch time, long after the watcher below exists.
    onDispatched: (threadTs) => {
      watcher.arm(threadTs);
    },
    logger,
  });

  // The gate relay (issue #21): route-back enforcement anchored on the
  // pending_gates registry — reply provenance, answer fidelity, the
  // sanctioned terminal-send fallback, and the turn-context decoration.
  const relay = new GateRelay({ store: delegationStore, surface, logger });

  const sessions = new SessionManager({
    store,
    spawn: createProcessFactory({
      cwd: process.cwd(),
      gates,
      allowList,
      delegations,
      relay,
      systemPromptAppend: routingInstructions(hints),
      logger,
    }),
    voiceFor: (threadTs) =>
      new Voice(
        {
          post: (text) => postToThread(threadTs, text),
          update: async (ts, text) => {
            await app.client.chat.update({ channel: config.slackChannelId, ts, text });
          },
        },
        { onError: (err) => logger.warn({ err, threadTs }, 'voice flush failed') },
      ),
    // 💸 warnings are events, not status: always a fresh message (spec §8).
    notify: async (threadTs, text) => {
      await postToThread(threadTs, text);
    },
    costThresholdsUsd: config.costWarnThresholdsUsd,
    warmTtlMs: config.warmTtlMs,
    liveSessionCap: config.liveSessionCap,
    autoCloseAfterMs: config.autoCloseAfterMs,
    countDelegations: (threadTs) => delegationStore.countForThread(threadTs),
    logger,
  });

  // The per-thread gate watcher (spec §6, issue #20): the daemon listens,
  // the session thinks — one `check --wait` child per thread with in-flight
  // work, worker_done → ✅ card + summary wake, gates surfaced verbatim.
  const watcher = new GateWatcher({
    store: delegationStore,
    surface,
    wake: (threadTs, channelId, text) => sessions.wake(threadTs, channelId, text),
    onDelegationClosed: () => {
      delegations.onDelegationClosed();
    },
    windowMs: config.watchWindowMs,
    logger,
  });
  // Boot re-arm (spec §6): the ledger, not process memory, says which
  // threads still have workers out — a completion sent while the daemon was
  // down is still sitting unread on the mailbox and lands right here.
  const rearmed = watcher.rearmFromStore();
  if (rearmed > 0) {
    logger.info({ threads: rearmed }, 'gate watchers re-armed from the delegations ledger');
  }

  registerHandlers(app, guard, sessions, gates, relay, logger);
  await app.start();
  logger.info(
    { botUserId: guard.botUserId, channelId: guard.channelId },
    'connected to Slack over Socket Mode',
  );

  // Dormancy sweep (spec §3: auto-close after 7 days dormant). One pass at
  // boot catches sessions that crossed the span while the daemon was down.
  const sweep = (): void => {
    sessions.sweepDormant().catch((error: unknown) => {
      logger.error({ err: error }, 'dormancy sweep failed');
    });
  };
  sweep();
  setInterval(sweep, config.sweepIntervalMs).unref();
} catch (error) {
  logger.fatal({ err: error }, 'boot failed');
  process.exit(1);
}

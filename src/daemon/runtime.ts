import { SessionStore } from './db.ts';
import { DelegationStore } from '../delegation/delegations.ts';
import {
  DelegationCoordinator,
  type DispatchObserver,
  type DispatchPreparer,
} from '../delegation/dispatch.ts';
import { SessionManager, type ProcessFactory } from './sessions.ts';
import { GateWatcher } from '../delegation/watcher.ts';
import { ThreadSurface, type Surface } from '../delegation/thread-surface.ts';
import { BootReconciler } from '../delegation/reconcile.ts';
import { Watchdog } from '../delegation/watchdog.ts';
import { GateRelay, type SessionRelay } from '../delegation/relay.ts';
import { execFileRunner, safeRegistryIssueUrls, type CommandRunner } from '../kernel/orca.ts';
import { GateKeeper, type SessionGates } from './gate.ts';
import { Voice } from './voice.ts';
import { RepoAllowList, routingInstructions, type RepoHint } from '../kernel/routing.ts';
import type { DelegationPolicy } from './permissions.ts';
import type { Config } from '../kernel/config.ts';
import type { Logger } from '../kernel/logger.ts';

/**
 * The composition root: every enforcement and supervision object the daemon
 * runs — and how they plug into each other — wired in one place, behind the
 * seams the modules already expose. daemon.ts owns the outside world (env
 * config, the Bolt connection, the process lifecycle) and hands it in as
 * adapters; runtime.test.ts hands in fakes at the same seams and drives the
 * REAL graph. The boot ordering contract lives in `boot()` so a test can pin
 * it instead of trusting a comment.
 */

/** What the session-process factory gets to build enforcement from — exactly
 * the wired objects claude.ts puts behind one `canUseTool` (spec §7). */
export interface ProcessSeams {
  gates: SessionGates;
  allowList: DelegationPolicy;
  delegations: DispatchPreparer & DispatchObserver;
  relay: SessionRelay;
  /** The routing rules (issue #18) rendered from the hints, ready to append. */
  systemPromptAppend: string;
}

export interface RuntimeOptions {
  config: Config;
  /** The routing hints — the delegation allow-list, loaded and validated. */
  hints: RepoHint[];
  /** The raw Slack adapter (daemon.ts implements it over the Web API). */
  surface: Surface;
  /** Builds the per-thread session-process factory over the wired seams —
   * the SDK adapter in production (claude.ts), a scripted fake in tests. */
  createProcesses: (seams: ProcessSeams) => ProcessFactory;
  /** The Orca worktree the mailbox terminals live in — the daemon's own
   * checkout, the one worktree that always exists and never gets archived
   * with a delegation. */
  mailboxWorktreePath: string;
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
  /** The gate watcher's blocking `check --wait` child; the watcher supplies
   * its own long-timeout default. */
  runCheck?: CommandRunner;
  /** Repeats a task forever; the default is an unref'd `setInterval` so the
   * sweeps never hold the process open. */
  every?: (task: () => void, intervalMs: number) => void;
}

/** The wired graph, plus the boot sequence and sweep arming as callable steps. */
export interface Runtime {
  store: SessionStore;
  delegationStore: DelegationStore;
  gates: GateKeeper;
  allowList: RepoAllowList;
  relay: GateRelay;
  delegations: DelegationCoordinator;
  sessions: SessionManager;
  watcher: GateWatcher;
  watchdog: Watchdog;
  reconciler: BootReconciler;
  /** The ordered boot pass: reconcile, re-arm the gate watchers, then the
   * watchdog's first sweep and its interval. Call once, before Slack events
   * flow. */
  boot(): Promise<void>;
  /** The dormancy sweep (spec §3) — a boot pass plus its interval. Called
   * after the Slack connection is up: a swept session posts its 🔚 summary. */
  startDormancySweep(): void;
}

export function buildRuntime(options: RuntimeOptions): Runtime {
  const { config, hints, surface: slack, logger } = options;
  const run = options.run ?? execFileRunner;
  const every =
    options.every ??
    ((task: () => void, intervalMs: number): void => {
      setInterval(task, intervalMs).unref();
    });

  const store = new SessionStore(config.dbPath);
  const delegationStore = new DelegationStore(config.dbPath);
  // Boot rule (spec §3): rows survive the restart, every session comes back
  // dormant, and nothing below wakes one — the next human message does.
  logger.info(
    { dbPath: config.dbPath, sessions: store.count(), inFlight: delegationStore.inFlightCount() },
    'state database open — all sessions dormant',
  );

  // 🚦 gates post as their own thread messages (spec §8: anything requiring
  // the human is a new message, never an edit of the streaming voice).
  const gates = new GateKeeper({
    allowedUserIds: config.slackAllowedUserIds,
    post: (threadTs, channelId, text) => slack.post(channelId, threadTs, text),
    logger,
  });

  const allowList = new RepoAllowList({ hints, logger, run });

  // ONE thread surface for every delegation coordinator — it owns what a
  // thread's root message shows (root reactions, delegation cards) over
  // the raw Slack adapter below.
  const surface = new ThreadSurface({ surface: slack, store: delegationStore, logger, run });

  // The delegation coordinator (issue #19): worker cap, mailbox terminals,
  // delegation cards and the `delegations` ledger — the daemon half of §5.
  const delegations = new DelegationCoordinator({
    store: delegationStore,
    surface,
    workerCap: config.workerCap,
    mailboxWorktreePath: options.mailboxWorktreePath,
    // Evaluated at dispatch time, long after the watcher below exists.
    onDispatched: (threadTs, channelId) => {
      watcher.arm(threadTs, channelId);
    },
    logger,
    run,
  });

  // The gate relay (issue #21): route-back enforcement anchored on the
  // pending_gates registry — reply provenance, answer fidelity, the
  // sanctioned terminal-send fallback, and the turn-context decoration.
  const relay = new GateRelay({ store: delegationStore, surface, logger });

  const sessions = new SessionManager({
    store,
    spawn: options.createProcesses({
      gates,
      allowList,
      delegations,
      relay,
      systemPromptAppend: routingInstructions(hints),
    }),
    voiceFor: (threadTs, channelId) =>
      new Voice(
        {
          post: (text) => slack.post(channelId, threadTs, text),
          update: (ts, text) => slack.update(channelId, ts, text),
        },
        { onError: (err) => logger.warn({ err, threadTs }, 'voice flush failed') },
      ),
    // 💸 warnings are events, not status: always a fresh message (spec §8).
    notify: async (threadTs, channelId, text) => {
      await slack.post(channelId, threadTs, text);
    },
    costThresholdsUsd: config.costWarnThresholdsUsd,
    warmTtlMs: config.warmTtlMs,
    liveSessionCap: config.liveSessionCap,
    autoCloseAfterMs: config.autoCloseAfterMs,
    // The 🔚 summary's ledger (issue #51): every delegation with its outcome,
    // issue links resolved off one registry read — folder repos stay plain.
    listDelegations: (threadTs, channelId) =>
      safeRegistryIssueUrls(run, logger, delegationStore.listForThread(threadTs, channelId)),
    // The turn-lifecycle root ack (issue #49): 👀 the moment any turn starts
    // — session open included — and off again when the turn ends with no
    // delegation in flight and nothing pending.
    onTurnStart: (threadTs, channelId) => surface.ackWorking(channelId, threadTs),
    onTurnEnd: (threadTs, channelId) =>
      surface.settleTurnEnd(channelId, threadTs, delegations.hasUndispatched(threadTs, channelId)),
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
    ...(options.runCheck !== undefined && { runCheck: options.runCheck }),
    run,
  });

  const reconciler = new BootReconciler({ store: delegationStore, surface, logger, run });

  // The stalled-worker watchdog (spec §5, issue #22): the second detection
  // layer — a periodic staleness sweep over the in-flight delegations'
  // worktrees; a silent worker gets its ⚠️ alert through the same relay
  // mold as gates, and the reply routes down as terminal keystrokes. The
  // same sweep carries the max in-flight age signal (issue #48): a worker
  // whose terminal looks alive but whose bus said nothing for the whole
  // window alerts through the same mold.
  const watchdog = new Watchdog({
    store: delegationStore,
    surface,
    stallAfterMs: config.watchdogStallAfterMs,
    maxInflightMs: config.watchdogMaxInflightMs,
    logger,
    run,
  });
  const stallSweep = (): void => {
    watchdog.sweep().catch((error: unknown) => {
      logger.error({ err: error }, 'watchdog sweep failed');
    });
  };

  const boot = async (): Promise<void> => {
    // Boot reconciliation (spec §7, issue #25): crash recovery without waking
    // sessions — dispatched rows reconciled against task-list + worktree ps,
    // one truthful ⚠️ line per affected thread, completions missed during the
    // outage closed right here. Deliberately BEFORE the watcher re-arm (so a
    // closed row never arms a watcher that would double-report it as a wake);
    // the worker cap needs no ordering — it reads the ledger live.
    await reconciler.reconcile();

    // Boot re-arm (spec §6): the ledger, not process memory, says which
    // threads still have workers out — a completion sent while the daemon was
    // down is still sitting unread on the mailbox and lands right here.
    const rearmed = watcher.rearmFromStore();
    if (rearmed > 0) {
      logger.info({ threads: rearmed }, 'gate watchers re-armed from the delegations ledger');
    }

    // One watchdog pass at boot: a worker that stalled while the daemon was
    // down must not wait a full interval to surface.
    stallSweep();
    every(stallSweep, config.watchdogSweepIntervalMs);
  };

  const startDormancySweep = (): void => {
    // Dormancy sweep (spec §3: auto-close after 7 days dormant). One pass at
    // boot catches sessions that crossed the span while the daemon was down.
    const sweep = (): void => {
      sessions.sweepDormant().catch((error: unknown) => {
        logger.error({ err: error }, 'dormancy sweep failed');
      });
    };
    sweep();
    every(sweep, config.sweepIntervalMs);
  };

  return {
    store,
    delegationStore,
    gates,
    allowList,
    relay,
    delegations,
    sessions,
    watcher,
    watchdog,
    reconciler,
    boot,
    startDormancySweep,
  };
}

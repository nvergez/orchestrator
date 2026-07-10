import { describe, expect, it } from 'vitest';
import { registerHandlers, type SessionGateway, type SlackApp } from './app.ts';
import { GateKeeper } from './gate.ts';
import { GateRelay } from '../delegation/relay.ts';
import { ThreadSurface, type Surface } from '../delegation/thread-surface.ts';
import { DelegationStore } from '../delegation/delegations.ts';
import { createLogger } from '../kernel/logger.ts';
import { refusalLine } from '../kernel/messages.ts';
import type { Guard, IncomingEvent } from './filter.ts';
import type { CloseResult, ReplyResult } from './sessions.ts';

/**
 * Routing tests over registerHandlers: a captured fake Bolt app drives the
 * REAL GateKeeper and the REAL GateRelay (over an in-memory registry), so
 * the two invariants that only lived as comments — a pending 🚦 gate eats
 * the thread reply, and a close denies the pending gate before the close
 * runs — are pinned where they are enforced.
 */

const CHANNEL = 'C0EXAMPLE123';
const THREAD = '1751970000.000100';
const ROOT_TS = '1751970005.000500';
const USER = 'U0ALLOWED';
const BOT = 'U0BOT';
const OTHER = 'U0STRANGER';

const GUARD: Guard = { channelId: CHANNEL, allowedUserId: USER, botUserId: BOT };

/** Captures the handlers exactly as Bolt would hold them. */
class FakeBoltApp implements SlackApp {
  posts: Array<{ channel: string; thread_ts: string; text: string }> = [];
  private readonly handlers = new Map<string, (args: { event: unknown }) => Promise<void>>();
  private errorHandler: ((error: Error) => Promise<void>) | undefined;

  event(name: 'app_mention' | 'message', handler: (args: { event: unknown }) => Promise<void>): void {
    this.handlers.set(name, handler);
  }

  error(handler: (error: Error) => Promise<void>): void {
    this.errorHandler = handler;
  }

  client = {
    chat: {
      postMessage: (args: { channel: string; thread_ts: string; text: string }): Promise<unknown> => {
        this.posts.push(args);
        return Promise.resolve({ ok: true });
      },
    },
  };

  emit(name: 'app_mention' | 'message', event: IncomingEvent): Promise<void> {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new Error(`no handler registered for ${name}`);
    return handler({ event });
  }

  hasErrorHandler(): boolean {
    return this.errorHandler !== undefined;
  }
}

class FakeSessions implements SessionGateway {
  opened: Array<{ threadTs: string; channelId: string; rootUser: string; text: string }> = [];
  replies: Array<{ threadTs: string; channelId: string; text: string }> = [];
  closes: Array<{ threadTs: string; channelId: string }> = [];

  open(threadTs: string, channelId: string, rootUser: string, text: string): void {
    this.opened.push({ threadTs, channelId, rootUser, text });
  }

  reply(threadTs: string, channelId: string, text: string): ReplyResult {
    this.replies.push({ threadTs, channelId, text });
    return 'turn';
  }

  close(threadTs: string, channelId: string): CloseResult {
    this.closes.push({ threadTs, channelId });
    return 'closing';
  }
}

const makeHarness = () => {
  const logger = createLogger('silent');
  const app = new FakeBoltApp();
  const sessions = new FakeSessions();
  const store = new DelegationStore(':memory:');
  const gatePosts: Array<{ threadTs: string; text: string }> = [];
  const gates = new GateKeeper({
    allowedUserId: USER,
    post: (threadTs, text) => {
      gatePosts.push({ threadTs, text });
      return Promise.resolve('gate-ts-1');
    },
    logger,
  });
  const surface: Surface = {
    post: () => Promise.resolve('ts-1'),
    update: () => Promise.resolve(),
    react: () => Promise.resolve(),
    unreact: () => Promise.resolve(),
  };
  const relay = new GateRelay({
    store,
    surface: new ThreadSurface({
      surface,
      store,
      logger,
      run: () => Promise.reject(new Error('no orca in this test')),
    }),
    logger,
  });
  registerHandlers(app, GUARD, sessions, gates, relay, logger);
  return { app, sessions, store, gates, gatePosts };
};

const threadReply = (text: string, user: string = USER): IncomingEvent => ({
  type: 'message',
  channel: CHANNEL,
  user,
  ts: '1751970009.000900',
  thread_ts: THREAD,
  text,
});

describe('registerHandlers — gate-eats-reply', () => {
  it('a pending 🚦 gate consumes the thread reply before it becomes a session turn', async () => {
    const { app, sessions, gates } = makeHarness();
    const verdict = gates.request(THREAD, '🚦 `git push` — go?');

    await app.emit('message', threadReply('go'));

    await expect(verdict).resolves.toEqual({ approved: true, reply: 'go' });
    expect(sessions.replies).toEqual([]);
  });

  it('a denial reply is consumed the same way, verbatim', async () => {
    const { app, sessions, gates } = makeHarness();
    const verdict = gates.request(THREAD, '🚦 `git push` — go?');

    await app.emit('message', threadReply('wait, rebase first'));

    await expect(verdict).resolves.toEqual({ approved: false, reply: 'wait, rebase first' });
    expect(sessions.replies).toEqual([]);
  });

  it('with no gate pending, the reply becomes a turn carrying the relayed-gates context', async () => {
    const { app, sessions, store } = makeHarness();
    store.recordGate({
      msgId: 'msg_1',
      threadTs: THREAD,
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      workerHandle: 'term_w1',
      worktreeName: 'webapp-84-csv-export',
      kind: 'decision_gate',
      question: 'Which directory should the export live in?',
      options: ['app/', 'lib/'],
      relayTs: '1751970002.000300',
    });

    await app.emit('message', threadReply('use app/ please'));

    expect(sessions.replies).toHaveLength(1);
    const text = sessions.replies[0]?.text ?? '';
    expect(text).toContain('[relayed worker gates');
    expect(text).toContain('Which directory should the export live in?');
    expect(text.endsWith('use app/ please')).toBe(true);
  });

  it('a plain reply in a thread with no relayed gates passes through untouched', async () => {
    const { app, sessions } = makeHarness();
    await app.emit('message', threadReply('what is the status?'));
    expect(sessions.replies).toEqual([
      { threadTs: THREAD, channelId: CHANNEL, text: 'what is the status?' },
    ]);
  });
});

describe('registerHandlers — close-denies-gate', () => {
  it('"close" while a 🚦 is pending denies the gate with the word verbatim, then still closes', async () => {
    const { app, sessions, gates } = makeHarness();
    const verdict = gates.request(THREAD, '🚦 `git push` — go?');

    await app.emit('message', threadReply('close'));

    await expect(verdict).resolves.toEqual({ approved: false, reply: 'close' });
    expect(sessions.closes).toEqual([{ threadTs: THREAD, channelId: CHANNEL }]);
    expect(sessions.replies).toEqual([]);
  });

  it('"close" with no gate pending just closes', async () => {
    const { app, sessions } = makeHarness();
    await app.emit('message', threadReply('close'));
    expect(sessions.closes).toEqual([{ threadTs: THREAD, channelId: CHANNEL }]);
  });
});

describe('registerHandlers — routing', () => {
  it('a root mention by the authorized user opens the session with the mention stripped', async () => {
    const { app, sessions } = makeHarness();
    await app.emit('app_mention', {
      type: 'app_mention',
      channel: CHANNEL,
      user: USER,
      ts: ROOT_TS,
      text: `<@${BOT}> deploy the csv fix`,
    });
    expect(sessions.opened).toEqual([
      { threadTs: ROOT_TS, channelId: CHANNEL, rootUser: USER, text: 'deploy the csv fix' },
    ]);
  });

  it('a third-party root mention gets the fixed refusal line and never a session', async () => {
    const { app, sessions } = makeHarness();
    await app.emit('app_mention', {
      type: 'app_mention',
      channel: CHANNEL,
      user: OTHER,
      ts: ROOT_TS,
      text: `<@${BOT}> hello`,
    });
    expect(app.posts).toEqual([
      { channel: CHANNEL, thread_ts: ROOT_TS, text: refusalLine(USER) },
    ]);
    expect(sessions.opened).toEqual([]);
  });

  it('a third-party thread reply is silence — not eaten, not a turn, not refused', async () => {
    const { app, sessions, gates } = makeHarness();
    const verdict = gates.request(THREAD, '🚦 `git push` — go?');

    await app.emit('message', threadReply('go', OTHER));

    expect(sessions.replies).toEqual([]);
    expect(app.posts).toEqual([]);
    // The stranger's "go" resolved nothing: the gate still waits for the
    // authorized user.
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(true);
    await expect(verdict).resolves.toEqual({ approved: true, reply: 'go' });
  });

  it('registers the Bolt error hook', () => {
    const { app } = makeHarness();
    expect(app.hasErrorHandler()).toBe(true);
  });
});

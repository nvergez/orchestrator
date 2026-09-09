import { classifyEvent, type Guard, type IncomingEvent } from './filter.ts';
import { refusalLine } from '../kernel/messages.ts';
import type { GateResolver } from './gate.ts';
import type { Logger } from '../kernel/logger.ts';
import type { CloseResult, ReplyResult } from './sessions.ts';
import { readThreadContext } from './thread-context.ts';

/**
 * The slice of the Bolt App the router registers on — event subscription,
 * the error hook, and the refusal post. daemon.ts passes the real `App`;
 * app.test.ts a captured fake that invokes the handlers with synthetic
 * events.
 */
export interface SlackApp {
  event(
    name: 'app_mention' | 'message',
    handler: (args: { event: unknown }) => Promise<void>,
  ): void;
  error(handler: (error: Error) => Promise<void>): void;
  client: {
    conversations: {
      replies(args: { channel: string; ts: string; latest: string; inclusive: boolean; limit: number; cursor?: string }): Promise<{
        ok?: boolean;
        error?: string;
        messages?: Array<{ ts?: string; user?: string; text?: string }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>;
    };
    chat: {
      postMessage(args: {
        channel: string;
        thread_ts: string;
        text: string;
      }): Promise<unknown>;
    };
  };
}

/** The slice of SessionManager the event handlers drive. */
export interface SessionGateway {
  open(threadTs: string, channelId: string, rootUser: string, text: string): void;
  reply(threadTs: string, channelId: string, text: string): ReplyResult;
  close(threadTs: string, channelId: string): CloseResult;
}

/** The slice of the gate relay the reply path decorates turns through (#21). */
export interface ReplyDecorator {
  /** Prepends the thread's relayed-gates registry; a no-op without gates. */
  decorateReply(threadTs: string, channelId: string, text: string): string;
}

const REPLY_LOG_LINES: Record<ReplyResult, string> = {
  turn: 'thread reply — resuming session',
  closed: 'reply in closed thread — fixed line posted',
  unregistered: 'reply in unregistered thread ignored',
};

const CLOSE_LOG_LINES: Record<CloseResult, string> = {
  closing: 'close command — closing session',
  closed: 'close in already-closed thread — fixed line posted',
  unregistered: 'close in unregistered thread ignored',
};

/**
 * Routes every subscribed event through the filter: `app_mention`, plus the
 * message event of whichever channel type is pinned — `message.groups` for a
 * private channel, `message.channels` for a public one (#38). Both arrive as
 * `type: "message"`, so one listener covers either.
 */
export function registerHandlers(
  app: SlackApp,
  guard: Guard,
  sessions: SessionGateway,
  gates: GateResolver,
  relay: ReplyDecorator,
  logger: Logger,
): void {
  const handle = async ({ event }: { event: unknown }): Promise<void> => {
    // Slack's payload types for `message` are a union over subtypes, so field
    // access is awkward; the filter reads this flat envelope and tolerates
    // whatever fields are absent.
    const incoming = event as IncomingEvent;
    const decision = classifyEvent(incoming, guard);

    switch (decision.action) {
      case 'ignore':
        logger.debug(
          { type: incoming.type, ts: incoming.ts, reason: decision.reason },
          'event ignored',
        );
        return;
      case 'refuse':
        logger.info({ ts: incoming.ts, user: incoming.user }, 'third-party mention refused');
        await app.client.chat.postMessage({
          channel: decision.channelId,
          thread_ts: decision.threadTs,
          text: refusalLine(),
        });
        return;
      case 'open':
        logger.info(
          { threadTs: decision.threadTs, channelId: decision.channelId },
          'root mention — opening session',
        );
        sessions.open(decision.threadTs, decision.channelId, decision.userId, decision.text);
        return;
      case 'reply': {
        // A bare re-mention in an existing thread remains an empty no-op.
        // Only an unknown thread receives the "handle this thread" instruction.
        const replyText = decision.text;
        // A pending 🚦 gate eats the reply (spec §7): it resolves the
        // suspended tool call instead of becoming a new session turn. The
        // filter already guarantees only the authorized user gets here;
        // tryResolve re-checks the user as defense in depth.
        if (
          incoming.user !== undefined &&
          gates.tryResolve(decision.threadTs, decision.channelId, incoming.user, decision.text)
        ) {
          logger.info({ threadTs: decision.threadTs }, 'thread reply resolved a pending 🚦 gate');
          return;
        }
        // A thread that relayed worker gates carries its registry into the
        // turn (spec §6): the session routes the reply anchored on it.
        const result = sessions.reply(
          decision.threadTs,
          decision.channelId,
          relay.decorateReply(decision.threadTs, decision.channelId, replyText),
        );
        if (result === 'unregistered' && decision.mentioned) {
          let context = '';
          try {
            context = await readThreadContext(app.client.conversations, decision.channelId, decision.threadTs, incoming.ts, guard.botUserId);
          } catch (error) {
            logger.warn({ err: error, threadTs: decision.threadTs }, 'earlier thread messages could not be read');
            // Open even if posting the notice also fails.
            await app.client.chat.postMessage({
              channel: decision.channelId,
              thread_ts: decision.threadTs,
              text: '⚠️ Earlier messages could not be read; continuing with your mention alone.',
            }).catch((err: unknown) => logger.warn({ err }, 'thread context notice failed'));
          }
          sessions.open(decision.threadTs, decision.channelId, decision.userId,
            context + (decision.text || 'Handle this thread.'));
        }
        // Fixed-line posts are user-visible events (info); the rest is
        // ambient routing (debug).
        if (result === 'closed') {
          logger.info({ threadTs: decision.threadTs, result }, REPLY_LOG_LINES[result]);
        } else {
          logger.debug({ threadTs: decision.threadTs, result }, REPLY_LOG_LINES[result]);
        }
        return;
      }
      case 'close': {
        // "@orchestrator close" while a 🚦 gate is pending denies the gate
        // first (the word travels back verbatim), so the suspended turn can
        // wrap up before the queued close runs — never a mid-turn kill.
        if (
          incoming.user !== undefined &&
          gates.tryResolve(decision.threadTs, decision.channelId, incoming.user, 'close')
        ) {
          logger.info({ threadTs: decision.threadTs }, 'close command denied a pending 🚦 gate');
        }
        const result = sessions.close(decision.threadTs, decision.channelId);
        if (result === 'unregistered') {
          logger.debug({ threadTs: decision.threadTs, result }, CLOSE_LOG_LINES[result]);
        } else {
          logger.info({ threadTs: decision.threadTs, result }, CLOSE_LOG_LINES[result]);
        }
        return;
      }
    }
  };

  // Thread reads are async; queue same-thread events so a second mention or
  // reply cannot overtake the opener before the session is registered.
  const pending = new Map<string, Promise<void>>();
  const ordered = (args: { event: unknown }): Promise<void> => {
    const event = args.event as IncomingEvent;
    const key = `${event.channel}:${event.thread_ts ?? event.ts}`;
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => handle(args));
    pending.set(key, next);
    void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => undefined);
    return next;
  };
  app.event('app_mention', ordered);
  app.event('message', ordered);
  app.error((error) => {
    logger.error({ err: error }, 'unhandled Bolt error');
    return Promise.resolve();
  });
}

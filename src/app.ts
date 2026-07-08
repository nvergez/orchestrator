import type { App } from '@slack/bolt';
import { classifyEvent, type Guard, type IncomingEvent } from './filter.ts';
import { refusalLine } from './messages.ts';
import type { GateResolver } from './gate.ts';
import type { Logger } from './logger.ts';
import type { CloseResult, ReplyResult } from './sessions.ts';

/** The slice of SessionManager the event handlers drive. */
export interface SessionGateway {
  open(threadTs: string, channelId: string, rootUser: string, text: string): void;
  reply(threadTs: string, channelId: string, text: string): ReplyResult;
  close(threadTs: string, channelId: string): CloseResult;
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

/** Routes every subscribed event (app_mention, message.channels) through the filter. */
export function registerHandlers(
  app: App,
  guard: Guard,
  sessions: SessionGateway,
  gates: GateResolver,
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
          channel: guard.channelId,
          thread_ts: decision.threadTs,
          text: refusalLine(guard.allowedUserId),
        });
        return;
      case 'open':
        logger.info({ threadTs: decision.threadTs }, 'root mention — opening session');
        sessions.open(
          decision.threadTs,
          guard.channelId,
          incoming.user ?? guard.allowedUserId,
          decision.text,
        );
        return;
      case 'reply': {
        // A pending 🚦 gate eats the reply (spec §7): it resolves the
        // suspended tool call instead of becoming a new session turn. The
        // filter already guarantees only the authorized user gets here;
        // tryResolve re-checks the user as defense in depth.
        if (
          incoming.user !== undefined &&
          gates.tryResolve(decision.threadTs, incoming.user, decision.text)
        ) {
          logger.info({ threadTs: decision.threadTs }, 'thread reply resolved a pending 🚦 gate');
          return;
        }
        const result = sessions.reply(decision.threadTs, guard.channelId, decision.text);
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
          gates.tryResolve(decision.threadTs, incoming.user, 'close')
        ) {
          logger.info({ threadTs: decision.threadTs }, 'close command denied a pending 🚦 gate');
        }
        const result = sessions.close(decision.threadTs, guard.channelId);
        if (result === 'unregistered') {
          logger.debug({ threadTs: decision.threadTs, result }, CLOSE_LOG_LINES[result]);
        } else {
          logger.info({ threadTs: decision.threadTs, result }, CLOSE_LOG_LINES[result]);
        }
        return;
      }
    }
  };

  app.event('app_mention', handle);
  app.event('message', handle);
  app.error((error) => {
    logger.error({ err: error }, 'unhandled Bolt error');
    return Promise.resolve();
  });
}

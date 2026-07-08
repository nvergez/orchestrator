import type { App } from '@slack/bolt';
import { classifyEvent, type Guard, type IncomingEvent } from './filter.ts';
import { refusalLine } from './messages.ts';
import type { Logger } from './logger.ts';

/** The slice of SessionManager the event handlers drive. */
export interface SessionGateway {
  open(threadTs: string, channelId: string, rootUser: string, text: string): void;
  reply(threadTs: string, channelId: string, text: string): boolean;
}

/** Routes every subscribed event (app_mention, message.channels) through the filter. */
export function registerHandlers(
  app: App,
  guard: Guard,
  sessions: SessionGateway,
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
        const handled = sessions.reply(decision.threadTs, guard.channelId, decision.text);
        logger.debug(
          { threadTs: decision.threadTs, handled },
          handled ? 'thread reply — resuming session' : 'reply in unregistered thread ignored',
        );
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

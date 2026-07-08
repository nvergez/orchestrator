import type { App } from '@slack/bolt';
import { classifyEvent, type Guard, type IncomingEvent } from './filter.ts';
import { ACK_TEXT, refusalLine } from './messages.ts';
import type { Logger } from './logger.ts';

/** Routes every subscribed event (app_mention, message.channels) through the filter. */
export function registerHandlers(app: App, guard: Guard, logger: Logger): void {
  const handle = async ({ event }: { event: unknown }): Promise<void> => {
    // Slack's payload types for `message` are a union over subtypes, so field
    // access is awkward; the filter reads this flat envelope and tolerates
    // whatever fields are absent.
    const incoming = event as IncomingEvent;
    const decision = classifyEvent(incoming, guard);

    if (decision.action === 'ignore') {
      logger.debug(
        { type: incoming.type, ts: incoming.ts, reason: decision.reason },
        'event ignored',
      );
      return;
    }

    logger.info(
      { type: incoming.type, ts: incoming.ts, user: incoming.user, action: decision.action },
      'replying in thread',
    );
    await app.client.chat.postMessage({
      channel: guard.channelId,
      thread_ts: decision.threadTs,
      text: decision.action === 'ack' ? ACK_TEXT : refusalLine(guard.allowedUserId),
    });
  };

  app.event('app_mention', handle);
  app.event('message', handle);
  app.error((error) => {
    logger.error({ err: error }, 'unhandled Bolt error');
    return Promise.resolve();
  });
}

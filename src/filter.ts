/**
 * The event filter — the gate every Slack event passes before anything else
 * happens (spec §2/§7). Pure: no Slack client, no I/O, fully unit-testable.
 */

/** The fields of a Slack `app_mention` / `message` event the filter rules on. */
export interface IncomingEvent {
  type: 'app_mention' | 'message';
  channel?: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

/** The identities the filter guards with, straight from config + auth.test. */
export interface Guard {
  channelId: string;
  allowedUserId: string;
  botUserId: string;
}

export type Decision =
  | { action: 'ack'; threadTs: string }
  | { action: 'refuse'; threadTs: string }
  | { action: 'ignore'; reason: string };

export function classifyEvent(event: IncomingEvent, guard: Guard): Decision {
  if (event.channel !== guard.channelId) {
    return { action: 'ignore', reason: 'wrong_channel' };
  }
  if (event.subtype !== undefined) {
    return { action: 'ignore', reason: 'subtype' };
  }
  if (event.bot_id !== undefined) {
    return { action: 'ignore', reason: 'bot_message' };
  }
  if (event.user === guard.botUserId) {
    return { action: 'ignore', reason: 'self' };
  }
  if (event.user === undefined) {
    return { action: 'ignore', reason: 'no_user' };
  }
  if (event.type !== 'app_mention') {
    // message.channels events never open anything in this slice; mentions
    // arrive separately as app_mention, so this also prevents double replies.
    return { action: 'ignore', reason: 'not_a_mention' };
  }

  const threadTs = event.thread_ts ?? event.ts;
  if (event.user === guard.allowedUserId) {
    return { action: 'ack', threadTs };
  }
  return { action: 'refuse', threadTs };
}

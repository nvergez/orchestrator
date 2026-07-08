/**
 * The event filter — the gate every Slack event passes before anything else
 * happens (spec §2/§3/§7). Pure: no Slack client, no I/O, fully unit-testable.
 * It decides *what kind* of turn an event is; whether the thread is actually
 * registered is the session manager's call (it owns the SQLite registry).
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
  text?: string;
}

/** The identities the filter guards with, straight from config + auth.test. */
export interface Guard {
  channelId: string;
  allowedUserId: string;
  botUserId: string;
}

export type IgnoreReason =
  | 'wrong_channel'
  | 'subtype'
  | 'bot_message'
  | 'self'
  | 'no_user'
  | 'not_a_mention'
  | 'third_party_in_thread'
  | 'mention_duplicate'
  | 'empty_text';

export type Decision =
  /** Root @mention by the authorized user — register the thread, first turn. */
  | { action: 'open'; threadTs: string; text: string }
  /** Authorized-user message inside a thread — a turn iff the thread is registered. */
  | { action: 'reply'; threadTs: string; text: string }
  /** `@orchestrator close` inside a thread — the explicit close command (spec §3). */
  | { action: 'close'; threadTs: string }
  /** Root @mention by a third party — one polite fixed line (UX mock G1). */
  | { action: 'refuse'; threadTs: string }
  | { action: 'ignore'; reason: IgnoreReason };

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

  const botTag = `<@${guard.botUserId}>`;
  if (event.type === 'message') {
    if (event.text?.includes(botTag) === true) {
      // A mention fires both message.channels and app_mention for the same
      // Slack message; acting on the app_mention copy only prevents doubled
      // turns.
      return { action: 'ignore', reason: 'mention_duplicate' };
    }
    if (event.thread_ts === undefined) {
      // A root channel message never opens anything — spec §3: no mention,
      // no session.
      return { action: 'ignore', reason: 'not_a_mention' };
    }
    if (event.user !== guard.allowedUserId) {
      return { action: 'ignore', reason: 'third_party_in_thread' };
    }
    const replyText = (event.text ?? '').trim();
    if (replyText === '') {
      // Attachment-only or whitespace replies never become empty Claude turns.
      return { action: 'ignore', reason: 'empty_text' };
    }
    return { action: 'reply', threadTs: event.thread_ts, text: replyText };
  }

  // app_mention from here on.
  if (event.user !== guard.allowedUserId) {
    if (event.thread_ts !== undefined) {
      // The polite refusal is for *root* mentions only (UX mock G1). Anything
      // a third party posts inside a thread is silence, per spec §7 — never
      // injected, and no "I'm ignoring you" polluting the thread.
      return { action: 'ignore', reason: 'third_party_in_thread' };
    }
    return { action: 'refuse', threadTs: event.ts };
  }

  const text = (event.text ?? '').replaceAll(botTag, '').trim();
  if (event.thread_ts !== undefined) {
    if (text === '') {
      return { action: 'ignore', reason: 'empty_text' };
    }
    if (isCloseCommand(text)) {
      return { action: 'close', threadTs: event.thread_ts };
    }
    return { action: 'reply', threadTs: event.thread_ts, text };
  }
  // A bare root mention is still an Open (spec §3: a root @mention is the one
  // and only opener) — substitute a fixed prompt rather than an empty turn.
  return { action: 'open', threadTs: event.ts, text: text === '' ? BARE_MENTION_PROMPT : text };
}

/**
 * The close command is the mention plus the bare word (spec §3: explicit
 * `@orchestrator close`, thread-only — a root "close" mention just opens a
 * session). A mention-less "close" reply stays an ordinary turn, and any
 * longer sentence goes to the session to interpret.
 */
function isCloseCommand(text: string): boolean {
  return text.toLowerCase().replace(/[.!]+$/, '').trim() === 'close';
}

/** What the session gets when the thread opened on a mention with no words. */
export const BARE_MENTION_PROMPT =
  '(The user opened this thread by mentioning you without any message. ' +
  'Greet them briefly and ask what they need.)';

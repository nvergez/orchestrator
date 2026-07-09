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
  blocks?: SlackBlock[];
}

/** The slice of Slack's block structure the text extractor walks. */
interface SlackBlock {
  type?: string;
  elements?: SlackBlock[];
  text?: string;
  user_id?: string;
  url?: string;
  name?: string;
}

/**
 * The human's words, extracted from `rich_text` blocks — never from `context`
 * blocks, where clients append decorations ("*Sent with* @App" footers). Text
 * pulled from `event.text` includes those footers, which breaks exact-match
 * commands and lets the model hallucinate around them (issue #41). Falls back
 * to `event.text` when no rich_text block exists (plain API posts).
 */
export function humanText(event: IncomingEvent): string {
  const richTextBlocks = (event.blocks ?? []).filter((b) => b.type === 'rich_text');
  if (richTextBlocks.length === 0) return event.text ?? '';
  const parts: string[] = [];
  const walk = (el: SlackBlock): void => {
    if (el.type === 'text' && el.text !== undefined) parts.push(el.text);
    // Mentions re-render as <@ID> so the botTag rules below keep working on
    // extracted text exactly as they did on event.text.
    else if (el.type === 'user' && el.user_id !== undefined) parts.push(`<@${el.user_id}>`);
    else if (el.type === 'link') parts.push(el.text ?? el.url ?? '');
    else if (el.type === 'emoji' && el.name !== undefined) parts.push(`:${el.name}:`);
    else if (el.elements !== undefined) el.elements.forEach(walk);
  };
  richTextBlocks.forEach(walk);
  return parts.join('');
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
  const spokenText = humanText(event);
  if (event.type === 'message') {
    if (spokenText.includes(botTag)) {
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
    const replyText = spokenText.trim();
    if (replyText === '') {
      // Attachment-only or whitespace replies never become empty Claude turns.
      return { action: 'ignore', reason: 'empty_text' };
    }
    if (isCloseCommand(replyText)) {
      return { action: 'close', threadTs: event.thread_ts };
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

  const text = spokenText.replaceAll(botTag, '').trim();
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
 * The close command is the bare word inside a thread, with or without the
 * mention (spec §3). It was mention-only while mention-less replies never
 * reached the daemon (#38); now that they do, requiring the mention was pure
 * ceremony. Thread-only still: a root "close" mention opens a session, and a
 * mention-less root message opens nothing. Any longer sentence containing the
 * word goes to the session to interpret, and the authorized-user and
 * third-party guards upstream decide who may say it.
 */
function isCloseCommand(text: string): boolean {
  return text.toLowerCase().replace(/[.!]+$/, '').trim() === 'close';
}

/** What the session gets when the thread opened on a mention with no words. */
export const BARE_MENTION_PROMPT =
  '(The user opened this thread by mentioning you without any message. ' +
  'Greet them briefly and ask what they need.)';

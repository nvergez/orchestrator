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
  files?: SlackFile[];
}

/** Metadata delivered with a Slack message; only accepted images are saved. */
export interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  original_w?: number | string;
  original_h?: number | string;
  url_private_download?: string;
  url_private?: string;
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
  /** The channels the daemon serves (issue #93) — anything else is noise. */
  channelIds: readonly string[];
  /** The authorized humans (issue #93) — one shared allow-list, no tiers. */
  allowedUserIds: readonly string[];
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
  /** Root @mention by an allowed user — register the thread, first turn. */
  | { action: 'open'; threadTs: string; channelId: string; userId: string; text: string; files?: SlackFile[] }
  /** Allowed-user message inside a thread — a turn iff the thread is registered. */
  | { action: 'reply'; threadTs: string; channelId: string; text: string; userId: string; mentioned: boolean; files?: SlackFile[] }
  /** `@orchestrator close` inside a thread — the explicit close command (spec §3). */
  | { action: 'close'; threadTs: string; channelId: string }
  /** A bare memory command inside a thread (issue #120) — deterministic and
   * model-free, so forgetting still works when the session is confused. */
  | { action: 'memory'; threadTs: string; channelId: string; userId: string; command: MemoryCommand }
  /** Root @mention by a third party — one polite fixed line (UX mock G1). */
  | { action: 'refuse'; threadTs: string; channelId: string }
  | { action: 'ignore'; reason: IgnoreReason };

/** What a bare memory command asks for. `forget` names an id the speaker was
 * shown; `forget_me` purges their portrait and tombstones them; `remember_me`
 * lifts that tombstone — nothing purged comes back. */
export type MemoryCommand =
  | { kind: 'forget'; memoryId: string }
  | { kind: 'forget_me' }
  | { kind: 'remember_me' };

export function classifyEvent(event: IncomingEvent, guard: Guard): Decision {
  if (event.channel === undefined || !guard.channelIds.includes(event.channel)) {
    return { action: 'ignore', reason: 'wrong_channel' };
  }
  const channelId = event.channel;
  if (event.subtype !== undefined && event.subtype !== 'file_share') {
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
  const files = event.files?.length ? { files: event.files } : {};
  if (event.type === 'message') {
    if (spokenText.includes(botTag)) {
      // A mention fires both the message event and app_mention for the same
      // Slack message; acting on the app_mention copy only prevents doubled
      // turns. Dead code until #38 (the message event never arrived), and the
      // guard that keeps mentions to one turn now that it does.
      return { action: 'ignore', reason: 'mention_duplicate' };
    }
    if (event.thread_ts === undefined) {
      // A root channel message never opens anything — spec §3: no mention,
      // no session.
      return { action: 'ignore', reason: 'not_a_mention' };
    }
    if (!guard.allowedUserIds.includes(event.user)) {
      return { action: 'ignore', reason: 'third_party_in_thread' };
    }
    const replyText = spokenText.trim();
    if (replyText === '' && !files.files) {
      // Whitespace without files never becomes an empty Claude turn.
      return { action: 'ignore', reason: 'empty_text' };
    }
    if (isCloseCommand(replyText)) {
      return { action: 'close', threadTs: event.thread_ts, channelId };
    }
    const memory = memoryCommand(replyText);
    if (memory !== undefined) {
      return { action: 'memory', threadTs: event.thread_ts, channelId, userId: event.user, command: memory };
    }
    return { action: 'reply', threadTs: event.thread_ts, channelId, text: replyText, userId: event.user, mentioned: false, ...files };
  }

  // app_mention from here on.
  if (!guard.allowedUserIds.includes(event.user)) {
    if (event.thread_ts !== undefined) {
      // The polite refusal is for *root* mentions only (UX mock G1). Anything
      // a third party posts inside a thread is silence, per spec §7 — never
      // injected, and no "I'm ignoring you" polluting the thread.
      return { action: 'ignore', reason: 'third_party_in_thread' };
    }
    return { action: 'refuse', threadTs: event.ts, channelId };
  }

  const text = spokenText.replaceAll(botTag, '').trim();
  if (event.thread_ts !== undefined) {
    if (isCloseCommand(text)) {
      return { action: 'close', threadTs: event.thread_ts, channelId };
    }
    const memory = memoryCommand(text);
    if (memory !== undefined) {
      return { action: 'memory', threadTs: event.thread_ts, channelId, userId: event.user, command: memory };
    }
    return { action: 'reply', threadTs: event.thread_ts, channelId, text, userId: event.user, mentioned: true, ...files };
  }
  // A bare root mention is still an Open (spec §3: a root @mention is the one
  // and only opener) — substitute a fixed prompt rather than an empty turn.
  return {
    action: 'open',
    threadTs: event.ts,
    channelId,
    userId: event.user,
    text: text === '' && !files.files ? BARE_MENTION_PROMPT : text,
    ...files,
  };
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

/**
 * The short ids the portrait block renders — no vowels, no look-alikes, so a
 * human retypes one out of Slack without a second try. Matching the exact
 * alphabet is deliberate: anything else ("forget what I said") is a sentence,
 * not a command, and belongs to the session to interpret.
 */
const MEMORY_ID = /^[2-9bcdfghjkmnpqrstvwxz]{6}$/;

/**
 * The bare memory commands, beside the bare `close` word and read the same
 * way: thread-only, exact, and free of any model in the loop — deletion has
 * to work precisely when the session is confused about what it remembers.
 */
function memoryCommand(text: string): MemoryCommand | undefined {
  const words = text.toLowerCase().replace(/[.!]+$/, '').trim().split(/\s+/);
  if (words.length !== 2) return undefined;
  const [verb, target] = words as [string, string];
  if (verb === 'forget') {
    if (target === 'me') return { kind: 'forget_me' };
    return MEMORY_ID.test(target) ? { kind: 'forget', memoryId: target } : undefined;
  }
  if (verb === 'remember' && target === 'me') return { kind: 'remember_me' };
  return undefined;
}

/** What the session gets when the thread opened on a mention with no words. */
export const BARE_MENTION_PROMPT =
  '(The user opened this thread by mentioning you without any message. ' +
  'Greet them briefly and ask what they need.)';

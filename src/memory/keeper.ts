import type { Logger } from '../kernel/logger.ts';
import {
  DEFAULT_PORTRAIT_CAPS,
  promotable,
  renderLatecomerBlock,
  renderMemoryLine,
  renderPortraitBlock,
  type PortraitCaps,
} from './portrait.ts';
import { MAX_MEMORY_CHARS, type MemoryPass } from './pass.ts';
import type { MemoryRow, MemoryStore } from './store.ts';

/**
 * The memory keeper (issue #120, ADR 0009): the module's coordinator, and
 * the only object the composition root joins to the rest of the daemon.
 * Reading and writing both belong to the harness — the session neither
 * decides what is remembered nor when — so everything that decides either
 * lives here, behind seams the composition test can script.
 */

/** A thread the sweep might extract from, as the session store sees it. */
export interface QuietThread {
  threadTs: string;
  channelId: string;
  lastActivityAt: string;
}

/** Open sessions with nothing since the cutoff — the sweep's shortlist. */
export type QuietThreadReader = (cutoffIso: string) => QuietThread[];

/** The thread's delegation-ledger rows, already rendered as dated facts. */
export type WorkReader = (threadTs: string, channelId: string) => string[];

/** One Slack message as the pass reads it — the bot's own included. */
export interface TranscriptMessage {
  ts: string;
  userId: string | null;
  text: string;
  fromBot: boolean;
}

/** Reads a thread strictly after `sinceTs`, so a revival extracts only the new part. */
export type TranscriptReader = (
  channelId: string,
  threadTs: string,
  sinceTs: string,
) => Promise<TranscriptMessage[]>;

export interface MemoryKeeperOptions {
  store: MemoryStore;
  /** The feature flag; off leaves every path a no-op and writes nothing. */
  enabled: boolean;
  /** Only allow-listed people acquire a portrait (spec §12). */
  allowedUserIds: readonly string[];
  quietThreads: QuietThreadReader;
  readTranscript: TranscriptReader;
  workFacts: WorkReader;
  /** The pass itself — the real tool-less SDK query, or a scripted double. */
  runPass: MemoryPass;
  /** How long a thread must be quiet before it is worth extracting from. */
  silenceMs: number;
  /** Consecutive failures before the slice is abandoned with a log. */
  attemptLimit: number;
  caps: PortraitCaps;
  logger: Logger;
  now?: () => Date;
}

/** What a forget attempt did, in the words the Slack reply uses. */
export type ForgetOutcome = 'deleted' | 'not_yours' | 'unknown' | 'disabled';

/** Past this a thread's transcript stops informing the pass and starts costing. */
const MAX_TRANSCRIPT_CHARS = 24_000;

/**
 * How many moments one person keeps on disk. Rendering is bounded by the
 * caps; this is the other half — compaction retires the oldest moments so a
 * portrait that has been accumulating for a year is still worth reading.
 * Durable facts are never retired: they are the part that earns its keep.
 */
export const RETAINED_MOMENTS_PER_PERSON = 30;

/**
 * How many threads one sweep will extract from. Every pass is a model call,
 * and the day the feature is switched on every open thread is eligible at
 * once — this makes that a few sweeps rather than one bill. The rest are
 * still quiet at the next interval, so nothing is lost by waiting.
 */
const MAX_PASSES_PER_SWEEP = 5;

export class MemoryKeeper {
  readonly enabled: boolean;
  private readonly store: MemoryStore;
  private readonly allowedUserIds: readonly string[];
  private readonly quietThreads: QuietThreadReader;
  private readonly readTranscript: TranscriptReader;
  private readonly workFacts: WorkReader;
  private readonly runPass: MemoryPass;
  private readonly silenceMs: number;
  private readonly attemptLimit: number;
  private readonly caps: PortraitCaps;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private sweeping = false;

  constructor(options: MemoryKeeperOptions) {
    this.store = options.store;
    this.enabled = options.enabled;
    this.allowedUserIds = options.allowedUserIds;
    this.quietThreads = options.quietThreads;
    this.readTranscript = options.readTranscript;
    this.workFacts = options.workFacts;
    this.runPass = options.runPass;
    this.silenceMs = options.silenceMs;
    this.attemptLimit = options.attemptLimit;
    this.caps = options.caps ?? DEFAULT_PORTRAIT_CAPS;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The system-prompt block for a thread, built at spawn. Synchronous on
   * purpose: the spawn path returns synchronously and SQLite reads
   * synchronously, so nothing about the turn queue changes shape for this.
   */
  systemPromptBlock(threadTs: string, channelId: string): string {
    if (!this.enabled) return '';
    const portraits = this.store
      .participants(threadTs, channelId)
      .filter((row) => !this.store.isOptedOut(row.userId))
      .map((row) => ({ userId: row.userId, memories: this.store.listForPerson(row.userId) }));
    return renderPortraitBlock(portraits, this.now(), this.caps);
  }

  /**
   * Records that someone spoke, and returns their portrait when this is the
   * first time they speak in a thread that already had someone in it — the
   * latecomer path. It rides in that turn's text because refreshing the
   * system prompt would mean ending the subprocess, and `end()` denies
   * pending 🚦 gates and releases reserved worker slots on the way out
   * (ADR 0009). The next spawn promotes them into the prompt proper.
   */
  noteSpeaker(threadTs: string, channelId: string, userId: string): string {
    if (!this.enabled || !this.allowedUserIds.includes(userId)) return '';
    const before = this.store.participants(threadTs, channelId);
    this.store.noteParticipant(threadTs, channelId, userId);
    const latecomer = before.length > 0 && !before.some((row) => row.userId === userId);
    if (!latecomer || this.store.isOptedOut(userId)) return '';
    const block = renderLatecomerBlock(
      { userId, memories: this.store.listForPerson(userId) },
      this.now(),
      this.caps,
    );
    if (block !== '') this.store.markPortraitDelivered(threadTs, channelId, userId);
    return block;
  }

  /**
   * The sweep (spec §12): threads quiet for the silence mark with turns past
   * their watermark. Never per turn — a pass per message would both cost a
   * model call each time and extract half a joke.
   */
  async sweep(): Promise<number> {
    if (!this.enabled || this.sweeping) return 0;
    this.sweeping = true;
    try {
      const cutoff = new Date(this.now().getTime() - this.silenceMs).toISOString();
      let ran = 0;
      for (const thread of this.quietThreads(cutoff)) {
        if (ran >= MAX_PASSES_PER_SWEEP) break;
        const marks = this.store.extraction(thread.threadTs, thread.channelId);
        // Nothing said since the last pass: no Slack call, no model call.
        if (marks.activityMark >= thread.lastActivityAt) continue;
        await this.extract(thread.threadTs, thread.channelId, thread.lastActivityAt, 'silence');
        ran += 1;
      }
      return ran;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * An explicit close forces a pass at once: a deliberately ended
   * conversation is captured now rather than at the next sweep. Runs after
   * the 🔚 summary is posted and after the process and its slot are already
   * released, so the only thing it delays is bookkeeping.
   */
  async extractOnClose(threadTs: string, channelId: string): Promise<void> {
    if (!this.enabled) return;
    await this.extract(threadTs, channelId, this.now().toISOString(), 'close');
  }

  /**
   * The session's single write, and the human's `forget <id>` alike: delete
   * one memory, by an id that must belong to the asker's own portrait. An
   * invented id and another person's id are both refused, which is what
   * makes cross-person deletion structurally impossible rather than merely
   * discouraged.
   */
  forget(userId: string, memoryId: string): ForgetOutcome {
    if (!this.enabled) return 'disabled';
    const row = this.store.get(memoryId);
    if (row === undefined) return 'unknown';
    if (row.subjectUserId !== userId && !row.participantUserIds.includes(userId)) return 'not_yours';
    this.store.delete(memoryId);
    this.logger.info({ userId, memoryId }, 'memory forgotten');
    return 'deleted';
  }

  /**
   * The same deletion, reached from inside a session that was asked in plain
   * words. The asker is the thread's most recent human speaker — the session
   * never gets to name whose memory it is deleting.
   */
  forgetForThread(threadTs: string, channelId: string, memoryId: string): ForgetOutcome {
    if (!this.enabled) return 'disabled';
    const speaker = this.store.lastSpeaker(threadTs, channelId);
    if (speaker === undefined) return 'not_yours';
    return this.forget(speaker, memoryId);
  }

  /**
   * The session's Bash-borne request to forget something (ADR 0009). It is a
   * daemon action asked for through the one channel the session has, never a
   * command that runs: `canUseTool` answers it and nothing reaches a shell.
   * Declining leaves the classifier to rule on the command as usual.
   */
  forgetCommand(
    threadTs: string,
    channelId: string,
    command: string,
  ): { handled: false } | { handled: true; message: string } {
    const match = FORGET_COMMAND.exec(command);
    if (match === null) return { handled: false };
    const memoryId = match[1] ?? '';
    const outcome = this.forgetForThread(threadTs, channelId, memoryId);
    return { handled: true, message: SESSION_FORGET_REPLIES[outcome](memoryId) };
  }

  /** Stop remembering me: purge the portrait, leave the tombstone. */
  optOut(userId: string): number {
    if (!this.enabled) return 0;
    const purged = this.store.optOut(userId);
    this.logger.info({ userId, purged }, 'memory opt-out — portrait purged');
    return purged;
  }

  optIn(userId: string): void {
    if (!this.enabled) return;
    this.store.optIn(userId);
    this.logger.info({ userId }, 'memory opt-in — new memories may be written again');
  }

  /**
   * One pass over one thread. Every failure path ends here: nothing is ever
   * posted to the thread, nothing rethrows, and the daemon never goes down
   * because a model call did.
   */
  private async extract(
    threadTs: string,
    channelId: string,
    activityMark: string,
    trigger: 'silence' | 'close',
  ): Promise<void> {
    const marks = this.store.extraction(threadTs, channelId);
    const people = this.store
      .participants(threadTs, channelId)
      .map((row) => row.userId)
      .filter((userId) => this.allowedUserIds.includes(userId) && !this.store.isOptedOut(userId));
    if (people.length === 0) {
      this.store.advance(threadTs, channelId, marks.watermarkTs, activityMark);
      return;
    }

    try {
      const messages = await this.readTranscript(channelId, threadTs, marks.watermarkTs);
      if (messages.length === 0) {
        // Nothing new to read: not a failure, just a thread with no new slice.
        this.store.advance(threadTs, channelId, marks.watermarkTs, activityMark);
        return;
      }
      const result = await this.runPass({
        threadTs,
        channelId,
        transcript: renderTranscript(messages),
        work: this.workFacts(threadTs, channelId),
        participants: people,
        known: this.knownLines(people),
      });
      const written = this.absorb(result.memories, threadTs, channelId);
      const watermark = messages.reduce((latest, message) => (message.ts > latest ? message.ts : latest), marks.watermarkTs);
      this.store.advance(threadTs, channelId, watermark, activityMark);
      this.store.recordPass({
        threadTs,
        channelId,
        outcome: written > 0 ? 'wrote' : 'empty',
        written,
        dropped: result.dropped ?? 0,
        costUsd: result.costUsd,
      });
      this.logger.info({ threadTs, channelId, trigger, written, costUsd: result.costUsd }, 'memory pass finished');
    } catch (error) {
      this.onFailure(threadTs, channelId, activityMark, marks.watermarkTs, error);
    }
  }

  /**
   * A failed pass holds its slice for `attemptLimit` consecutive attempts,
   * then gives up on it with a log and moves on — so a thread the pass
   * cannot digest never becomes an infinite retry, and the next attempt
   * never repeats the same slice.
   */
  private onFailure(
    threadTs: string,
    channelId: string,
    activityMark: string,
    watermarkTs: string,
    error: unknown,
  ): void {
    const attempts = this.store.recordAttempt(threadTs, channelId);
    const abandoned = attempts >= this.attemptLimit;
    this.store.recordPass({
      threadTs,
      channelId,
      outcome: abandoned ? 'abandoned' : 'failed',
      written: 0,
      dropped: 0,
      costUsd: 0,
    });
    if (abandoned) {
      // The slice is what keeps failing, so the slice is what must go: the
      // watermark jumps to the activity mark's own instant, and the next
      // attempt reads only what was said after it.
      const skipped = slackTsFrom(activityMark);
      this.store.advance(threadTs, channelId, skipped > watermarkTs ? skipped : watermarkTs, activityMark);
      this.logger.error(
        { err: error, threadTs, channelId, attempts },
        'memory pass abandoned after repeated failures — the slice is skipped',
      );
      return;
    }
    this.logger.warn({ err: error, threadTs, channelId, attempts }, 'memory pass failed — will retry');
  }

  /**
   * Writes what survived validation. A draft that says again what is already
   * known bumps that memory's recurrence instead of duplicating it, and a
   * moment that has recurred enough is promoted to a durable fact — which is
   * exactly what a private joke is.
   */
  private absorb(drafts: readonly { subject: string; participants: string[]; nature: 'durable' | 'moment'; text: string }[], threadTs: string, channelId: string): number {
    let written = 0;
    for (const draft of drafts) {
      const existing = this.store.listForPerson(draft.subject).find((row) => sameThing(row.text, draft.text));
      if (existing !== undefined) {
        this.store.noteRecurrence(existing.id);
        continue;
      }
      const id = this.store.add({
        subjectUserId: draft.subject,
        participantUserIds: draft.participants,
        nature: draft.nature,
        text: draft.text.slice(0, MAX_MEMORY_CHARS),
        sourceThreadTs: threadTs,
        sourceChannelId: channelId,
      });
      if (id !== undefined) written += 1;
    }
    for (const subject of new Set(drafts.map((draft) => draft.subject))) this.compact(subject);
    return written;
  }

  /** Compaction: promote what keeps recurring, retire the oldest moments. */
  private compact(userId: string): void {
    const memories = this.store.listForPerson(userId).filter((row) => row.subjectUserId === userId);
    for (const id of promotable(memories)) {
      this.store.promote(id);
      this.logger.info({ userId, memoryId: id }, 'recurring moment promoted to a durable fact');
    }
    const moments = memories.filter((row) => row.nature === 'moment');
    for (const retired of moments.slice(0, Math.max(0, moments.length - RETAINED_MOMENTS_PER_PERSON))) {
      this.store.delete(retired.id);
    }
  }

  /** What the pass is told it already knows, so it does not write it twice. */
  private knownLines(people: readonly string[]): string[] {
    const now = this.now();
    return people.flatMap((userId) => {
      const memories = this.store.listForPerson(userId);
      if (memories.length === 0) return [];
      return [`${userId}:`, ...memories.map((memory) => renderMemoryLine(memory, now))];
    });
  }
}

/** The session's one write, exactly as the portrait block spells it. */
const FORGET_COMMAND = /^\s*orc\s+memory\s+forget\s+([A-Za-z0-9]{1,32})\s*$/;

/**
 * What comes back to the session. Written as a tool result rather than a
 * Slack line: the session still owes the human a sentence in its own voice,
 * and these say what happened without dictating how to say it.
 */
const SESSION_FORGET_REPLIES: Record<ForgetOutcome, (memoryId: string) => string> = {
  deleted: (id) => `Forgotten: the memory ${id} is gone, from every portrait it was in. Tell them in one short line.`,
  not_yours: (id) =>
    `Refused: ${id} is not a memory about the person who just spoke, and you can only forget what was shown about them. Say so plainly and do not try another id.`,
  unknown: (id) =>
    `Refused: there is no memory ${id}. Only the ids in brackets in what-you-know exist — do not guess another one.`,
  disabled: () => 'Refused: memory is turned off; there is nothing to forget.',
};

/** A Slack ts for an instant the daemon knows in ISO — Slack's message ids
 * are epoch seconds, so this slices a transcript exactly. */
function slackTsFrom(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '0' : (at / 1000).toFixed(6);
}

/**
 * Whether two memories say the same thing. It has to be a loose overlap
 * rather than equality: the pass rephrases every time it sees a joke again,
 * and a portrait that accumulates four wordings of one joke is worse than
 * one that merges two related frictions into a single recurring one. So the
 * bar is deliberately generous — half the shorter memory's substantial words,
 * at least three of them — and the failure it chooses is the merge.
 *
 * Words of three letters or fewer are dropped rather than stopword-listed:
 * a list would be one language's, and the operator's voice may be another's.
 */
const SUBSTANTIAL_WORD = 4;
const SAME_THING_OVERLAP = 0.5;
const SAME_THING_MIN_SHARED = 3;

export function sameThing(a: string, b: string): boolean {
  const words = (text: string): Set<string> =>
    new Set(
      text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
        .filter((word) => word.length >= SUBSTANTIAL_WORD),
    );
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (
    shared >= SAME_THING_MIN_SHARED &&
    shared / Math.min(left.size, right.size) >= SAME_THING_OVERLAP
  );
}

/**
 * The transcript as the pass reads it: the bot's own messages included and
 * marked as its own, newest kept when the slice is long. `readThreadContext`
 * deliberately skips the bot — this is a variant of it, not a reuse.
 */
function renderTranscript(messages: readonly TranscriptMessage[]): string[] {
  const lines = messages.map((message) => {
    const who = message.fromBot ? 'you' : `<@${message.userId ?? 'unknown'}>`;
    return `${who}: ${message.text.replace(/[\r\n\u2028\u2029]+/g, ' ')}`;
  });
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  while (total > MAX_TRANSCRIPT_CHARS && lines.length > 1) {
    total -= (lines.shift()?.length ?? 0) + 1;
  }
  return lines;
}

/** Re-exported so the composition root never needs the row type twice. */
export type { MemoryRow };

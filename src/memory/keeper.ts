import type { ForgetOutcome } from '../kernel/messages.ts';
import type { Logger } from '../kernel/logger.ts';
import {
  DEFAULT_PORTRAIT_CAPS,
  promotable,
  renderLatecomerBlock,
  renderMemoryLine,
  renderPortraitBlock,
  type PortraitCaps,
} from './portrait.ts';
import { MAX_MEMORY_CHARS, type DraftMemory, type MemoryPass } from './pass.ts';
import type { ExtractionRow, MemoryStore } from './store.ts';

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
  caps?: PortraitCaps;
  logger: Logger;
  now?: () => Date;
}

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
  /**
   * Per thread: the ids actually rendered into something the session read,
   * and the authors of the turn it is running. Both are the deletion path's
   * evidence (spec §12) — what the session was shown, and whose words it is
   * acting on — and both are process-local on purpose: they describe a live
   * session, and a restart re-establishes them at the next spawn and turn.
   */
  private readonly shownIds = new Map<string, Set<string>>();
  private readonly turnSpeakers = new Map<string, string[]>();
  /** One extraction at a time per thread, close and sweep sharing the queue. */
  private readonly extractions = new Map<string, Promise<void>>();

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
    const block = renderPortraitBlock(portraits, this.now(), this.caps);
    this.noteShown(threadTs, channelId, block.shownIds);
    return block.text;
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
    // Once per person per thread falls out of the participant row above: by
    // their second message they are in `before`, and this never runs again.
    const block = renderLatecomerBlock(
      { userId, memories: this.store.listForPerson(userId) },
      this.now(),
      this.caps,
    );
    this.noteShown(threadTs, channelId, block.shownIds);
    return block.text;
  }

  /**
   * The authors of the turn a thread is about to run — every person whose
   * messages the session is reading, because a batch can carry several
   * (issue #117). The deletion the session may ask for during that turn
   * belongs to them and nobody else: arrival timestamps cannot say who
   * spoke, since messages that queued behind a slow turn or a slot wait
   * share a turn however far apart they were sent.
   */
  noteTurnSpeakers(threadTs: string, channelId: string, userIds: readonly string[]): void {
    if (!this.enabled) return;
    this.turnSpeakers.set(threadKey(threadTs, channelId), [...new Set(userIds)]);
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
      const swept = new Set<string>();
      let ran = 0;
      for (const thread of this.quietThreads(cutoff)) {
        if (ran >= MAX_PASSES_PER_SWEEP) break;
        const marks = this.store.extraction(thread.threadTs, thread.channelId);
        // Nothing said since the last pass: no Slack call, no model call.
        if (marks.activityMark >= thread.lastActivityAt) continue;
        swept.add(threadKey(thread.threadTs, thread.channelId));
        await this.extract(thread.threadTs, thread.channelId, thread.lastActivityAt, 'silence');
        ran += 1;
      }
      // The retries the failure path promised. The shortlist above is the
      // OPEN sessions, so a thread closed since its pass failed — an
      // extraction forced by that very close, most often — would otherwise
      // keep a slice nothing ever comes back for.
      for (const pending of this.store.pendingExtractions()) {
        if (ran >= MAX_PASSES_PER_SWEEP) break;
        if (swept.has(threadKey(pending.threadTs, pending.channelId))) continue;
        await this.extract(pending.threadTs, pending.channelId, pending.activityMark, 'retry');
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
    // A pass that was already reading this thread when the request landed
    // finishes against a row that is now gone, and writing it back under a
    // new id would undo an acknowledged deletion. The tombstone is what
    // `absorb` checks before it writes.
    this.store.recordDeletion(row);
    this.logger.info({ userId, memoryId }, 'memory forgotten');
    return 'deleted';
  }

  /**
   * The session's Bash-borne request to forget something (ADR 0009). It is a
   * daemon action asked for through the one channel the session has, never a
   * command that runs: `canUseTool` answers it and nothing reaches a shell.
   * Declining leaves the classifier to rule on the command as usual.
   *
   * The asker is whoever wrote the turn the session is answering — it never
   * gets to name whose memory it is deleting. A turn can carry several
   * people's messages (issue #117), and then "the speaker" is genuinely
   * ambiguous: the request is refused rather than guessed at, and the bare
   * `forget <id>` command, which carries a real Slack author, still works.
   * Deleting the wrong person's memory to save someone a second message is
   * not a trade worth making.
   */
  forgetCommand(
    threadTs: string,
    channelId: string,
    command: string,
  ): { handled: false } | { handled: true; message: string } {
    const match = FORGET_COMMAND.exec(command);
    if (match === null) return { handled: false };
    const memoryId = match[1] ?? '';
    const outcome = this.forgetAsAsker(threadTs, channelId, memoryId);
    return { handled: true, message: SESSION_FORGET_REPLIES[outcome](memoryId) };
  }

  /** Works out who asked, then forgets as them — or refuses to guess. */
  private forgetAsAsker(threadTs: string, channelId: string, memoryId: string): ForgetOutcome {
    if (!this.enabled) return 'disabled';
    const speakers = this.turnSpeakers.get(threadKey(threadTs, channelId)) ?? [];
    if (speakers.length > 1) {
      this.logger.info(
        { threadTs, channelId, speakers },
        'session asked to forget on a turn several people wrote — refused',
      );
      return 'ambiguous';
    }
    const asker = speakers[0];
    // No identifiable author: an orchestration-event wake, or a turn from
    // before this process started. Nobody asked, so nothing is deleted.
    if (asker === undefined) return 'not_yours';
    // Only what the session was actually shown (spec §12). A memory the
    // portrait budget left out, or one written after the block it read, is
    // not an id it can have seen — so to this session it does not exist.
    if (!(this.shownIds.get(threadKey(threadTs, channelId))?.has(memoryId) ?? false)) {
      this.logger.info(
        { threadTs, channelId, memoryId },
        'session asked to forget an id it was never shown — refused',
      );
      return 'unknown';
    }
    return this.forget(asker, memoryId);
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
  private extract(
    threadTs: string,
    channelId: string,
    activityMark: string,
    trigger: ExtractionTrigger,
  ): Promise<void> {
    // One at a time per thread. A close landing while the sweep's pass is
    // running would otherwise read the same slice against the same
    // watermark: both passes would charge for the conversation, absorb it
    // twice — inflating recurrence, which is what promotes a moment — and
    // the slower one would write the older watermark last.
    const key = threadKey(threadTs, channelId);
    const next = (this.extractions.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.runExtraction(threadTs, channelId, activityMark, trigger));
    this.extractions.set(key, next);
    // The queue's own copy of the pass, held only to forget it again. It has
    // to swallow: `next` is what carries a failure to the caller, and a
    // second unhandled branch of the same rejection would take the daemon
    // down with it — the one thing a background pass must never do.
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.extractions.get(key) === next) this.extractions.delete(key);
      });
    return next;
  }

  private async runExtraction(
    threadTs: string,
    channelId: string,
    activityMark: string,
    trigger: ExtractionTrigger,
  ): Promise<void> {
    // Every store touch the pass makes is inside the pass's own failure
    // handling, the first one included: a store that goes out from under a
    // pass in flight — a shutdown closing it while the sweep is still
    // waiting on its model call — is a failure like any other here.
    let marks: ExtractionRow | undefined;
    try {
      // Read after the queue, never before it: the pass that just finished
      // may have moved this very watermark.
      marks = this.store.extraction(threadTs, channelId);
      // Everything from here on is work from BEFORE any deletion asked for
      // while it runs — which is what makes such a deletion final (§12).
      const startedAt = this.now().toISOString();
      const people = this.store
        .participants(threadTs, channelId)
        .map((row) => row.userId)
        .filter((userId) => this.allowedUserIds.includes(userId) && !this.store.isOptedOut(userId));
      if (people.length === 0) {
        this.store.advance(threadTs, channelId, marks.watermarkTs, activityMark);
        return;
      }
      const messages = await this.readTranscript(channelId, threadTs, marks.watermarkTs);
      if (messages.length === 0) {
        // Nothing new to read: not a failure, just a thread with no new slice.
        this.store.advance(threadTs, channelId, marks.watermarkTs, activityMark);
        return;
      }
      // The shortlist says a thread finished its last turn long ago; the
      // transcript says whether anyone has spoken since. A reply that
      // arrived while the sweep was working — or one still queued behind a
      // turn — lands here, and a conversation still in progress is left
      // alone with its marks untouched, to be extracted when it really is
      // quiet. A close is exempt: someone just asked for it.
      if (trigger !== 'close' && this.spokenSinceCutoff(messages)) {
        this.logger.debug({ threadTs, channelId, trigger }, 'memory pass skipped — the thread is still talking');
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
      const written = this.absorb(result.memories, threadTs, channelId, startedAt);
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
      this.onFailure(threadTs, channelId, activityMark, marks?.watermarkTs ?? '0', error);
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
    try {
      const attempts = this.store.recordAttempt(threadTs, channelId);
      const abandoned = attempts >= this.attemptLimit;
      this.store.recordPass({
        threadTs,
        channelId,
        outcome: abandoned ? 'abandoned' : 'failed',
        written: 0,
        dropped: 0,
        // A model can bill for an answer and still fail on it. The money is
        // spent whatever the outcome, so the pass's own counter must see it.
        costUsd: billedCost(error),
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
    } catch (bookkeeping) {
      // Recording the failure failed too — most often the same store that
      // caused it, gone for the same reason. There is nowhere left to count
      // the attempt, so the log is the only record the slice gets, and the
      // pass still ends quietly rather than as a rejection nobody owns.
      this.logger.error(
        { err: bookkeeping, cause: error, threadTs, channelId },
        'memory pass failure could not be recorded',
      );
    }
  }

  /**
   * Writes what survived validation. A draft that says again what is already
   * known bumps that memory's recurrence instead of duplicating it, and a
   * moment that has recurred enough is promoted to a durable fact — which is
   * exactly what a private joke is.
   */
  private absorb(
    drafts: readonly DraftMemory[],
    threadTs: string,
    channelId: string,
    startedAt: string,
  ): number {
    // Anything somebody asked to forget while this pass was running. The
    // pass read the conversation before the request landed, so writing its
    // drafts back would return a deleted memory under a new id, seconds
    // after the person was told it was gone.
    const forgotten = this.store.deletionsSince(startedAt);
    let written = 0;
    for (const draft of drafts) {
      if (forgotten.some((row) => row.subjectUserId === draft.subject && sameThing(row.text, draft.text))) {
        this.logger.info(
          { threadTs, channelId, subject: draft.subject },
          'memory dropped — it was forgotten while the pass was running',
        );
        continue;
      }
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
    const promoted = new Set(promotable(memories));
    for (const id of promoted) {
      this.store.promote(id);
      this.logger.info({ userId, memoryId: id }, 'recurring moment promoted to a durable fact');
    }
    // The rows in hand still say `moment` for everything just promoted, and
    // the oldest moment is exactly the one most likely to have earned its
    // third sighting: retiring it here would delete a durable fact one line
    // after making it one.
    const moments = memories.filter((row) => row.nature === 'moment' && !promoted.has(row.id));
    for (const retired of moments.slice(0, Math.max(0, moments.length - RETAINED_MOMENTS_PER_PERSON))) {
      this.store.delete(retired.id);
    }
  }

  /** Remembers what a session was handed, so a deletion can be checked
   * against it. Ids accumulate per thread: a resumed session still holds
   * every block it has read, and a memory evicted from today's block by the
   * budget was genuinely shown yesterday. */
  private noteShown(threadTs: string, channelId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const key = threadKey(threadTs, channelId);
    const seen = this.shownIds.get(key) ?? new Set<string>();
    for (const id of ids) seen.add(id);
    this.shownIds.set(key, seen);
  }

  /** Whether anyone has spoken since the silence mark — the transcript's own
   * answer to "is this thread quiet", rather than the sessions table's. */
  private spokenSinceCutoff(messages: readonly TranscriptMessage[]): boolean {
    const cutoffTs = (this.now().getTime() - this.silenceMs) / 1000;
    return messages.some((message) => Number(message.ts) > cutoffTs);
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

/** Why a pass is running: the sweep's silence mark, an explicit close, or a
 * slice a previous failure still owes an attempt. */
type ExtractionTrigger = 'silence' | 'close' | 'retry';

function threadKey(threadTs: string, channelId: string): string {
  return `${channelId}:${threadTs}`;
}

/** What a failed attempt was billed before it threw, if it says so — read
 * structurally so a scripted pass can report it as readily as the SDK one. */
function billedCost(error: unknown): number {
  const cost = (error as { costUsd?: unknown } | null)?.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
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
  ambiguous: () =>
    'Refused: this turn carries messages from several people, so I cannot tell whose memory this is. Ask them to send `forget <id>` as a message on its own — that carries their name.',
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

import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { MemoryKeeper, sameThing, type MemoryKeeperOptions, type TranscriptMessage } from './keeper.ts';
import type { MemoryPassInput, MemoryPassResult } from './pass.ts';
import { MemoryStore } from './store.ts';

/**
 * The keeper over small fakes: the decisions it owns alone — when a pass may
 * run, what a failure costs, who a deletion belongs to — pinned close to the
 * code that makes them. The composition test drives the same object through
 * the real graph; these are the cases that are awkward to stage from Slack.
 */

const THREAD = '1751970000.000100';
const CHANNEL = 'C0EXAMPLE123';
const ALICE = 'U0ALICE';
const BOB = 'U0BOB';

const said = (ts: string, userId: string | null, text: string, fromBot = false): TranscriptMessage =>
  ({ ts, userId, text, fromBot });

const CONVERSATION = [
  said('1751970001.000100', ALICE, 'the toaster is a design choice'),
  said('1751970002.000100', null, 'it is a toaster', true),
];

const makeKeeper = (over: Partial<MemoryKeeperOptions> = {}) => {
  let clock = Date.parse('2026-09-11T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const store = new MemoryStore(':memory:', () => now().toISOString());
  const passes: MemoryPassInput[] = [];
  const quiet: Array<{ threadTs: string; channelId: string; lastActivityAt: string }> = [];
  let answer: () => MemoryPassResult = () => ({ memories: [], costUsd: 0.01 });
  const keeper = new MemoryKeeper({
    store,
    enabled: true,
    allowedUserIds: [ALICE, BOB],
    quietThreads: (cutoffIso) => quiet.filter((thread) => thread.lastActivityAt < cutoffIso),
    readTranscript: (_channelId, _threadTs, sinceTs) =>
      Promise.resolve(CONVERSATION.filter((message) => Number(message.ts) > Number(sinceTs))),
    workFacts: () => [],
    runPass: (input) => {
      passes.push(input);
      return Promise.resolve(answer());
    },
    silenceMs: 1_800_000,
    attemptLimit: 3,
    logger: createLogger('silent'),
    now,
    ...over,
  });
  return {
    keeper,
    store,
    passes,
    /** Puts a thread on the sweep's shortlist, as the session store would. */
    quieten: (threadTs = THREAD, at = now().toISOString()) => {
      quiet.push({ threadTs, channelId: CHANNEL, lastActivityAt: at });
    },
    answerWith: (next: () => MemoryPassResult) => { answer = next; },
    tick: (ms: number) => { clock += ms; },
  };
};

describe('MemoryKeeper — when a pass may run', () => {
  it('runs nothing for a thread nobody has spoken in', async () => {
    const h = makeKeeper();
    h.quieten();
    h.tick(3_600_000);
    expect(await h.keeper.sweep()).toBe(1);
    // Swept, but never passed to a model: a thread with no known participant
    // has no possible subject, and the mark still advances so it stays quiet.
    expect(h.passes).toEqual([]);
    expect(await h.keeper.sweep()).toBe(0);
    h.store.close();
  });

  it('never reads a thread for someone who opted out', async () => {
    const h = makeKeeper();
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.store.optOut(ALICE);
    h.quieten();
    h.tick(3_600_000);
    await h.keeper.sweep();
    expect(h.passes).toEqual([]);
    h.store.close();
  });

  it('skips a person who is no longer on the allow-list', async () => {
    const h = makeKeeper({ allowedUserIds: [BOB] });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);
    await h.keeper.sweep();
    expect(h.passes).toEqual([]);
    h.store.close();
  });

  it('does not overlap itself when a sweep outlasts its interval', async () => {
    const h = makeKeeper();
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);
    let release: (() => void) | undefined;
    h.answerWith(() => ({ memories: [], costUsd: 0 }));
    const slow = makeKeeper({
      runPass: () => new Promise<MemoryPassResult>((resolve) => {
        release = () => resolve({ memories: [], costUsd: 0 });
      }),
    });
    slow.store.noteParticipant(THREAD, CHANNEL, ALICE);
    slow.quieten();
    slow.tick(3_600_000);
    const first = slow.keeper.sweep();
    expect(await slow.keeper.sweep()).toBe(0);
    release!();
    expect(await first).toBe(1);
    slow.store.close();
    h.store.close();
  });
});

describe('MemoryKeeper — what a failure costs', () => {
  it('never lets a thrown pass escape, and says nothing anywhere', async () => {
    const logger = createLogger('silent');
    const warn = vi.spyOn(logger, 'warn');
    const h = makeKeeper({ logger, runPass: () => Promise.reject(new Error('the pass fell over')) });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);
    await expect(h.keeper.sweep()).resolves.toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: THREAD, attempts: 1 }),
      'memory pass failed — will retry',
    );
    expect(h.store.extraction(THREAD, CHANNEL).attempts).toBe(1);
    h.store.close();
  });

  it('treats an unreadable transcript as a failure, so the slice is not lost', async () => {
    const h = makeKeeper({ readTranscript: () => Promise.reject(new Error('ratelimited')) });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);
    await h.keeper.sweep();
    expect(h.store.extraction(THREAD, CHANNEL)).toMatchObject({ attempts: 1, watermarkTs: '0' });
    h.store.close();
  });

  it('records an empty pass as empty and a writing one as wrote, with its own cost', async () => {
    const h = makeKeeper();
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);
    await h.keeper.sweep();
    expect(h.store.passCostUsdTotal()).toBeCloseTo(0.01, 6);
    expect(h.store.listForPerson(ALICE)).toEqual([]);
    h.store.close();
  });
});

describe('MemoryKeeper — who a deletion belongs to', () => {
  const withSpeakers = () => {
    const h = makeKeeper();
    const mine = h.store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'durable',
      text: 'Lives in webapp.', sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })!;
    const theirs = h.store.add({
      subjectUserId: BOB, participantUserIds: [], nature: 'durable',
      text: 'Somebody else entirely.', sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })!;
    /** The command is always answered, never run — the message is the answer. */
    const forgetting = (memoryId: string): string => {
      const result = h.keeper.forgetCommand(THREAD, CHANNEL, `orc memory forget ${memoryId}`);
      if (!result.handled) throw new Error('the forget command must never reach a shell');
      return result.message;
    };
    return { ...h, mine, theirs, forgetting };
  };

  it('declines anything that is not the forget command, leaving the classifier to rule', () => {
    const h = withSpeakers();
    for (const command of ['orca worktree list --json', 'orc memory forget', 'echo orc memory forget abc', 'rm -rf /']) {
      expect(h.keeper.forgetCommand(THREAD, CHANNEL, command)).toEqual({ handled: false });
    }
    h.store.close();
  });

  it('forgets as the person who spoke last, and refuses the other’s id', () => {
    const h = withSpeakers();
    h.store.noteParticipant(THREAD, CHANNEL, BOB);
    h.tick(60_000);
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);

    expect(h.forgetting(h.theirs)).toContain('not a memory about the person who just spoke');
    expect(h.store.get(h.theirs)).toBeDefined();

    expect(h.forgetting(h.mine)).toContain('is gone');
    expect(h.store.get(h.mine)).toBeUndefined();
    h.store.close();
  });

  it('refuses to guess when two people spoke at the same moment', () => {
    const h = withSpeakers();
    h.store.noteParticipant(THREAD, CHANNEL, BOB);
    // Inside the batch window: both messages can reach the session as one turn.
    h.tick(500);
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    expect(h.forgetting(h.mine)).toContain('cannot tell whose memory this is');
    expect(h.store.get(h.mine)).toBeDefined();
    h.store.close();
  });

  it('refuses when nobody has spoken here at all', () => {
    const h = withSpeakers();
    expect(h.forgetting(h.mine)).toContain('not a memory about the person who just spoke');
    expect(h.store.get(h.mine)).toBeDefined();
    h.store.close();
  });
});

describe('MemoryKeeper — turned off', () => {
  it('reads nothing, writes nothing, injects nothing and forgets nothing', async () => {
    const h = makeKeeper({ enabled: false });
    h.store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'durable',
      text: 'Lives in webapp.', sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);

    expect(await h.keeper.sweep()).toBe(0);
    expect(h.passes).toEqual([]);
    expect(h.keeper.systemPromptBlock(THREAD, CHANNEL)).toBe('');
    expect(h.keeper.noteSpeaker(THREAD, CHANNEL, BOB)).toBe('');
    expect(h.keeper.forget(ALICE, 'whatever')).toBe('disabled');
    expect(h.keeper.optOut(ALICE)).toBe(0);
    await h.keeper.extractOnClose(THREAD, CHANNEL);
    expect(h.passes).toEqual([]);
    // And nothing was recorded on the way past.
    expect(h.store.participants(THREAD, CHANNEL).map((row) => row.userId)).toEqual([ALICE]);
    h.store.close();
  });
});

describe('sameThing — what counts as the same memory', () => {
  it('reads the pass’s retellings of one joke as one joke', () => {
    const tellings = [
      'Calls the deploy script "the goat", every single time.',
      'Called the deploy script "the goat" again, as always.',
      'Still calls the deploy script "the goat".',
    ];
    expect(sameThing(tellings[0]!, tellings[1]!)).toBe(true);
    expect(sameThing(tellings[0]!, tellings[2]!)).toBe(true);
  });

  it('keeps two genuinely different things apart', () => {
    expect(sameThing('Works almost exclusively in the webapp repo.', 'Wants a PR rather than a patch.')).toBe(false);
    expect(sameThing('Lives in webapp.', 'Works in webapp.')).toBe(false);
    expect(sameThing('Named the deploy script "the goat".', 'Reviews with the diff open.')).toBe(false);
  });
});

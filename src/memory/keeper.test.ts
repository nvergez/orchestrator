import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { MemoryKeeper, sameThing, type MemoryKeeperOptions, type TranscriptMessage } from './keeper.ts';
import { MemoryPassError, type MemoryPass, type MemoryPassInput, type MemoryPassResult } from './pass.ts';
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
    await vi.waitFor(() => expect(release).toBeDefined());
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

describe('MemoryKeeper — when the store goes out from under a pass', () => {
  /**
   * What a shutdown looks like from inside the keeper: the daemon closes the
   * store while a sweep is still waiting on its model call, and the pass it
   * left in flight comes back to a store that is gone. Nothing about that may
   * reach the process as a rejection nobody owns — the daemon is long-lived,
   * and a background pass is the last thing that should be able to end it.
   */
  const watchRejections = (): { seen: unknown[]; stop: () => void } => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => { seen.push(reason); };
    process.on('unhandledRejection', onRejection);
    return { seen, stop: () => { process.off('unhandledRejection', onRejection); } };
  };

  it('ends the pass quietly when the store closes mid-flight', async () => {
    const logger = createLogger('silent');
    const error = vi.spyOn(logger, 'error');
    const h = makeKeeper({ logger });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    // The close lands while the model call is out, as a shutdown would.
    h.answerWith(() => { h.store.close(); return { memories: [], costUsd: 0.01 }; });
    await expect(h.keeper.extractOnClose(THREAD, CHANNEL)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ threadTs: THREAD, channelId: CHANNEL }),
      'memory pass failure could not be recorded',
    );
  });

  it('leaves no rejection nobody owns, for the pass or the one queued behind it', async () => {
    const watch = watchRejections();
    try {
      const h = makeKeeper();
      h.store.noteParticipant(THREAD, CHANNEL, ALICE);
      h.store.close();
      // The first pass fails on its very first read; the second is queued
      // behind it, which is the branch that settles without a caller.
      await expect(h.keeper.extractOnClose(THREAD, CHANNEL)).resolves.toBeUndefined();
      await expect(h.keeper.extractOnClose(THREAD, CHANNEL)).resolves.toBeUndefined();
      // The queue's own copy settles a turn behind the pass it is holding.
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
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
    // Both have spoken here, so the spawn hands the session both portraits:
    // those ids, and only those, are what it can point at afterwards.
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.store.noteParticipant(THREAD, CHANNEL, BOB);
    h.keeper.systemPromptBlock(THREAD, CHANNEL);
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

  it('forgets as the person whose turn it is, and refuses the other’s id', () => {
    const h = withSpeakers();
    h.keeper.noteTurnSpeakers(THREAD, CHANNEL, [ALICE]);

    expect(h.forgetting(h.theirs)).toContain('not a memory about the person who just spoke');
    expect(h.store.get(h.theirs)).toBeDefined();

    expect(h.forgetting(h.mine)).toContain('is gone');
    expect(h.store.get(h.mine)).toBeUndefined();
    h.store.close();
  });

  it('refuses to guess when one turn carries two people’s messages', () => {
    const h = withSpeakers();
    // Messages that queued behind a slow turn share a turn however far
    // apart they were sent (issue #117), so there is no clock that could
    // tell these two apart afterwards — only the batch knows.
    h.keeper.noteTurnSpeakers(THREAD, CHANNEL, [ALICE, BOB]);
    expect(h.forgetting(h.mine)).toContain('cannot tell whose memory this is');
    expect(h.store.get(h.mine)).toBeDefined();
    h.store.close();
  });

  it('refuses when nobody wrote the turn at all', () => {
    const h = withSpeakers();
    // An orchestration-event wake: a worker finished, no human asked for
    // anything, and a deletion here belongs to nobody.
    h.keeper.noteTurnSpeakers(THREAD, CHANNEL, []);
    expect(h.forgetting(h.mine)).toContain('not a memory about the person who just spoke');
    expect(h.store.get(h.mine)).toBeDefined();
    h.store.close();
  });

  it('refuses an id it was never shown, even the asker’s own', () => {
    const h = withSpeakers();
    h.keeper.noteTurnSpeakers(THREAD, CHANNEL, [ALICE]);
    // Written by a pass after the block this session read: a real memory of
    // theirs, but not one this session can have seen an id for (spec §12).
    const unseen = h.store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'moment',
      text: 'Laughed at the toaster.', sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })!;
    expect(h.forgetting(unseen)).toContain(`there is no memory ${unseen}`);
    expect(h.store.get(unseen)).toBeDefined();

    // Shown at the next spawn, it becomes deletable — nothing is lost, it
    // just cannot be deleted before it has been read.
    h.keeper.systemPromptBlock(THREAD, CHANNEL);
    expect(h.forgetting(unseen)).toContain('is gone');
    expect(h.store.get(unseen)).toBeUndefined();
    h.store.close();
  });

  it('refuses an id the portrait budget left out of the block', () => {
    const h = makeKeeper({ caps: { perPersonChars: 120, blockChars: 2_000 } });
    const older = h.store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'moment',
      text: 'x'.repeat(100), sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })!;
    h.store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'moment',
      text: 'y'.repeat(100), sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    const block = h.keeper.systemPromptBlock(THREAD, CHANNEL);
    expect(block).not.toContain(older);
    h.keeper.noteTurnSpeakers(THREAD, CHANNEL, [ALICE]);

    const result = h.keeper.forgetCommand(THREAD, CHANNEL, `orc memory forget ${older}`);
    if (!result.handled) throw new Error('the forget command must never reach a shell');
    expect(result.message).toContain(`there is no memory ${older}`);
    expect(h.store.get(older)).toBeDefined();
    h.store.close();
  });

  it('shows a latecomer their portrait, and that is enough to delete from it', () => {
    const h = makeKeeper();
    const mine = h.store.add({
      subjectUserId: BOB, participantUserIds: [], nature: 'durable',
      text: 'Asks for the diff first.', sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })!;
    h.keeper.noteSpeaker(THREAD, CHANNEL, ALICE);
    expect(h.keeper.noteSpeaker(THREAD, CHANNEL, BOB)).toContain(mine);
    h.keeper.noteTurnSpeakers(THREAD, CHANNEL, [BOB]);
    const result = h.keeper.forgetCommand(THREAD, CHANNEL, `orc memory forget ${mine}`);
    if (!result.handled) throw new Error('the forget command must never reach a shell');
    expect(result.message).toContain('is gone');
    expect(h.store.get(mine)).toBeUndefined();
    h.store.close();
  });
});

describe('MemoryKeeper — one pass at a time, and what it may write', () => {
  /** A pass the test releases by hand, to stage two overlapping passes. */
  const deferredPass = () => {
    const runs: MemoryPassInput[] = [];
    const releases: Array<(result: MemoryPassResult) => void> = [];
    const runPass: MemoryPass = (input) => {
      runs.push(input);
      return new Promise<MemoryPassResult>((resolve) => releases.push(resolve));
    };
    return { runs, releases, runPass };
  };

  it('serialises a close behind a running sweep, and charges for the slice once', async () => {
    const pass = deferredPass();
    const h = makeKeeper({ runPass: pass.runPass });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);

    const sweeping = h.keeper.sweep();
    await vi.waitFor(() => expect(pass.runs).toHaveLength(1));
    // The thread is closed while its silence-triggered pass is still out.
    const closing = h.keeper.extractOnClose(THREAD, CHANNEL);
    pass.releases[0]!({ memories: [], costUsd: 0.02 });
    await sweeping;
    await closing;

    // The close read the watermark the first pass had just moved, found
    // nothing new, and never reached the model: one slice, one bill.
    expect(pass.runs).toHaveLength(1);
    expect(h.store.passCostUsdTotal()).toBeCloseTo(0.02, 6);
    h.store.close();
  });

  it('does not write back a memory forgotten while the pass was running', async () => {
    const pass = deferredPass();
    const h = makeKeeper({ runPass: pass.runPass });
    const id = h.store.add({
      subjectUserId: ALICE, participantUserIds: [], nature: 'moment',
      text: 'Calls the deploy script "the goat", every single time.',
      sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
    })!;
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);

    const sweeping = h.keeper.sweep();
    await vi.waitFor(() => expect(pass.runs).toHaveLength(1));
    // Mid-pass, they ask for it to go — and are told it is gone.
    expect(h.keeper.forget(ALICE, id)).toBe('deleted');
    // The pass then finishes, retelling exactly what was just deleted.
    pass.releases[0]!({
      memories: [{ subject: ALICE, participants: [], nature: 'moment', text: 'Still calls the deploy script "the goat".' }],
      costUsd: 0.02,
    });
    await sweeping;

    expect(h.store.listForPerson(ALICE)).toEqual([]);
    h.store.close();
  });

  it('keeps a moment it has just promoted, instead of evicting it as the oldest', async () => {
    const h = makeKeeper();
    // Deliberately unshareable wording: `sameThing` merges retellings, and
    // thirty near-identical moments would collapse into one record.
    const ids = Array.from({ length: 30 }, (_, i) =>
      h.store.add({
        subjectUserId: ALICE, participantUserIds: [], nature: 'moment',
        text: `alfa${i} bravo${i} charlie${i} delta${i}`,
        sourceThreadTs: THREAD, sourceChannelId: CHANNEL,
      })!);
    const oldest = ids[0]!;
    // Seen twice already: this pass is its third sighting.
    h.store.noteRecurrence(oldest);
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.answerWith(() => ({
      memories: [
        { subject: ALICE, participants: [], nature: 'moment', text: 'alfa0 bravo0 charlie0 echo0' },
        { subject: ALICE, participants: [], nature: 'moment', text: 'foxtrot golf hotel india' },
      ],
      costUsd: 0.01,
    }));
    h.quieten();
    h.tick(3_600_000);
    await h.keeper.sweep();

    expect(h.store.get(oldest)).toMatchObject({ nature: 'durable', recurrenceCount: 3 });
    expect(h.store.listForPerson(ALICE)).toHaveLength(31);
    h.store.close();
  });

  it('leaves a thread alone when somebody has spoken since the silence mark', async () => {
    const h = makeKeeper({
      readTranscript: () => Promise.resolve([
        said('1751970001.000100', ALICE, 'the toaster is a design choice'),
        // Sent seconds ago: the row said quiet, the transcript says talking.
        said(String((Date.parse('2026-09-11T09:00:00.000Z') + 3_600_000) / 1000), ALICE, 'actually, wait'),
      ]),
    });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);

    expect(await h.keeper.sweep()).toBe(1);
    expect(h.passes).toEqual([]);
    // And nothing moved: the slice is still there to extract once it is.
    expect(h.store.extraction(THREAD, CHANNEL)).toMatchObject({ watermarkTs: '0', attempts: 0 });
    h.store.close();
  });

  it('retries a failed slice even after the thread has been closed', async () => {
    let fail = true;
    const h = makeKeeper({
      runPass: (input) => {
        h.passes.push(input);
        return fail
          ? Promise.reject(new Error('the pass fell over'))
          : Promise.resolve({ memories: [], costUsd: 0.01 });
      },
    });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    // The close forces a pass, and it fails. The thread is closed now, so
    // the sweep's own shortlist — the OPEN sessions — will never name it.
    await h.keeper.extractOnClose(THREAD, CHANNEL);
    expect(h.store.extraction(THREAD, CHANNEL).attempts).toBe(1);

    fail = false;
    h.tick(3_600_000);
    expect(await h.keeper.sweep()).toBe(1);
    expect(h.store.extraction(THREAD, CHANNEL)).toMatchObject({ attempts: 0, watermarkTs: '1751970002.000100' });
    // And once it lands there is nothing left owing.
    expect(await h.keeper.sweep()).toBe(0);
    h.store.close();
  });

  it('records what a failed pass was already billed', async () => {
    const h = makeKeeper({
      runPass: () => Promise.reject(new MemoryPassError('the answer was not JSON', 1.25)),
    });
    h.store.noteParticipant(THREAD, CHANNEL, ALICE);
    h.quieten();
    h.tick(3_600_000);
    await h.keeper.sweep();
    // The model charged for the answer it botched; the meter must say so.
    expect(h.store.passCostUsdTotal()).toBeCloseTo(1.25, 6);
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

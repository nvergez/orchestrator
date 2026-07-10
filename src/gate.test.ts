import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { GateKeeper, isApproval } from './gate.ts';

const THREAD = '1751970000.000100';
const USER = 'U0EXAMPLE456';
const INTRUDER = 'U0INTRUDER99';

interface Harness {
  gates: GateKeeper;
  posted: Array<{ threadTs: string; text: string }>;
}

const makeHarness = (post?: (threadTs: string, text: string) => Promise<void>): Harness => {
  const posted: Array<{ threadTs: string; text: string }> = [];
  const gates = new GateKeeper({
    allowedUserId: USER,
    post:
      post ??
      ((threadTs, text) => {
        posted.push({ threadTs, text });
        return Promise.resolve();
      }),
    logger: createLogger('silent'),
  });
  return { gates, posted };
};

/** Lets pending microtasks settle so we can assert a promise is still open. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('GateKeeper.request', () => {
  it('posts the gate text into the thread and stays pending', async () => {
    const { gates, posted } = makeHarness();
    let settled = false;
    void gates.request(THREAD, '🚦 `git push` — go?').then(() => {
      settled = true;
    });
    await tick();
    expect(posted).toEqual([{ threadTs: THREAD, text: '🚦 `git push` — go?' }]);
    expect(settled).toBe(false);
  });

  it('denies fail-closed when the gate message cannot be posted', async () => {
    const { gates } = makeHarness(() => Promise.reject(new Error('slack down')));
    const verdict = await gates.request(THREAD, '🚦 `git push` — go?');
    expect(verdict.approved).toBe(false);
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(false);
  });

  it('denies immediately when the signal is already aborted', async () => {
    const { gates, posted } = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const verdict = await gates.request(THREAD, '🚦 `git push` — go?', controller.signal);
    expect(verdict.approved).toBe(false);
    expect(posted).toEqual([]);
  });

  it('denies and cleans up when the signal aborts while pending', async () => {
    const { gates } = makeHarness();
    const controller = new AbortController();
    const pending = gates.request(THREAD, '🚦 `git push` — go?', controller.signal);
    await tick();
    controller.abort();
    const verdict = await pending;
    expect(verdict.approved).toBe(false);
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(false);
  });
});

describe('GateKeeper.tryResolve', () => {
  it('"go" from the authorized user approves the pending call', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, reply: 'go' });
  });

  it('"no" denies and carries the verbatim reply', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    expect(gates.tryResolve(THREAD, USER, 'no')).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false, reply: 'no' });
  });

  it('free text denies but still reaches the session verbatim', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    expect(gates.tryResolve(THREAD, USER, 'wait, rebase on main first')).toBe(true);
    await expect(pending).resolves.toEqual({
      approved: false,
      reply: 'wait, rebase on main first',
    });
  });

  it('"go — <comment>" approves with the comment preserved in the verdict reply (issue #47)', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    const reply = 'go — and from here on, consider plain reads fine without asking in this thread.';
    expect(gates.tryResolve(THREAD, USER, reply)).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, reply });
  });

  it('"no — <reason>" denies with the reason preserved verbatim (issue #47)', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    expect(gates.tryResolve(THREAD, USER, 'no — rebase on main first')).toBe(true);
    await expect(pending).resolves.toEqual({ approved: false, reply: 'no — rebase on main first' });
  });

  it('only the authorized user can resolve a gate (spec §7 / issue AC)', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    expect(gates.tryResolve(THREAD, INTRUDER, 'go')).toBe(false);
    // Still pending: the real user's later reply is what resolves it.
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, reply: 'go' });
  });

  it('returns false when nothing is pending — the reply is an ordinary turn', () => {
    const { gates } = makeHarness();
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(false);
  });

  it('does not leak across threads', async () => {
    const { gates } = makeHarness();
    const pending = gates.request(THREAD, '🚦 `git push` — go?');
    await tick();
    expect(gates.tryResolve('1751970000.000999', USER, 'go')).toBe(false);
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(true);
    await expect(pending).resolves.toEqual({ approved: true, reply: 'go' });
  });

  it('resolves stacked gates FIFO, one reply each', async () => {
    const { gates } = makeHarness();
    const first = gates.request(THREAD, '🚦 `git push` — go?');
    const second = gates.request(THREAD, '🚦 `orca worktree delete x` — go?');
    await tick();
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(true);
    expect(gates.tryResolve(THREAD, USER, 'no')).toBe(true);
    await expect(first).resolves.toEqual({ approved: true, reply: 'go' });
    await expect(second).resolves.toEqual({ approved: false, reply: 'no' });
  });
});

describe('GateKeeper.cancelThread', () => {
  it('denies every pending gate when the session process goes away', async () => {
    const { gates } = makeHarness();
    const first = gates.request(THREAD, '🚦 `git push` — go?');
    const second = gates.request(THREAD, '🚦 `git merge main` — go?');
    await tick();
    gates.cancelThread(THREAD);
    expect((await first).approved).toBe(false);
    expect((await second).approved).toBe(false);
    expect(gates.tryResolve(THREAD, USER, 'go')).toBe(false);
  });

  it('is a no-op on a thread with nothing pending', () => {
    const { gates } = makeHarness();
    expect(() => gates.cancelThread(THREAD)).not.toThrow();
  });
});

describe('isApproval', () => {
  it.each(['go', 'Go', 'GO', 'go!', 'go ahead', 'yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'approve', 'approved', '👍', '✅'])(
    'approves %j',
    (text) => {
      expect(isApproval(text)).toBe(true);
    },
  );

  // Approval-prefix (issue #47): approval token + punctuation separator +
  // free text approves; the comment rides back in the verdict verbatim.
  it.each([
    'go — and from here on, consider plain reads fine without asking in this thread.',
    'Go — comment',
    'go – en-dash comment',
    'go - spaced hyphen comment',
    'go, do it',
    'go! and tell me when it lands',
    'go... but slowly',
    'go\nalso post the summary here',
    'go ahead, but keep an eye on CI',
    'yes, but keep an eye on CI',
    'ok. also update the ticket',
    'okay; then close it',
    'approved: ship it',
  ])('approves the approval-prefixed %j', (text) => {
    expect(isApproval(text)).toBe(true);
  });

  it.each(['no', 'No', 'nope', 'stop', 'cancel', "don't", 'not yet', 'go later maybe', 'gopher', 'push to prod instead', 'sure, but rebase first', ''])(
    'anything else denies, fail-closed: %j',
    (text) => {
      expect(isApproval(text)).toBe(false);
    },
  );

  // The prefix rule must not over-trigger: whitespace alone is not a
  // separator, a glued hyphen reads as a compound word, "?" is a question.
  it.each(['no — rebase on main first', 'ok-ish', 'go? really?', 'yeah nah', 'yes we should discuss this first'])(
    'stays fail-closed despite looking prefix-like: %j',
    (text) => {
      expect(isApproval(text)).toBe(false);
    },
  );
});

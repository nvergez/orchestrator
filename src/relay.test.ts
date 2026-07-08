import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { DelegationStore } from './delegations.ts';
import { GateRelay } from './relay.ts';
import type { ReactionSurface } from './watcher.ts';

const THREAD = '1751970000.000100';
const OTHER_THREAD = '1751970001.000200';
const GATE = 'msg_6a8c14d55c7d';
const WORKER = 'term_300035ab';

const REPLY_OK = JSON.stringify({ id: 'x', ok: true, result: { message: { id: 'msg_re1' } } });
const SEND_OK = JSON.stringify({ id: 'x', ok: true, result: { send: { accepted: true } } });

class FakeReactions implements ReactionSurface {
  reactions: Array<{ ts: string; name: string }> = [];
  removed: Array<{ ts: string; name: string }> = [];

  react(ts: string, name: string): Promise<void> {
    this.reactions.push({ ts, name });
    return Promise.resolve();
  }

  unreact(ts: string, name: string): Promise<void> {
    this.removed.push({ ts, name });
    return Promise.resolve();
  }
}

const makeRelay = () => {
  const store = new DelegationStore(':memory:');
  const surface = new FakeReactions();
  const relay = new GateRelay({ store, surface, logger: createLogger('silent') });
  return { relay, store, surface };
};

const seedGate = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordGate']>[0]> = {},
): void => {
  store.recordGate({
    msgId: GATE,
    threadTs: THREAD,
    taskId: 'task_13c7',
    workerHandle: WORKER,
    worktreeName: 'scratch-21-bench',
    kind: 'decision_gate',
    question: 'Which lint config is authoritative for CI?',
    options: ['root', 'app/', 'merge both into flat config'],
    relayTs: '1751970002.000300',
    ...over,
  });
};

const replyCommand = (body: string, id = GATE) =>
  `orca orchestration reply --id ${id} --body "${body}" --json`;

const seedStall = (
  store: DelegationStore,
  over: Partial<Parameters<DelegationStore['recordStall']>[0]> = {},
): void => {
  store.recordStall({
    dispatchId: 'ctx_stalled',
    threadTs: THREAD,
    workerHandle: WORKER,
    worktreeName: 'scratch-21-bench',
    lastOutput: '? Overwrite existing bench.json? (y/N)',
    fingerprint: '1783528800000',
    relayTs: '1751970003.000400',
    ...over,
  });
};

describe('decorateReply — the registry as turn context', () => {
  it('passes a gate-less thread through untouched', () => {
    const { relay } = makeRelay();
    expect(relay.decorateReply(THREAD, 'hello')).toBe('hello');
  });

  it('prepends every gate with its msg id, ack ref, question, options and status', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    seedGate(store, { msgId: 'msg_answered', kind: 'escalation', options: [] });
    store.answerGate('msg_answered');

    const decorated = relay.decorateReply(THREAD, 'the human words');
    expect(decorated).toContain('[relayed worker gates & watchdog stall alerts — daemon context');
    expect(decorated).toContain(`[PENDING] ❓ question ${GATE} from \`scratch-21-bench\``);
    expect(decorated).toContain('ack ref: scratch#21');
    expect(decorated).toContain(`worker terminal ${WORKER}`);
    expect(decorated).toContain('asked: "Which lint config is authoritative for CI?"');
    expect(decorated).toContain('options: 1) root · 2) app/ · 3) merge both into flat config');
    expect(decorated).toContain('[ANSWERED] 🚨 escalation msg_answered');
    expect(decorated.endsWith('---\nthe human words')).toBe(true);
  });

  it('never leaks another thread’s gates — scoping is hard', () => {
    const { relay, store } = makeRelay();
    seedGate(store, { threadTs: OTHER_THREAD });
    expect(relay.decorateReply(THREAD, 'hello')).toBe('hello');
  });

  it('lists watchdog stall alerts with their terminal, ack ref and last output (issue #22)', () => {
    const { relay, store } = makeRelay();
    seedStall(store);
    seedStall(store, { dispatchId: 'ctx_nudged', workerHandle: null, worktreeName: null });
    store.answerStall('ctx_nudged');

    const decorated = relay.decorateReply(THREAD, 'y');
    expect(decorated).toContain('[relayed worker gates & watchdog stall alerts — daemon context');
    expect(decorated).toContain('[PENDING] ⚠️ stall from `scratch-21-bench`');
    expect(decorated).toContain('ack ref: scratch#21');
    expect(decorated).toContain(`worker terminal ${WORKER}`);
    expect(decorated).toContain('last output: "? Overwrite existing bench.json? (y/N)"');
    expect(decorated).toContain(
      '[ANSWERED] ⚠️ stall from an unmatched worker (ack ref: ctx_nudged, worker terminal unknown',
    );
    expect(decorated.endsWith('---\ny')).toBe(true);
  });

  it('never leaks another thread’s stalls either', () => {
    const { relay, store } = makeRelay();
    seedStall(store, { threadTs: OTHER_THREAD });
    expect(relay.decorateReply(THREAD, 'y')).toBe('y');
  });
});

describe('prepare — registry enforcement on orchestration reply', () => {
  it('lets non-reply commands through untouched', () => {
    const { relay } = makeRelay();
    const command = 'orca repo list --json';
    expect(relay.prepare(THREAD, command)).toEqual({ action: 'proceed', command });
  });

  it('denies a reply chained with anything else', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    const verdict = relay.prepare(THREAD, `${replyCommand('ok')} && echo done`);
    expect(verdict.action).toBe('deny');
  });

  it('denies a reply to an id the registry never relayed', () => {
    const { relay } = makeRelay();
    const verdict = relay.prepare(THREAD, replyCommand('ok', 'msg_unknown'));
    expect(verdict).toMatchObject({ action: 'deny' });
    expect((verdict as { message: string }).message).toContain('not a gate relayed in this thread');
  });

  it('denies a reply to another thread’s gate — cross-thread routing is impossible', () => {
    const { relay, store } = makeRelay();
    seedGate(store, { threadTs: OTHER_THREAD });
    expect(relay.prepare(THREAD, replyCommand('ok')).action).toBe('deny');
  });

  it('denies re-routing an answered gate, pointing at the terminal-send correction', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    store.answerGate(GATE);

    const verdict = relay.prepare(THREAD, replyCommand('actually option 1'));
    expect(verdict.action).toBe('deny');
    const message = (verdict as { message: string }).message;
    expect(message).toContain('never re-routes');
    expect(message).toContain(`orca terminal send --terminal ${WORKER}`);
  });

  it('demands --json and a --body', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    expect(relay.prepare(THREAD, `orca orchestration reply --id ${GATE} --body "x"`).action).toBe(
      'deny',
    );
    expect(relay.prepare(THREAD, `orca orchestration reply --id ${GATE} --json`).action).toBe(
      'deny',
    );
  });

  it('rewrites a bare option number to the option’s exact text — fidelity', () => {
    const { relay, store } = makeRelay();
    seedGate(store);

    expect(relay.prepare(THREAD, replyCommand('2'))).toEqual({
      action: 'proceed',
      command: `orca orchestration reply --id ${GATE} --body app/ --json`,
    });
    expect(relay.prepare(THREAD, replyCommand('3.'))).toEqual({
      action: 'proceed',
      command: `orca orchestration reply --id ${GATE} --body 'merge both into flat config' --json`,
    });
  });

  it('denies an out-of-range option number instead of guessing', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    const verdict = relay.prepare(THREAD, replyCommand('7'));
    expect(verdict.action).toBe('deny');
    expect((verdict as { message: string }).message).toContain('no option 7');
  });

  it('passes free text — and bare numbers on an option-less gate — verbatim', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    seedGate(store, { msgId: 'msg_free', options: [] });

    const free = replyCommand('use the flat config, drop the rest');
    expect(relay.prepare(THREAD, free)).toEqual({ action: 'proceed', command: free });

    const numeric = replyCommand('2', 'msg_free');
    expect(relay.prepare(THREAD, numeric)).toEqual({ action: 'proceed', command: numeric });
  });
});

describe('sanctionsSend — the registry-anchored terminal send', () => {
  const SEND = `orca terminal send --terminal ${WORKER} --text "app/" --enter --json`;

  it('sanctions the fallback while the worker’s gate is pending, not forever after', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    expect(relay.sanctionsSend(THREAD, SEND)).toBe(true);

    // All answered and no correction under way: the worker is no longer a
    // silent AUTO target — the 🚦 is back.
    store.answerGate(GATE);
    expect(relay.sanctionsSend(THREAD, SEND)).toBe(false);
  });

  it('sanctions the correction send an answered-gate denial just pointed at', () => {
    const { relay, store } = makeRelay();
    seedGate(store);
    store.answerGate(GATE);

    expect(relay.prepare(THREAD, replyCommand('actually 1')).action).toBe('deny');
    expect(relay.sanctionsSend(THREAD, SEND)).toBe(true);
  });

  it.each([
    ['an unknown worker handle', 'orca terminal send --terminal term_other --text "x" --json'],
    ['a missing --json', `orca terminal send --terminal ${WORKER} --text "x" --enter`],
    ['a chained command', `orca terminal send --terminal ${WORKER} --text "x" --json && ls`],
    ['another thread’s gate', `orca terminal send --terminal ${WORKER} --text "x" --json`],
  ])('never sanctions %s', (label, command) => {
    const { relay, store } = makeRelay();
    seedGate(store, label === 'another thread’s gate' ? { threadTs: OTHER_THREAD } : {});
    expect(relay.sanctionsSend(THREAD, command)).toBe(false);
  });

  it('sanctions the nudge while the worker’s stall alert is pending, not after (issue #22)', () => {
    const { relay, store } = makeRelay();
    seedStall(store);
    expect(relay.sanctionsSend(THREAD, `orca terminal send --terminal ${WORKER} --text "y" --enter --json`)).toBe(
      true,
    );

    store.answerStall('ctx_stalled');
    expect(relay.sanctionsSend(THREAD, `orca terminal send --terminal ${WORKER} --text "y" --enter --json`)).toBe(
      false,
    );
  });

  it('never sanctions a send for another thread’s stall', () => {
    const { relay, store } = makeRelay();
    seedStall(store, { threadTs: OTHER_THREAD });
    expect(relay.sanctionsSend(THREAD, `orca terminal send --terminal ${WORKER} --text "y" --json`)).toBe(
      false,
    );
  });

  it('the stall sanction demands --enter — keystrokes without it answer nothing', () => {
    const { relay, store } = makeRelay();
    seedStall(store);
    expect(relay.sanctionsSend(THREAD, `orca terminal send --terminal ${WORKER} --text "y" --json`)).toBe(
      false,
    );
  });
});

describe('observe — the pending → answered flip', () => {
  it('flips the gate on a successful reply and settles the root back to 👀', async () => {
    const { relay, store, surface } = makeRelay();
    seedGate(store);

    await relay.observe(THREAD, replyCommand('2'), REPLY_OK);

    expect(store.getGate(GATE)?.status).toBe('answered');
    expect(surface.reactions).toEqual([{ ts: THREAD, name: 'eyes' }]);
    expect(surface.removed.map((entry) => entry.name)).toContain('question');
  });

  it('keeps ❓ while a sibling question is pending, 🚨 while an escalation is', async () => {
    const { relay, store, surface } = makeRelay();
    seedGate(store);
    seedGate(store, { msgId: 'msg_sibling' });
    await relay.observe(THREAD, replyCommand('2'), REPLY_OK);
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'question' });

    seedGate(store, { msgId: 'msg_esc', kind: 'escalation', options: [] });
    await relay.observe(THREAD, replyCommand('free text', 'msg_sibling'), REPLY_OK);
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'rotating_light' });
  });

  it('leaves the gate pending when the reply command failed', async () => {
    const { relay, store, surface } = makeRelay();
    seedGate(store);

    await relay.observe(THREAD, replyCommand('2'), '');
    await relay.observe(THREAD, replyCommand('2'), JSON.stringify({ ok: false, error: {} }));

    expect(store.getGate(GATE)?.status).toBe('pending');
    expect(surface.reactions).toEqual([]);
  });

  it('a fallback send answers the gate whose reply failed — not a sibling', async () => {
    const { relay, store, surface } = makeRelay();
    seedGate(store);
    seedGate(store, { msgId: 'msg_sibling', kind: 'escalation', options: [] });

    // The reply to GATE fails (ask timed out) — the fallback send follows.
    await relay.observe(THREAD, replyCommand('2'), '');
    await relay.observe(
      THREAD,
      `orca terminal send --terminal ${WORKER} --text "app/" --enter --json`,
      SEND_OK,
    );

    expect(store.getGate(GATE)?.status).toBe('answered');
    expect(store.getGate('msg_sibling')?.status).toBe('pending');
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'rotating_light' });
  });

  it('flips the single unambiguous pending gate on an unattributed send — never one of several', async () => {
    const { relay, store, surface } = makeRelay();
    seedGate(store);
    const send = `orca terminal send --terminal ${WORKER} --text "app/" --enter --json`;

    await relay.observe(THREAD, send, SEND_OK);
    expect(store.getGate(GATE)?.status).toBe('answered');
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'eyes' });

    seedGate(store, { msgId: 'msg_two' });
    seedGate(store, { msgId: 'msg_three', kind: 'escalation', options: [] });
    await relay.observe(THREAD, send, SEND_OK);
    expect(store.getGate('msg_two')?.status).toBe('pending');
    expect(store.getGate('msg_three')?.status).toBe('pending');
  });

  it('a nudge flips the stall alert and settles the root back to 👀 (issue #22)', async () => {
    const { relay, store, surface } = makeRelay();
    seedStall(store);

    await relay.observe(
      THREAD,
      `orca terminal send --terminal ${WORKER} --text "y" --enter --json`,
      SEND_OK,
    );

    expect(store.getStall('ctx_stalled')?.status).toBe('answered');
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'eyes' });
  });

  it('a failed nudge leaves the stall pending — the send never reached the terminal', async () => {
    const { relay, store, surface } = makeRelay();
    seedStall(store);

    await relay.observe(
      THREAD,
      `orca terminal send --terminal ${WORKER} --text "y" --enter --json`,
      JSON.stringify({ ok: false, error: {} }),
    );

    expect(store.getStall('ctx_stalled')?.status).toBe('pending');
    expect(surface.reactions).toEqual([]);
  });

  it('keeps 🚨 while a sibling escalation is pending after the nudge', async () => {
    const { relay, store, surface } = makeRelay();
    seedStall(store);
    seedGate(store, { msgId: 'msg_esc', kind: 'escalation', workerHandle: 'term_other', options: [] });

    await relay.observe(
      THREAD,
      `orca terminal send --terminal ${WORKER} --text "y" --enter --json`,
      SEND_OK,
    );

    expect(store.getStall('ctx_stalled')?.status).toBe('answered');
    expect(surface.reactions.at(-1)).toEqual({ ts: THREAD, name: 'rotating_light' });
  });

  it('a send to a different terminal leaves the stall pending', async () => {
    const { relay, store } = makeRelay();
    seedStall(store);

    await relay.observe(
      THREAD,
      'orca terminal send --terminal term_other --text "y" --enter --json',
      SEND_OK,
    );

    expect(store.getStall('ctx_stalled')?.status).toBe('pending');
  });

  it('an enter-less send leaves the stall pending — the prompt is still sitting', async () => {
    const { relay, store } = makeRelay();
    seedStall(store);

    await relay.observe(
      THREAD,
      `orca terminal send --terminal ${WORKER} --text "y" --json`,
      SEND_OK,
    );

    expect(store.getStall('ctx_stalled')?.status).toBe('pending');
  });

  it('a correction send flips nothing — the worker’s newer pending gate survives', async () => {
    const { relay, store, surface } = makeRelay();
    seedGate(store);
    store.answerGate(GATE);
    seedGate(store, { msgId: 'msg_newer' });
    surface.reactions.length = 0;

    // The human revises the answered gate: deny points at terminal send…
    expect(relay.prepare(THREAD, replyCommand('actually 1')).action).toBe('deny');
    // …and that send must not mark the newer, unrelated question answered.
    await relay.observe(
      THREAD,
      `orca terminal send --terminal ${WORKER} --text "correction" --enter --json`,
      SEND_OK,
    );

    expect(store.getGate('msg_newer')?.status).toBe('pending');
    expect(surface.reactions).toEqual([]);
  });
});

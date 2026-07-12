import { rmSync } from 'node:fs';
import { SessionStore } from '../daemon/db.ts';
import { DelegationStore } from '../delegation/delegations.ts';

/**
 * Demo state (issue #94, CONTEXT.md): a representative orchestrator
 * database written through the real stores — a live session with an
 * in-flight delegation and bus heartbeat, closed work inside and outside
 * the recently-closed window, an orphaned in-flight delegation, pending
 * and answered gates, an escalation, a stall — so the dashboard renders
 * every section without a live daemon. Events are placed relative to
 * `now`: the HTTP-seam suite pins `now` so its exact assertions hold;
 * `seed-demo.ts` passes the real clock so a seeded database never rots
 * out of the ~48h window. Dev-only — excluded from the published build
 * (tsconfig.build.json).
 */

export const THREAD = '1751970000.000100';
export const THREAD_CLOSED = '1751970001.000200';
const THREAD_ANCIENT = '1751970002.000300';
export const THREAD_ORPHAN = '1751970003.000400';
export const CHANNEL = 'C0EXAMPLE123';
export const USER = 'U0EXAMPLE456';

const MINUTE = 60_000;
const hours = (h: number): number => h * 60;
const days = (d: number): number => d * 24 * 60;

export function seedDemoState(dbPath: string, now: Date): void {
  // Always from scratch: the stores upsert, so seeding over a previous
  // seed would accumulate turns and keep stale stamps instead of failing.
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

  const at = (minutesAgo: number): string =>
    new Date(now.getTime() - minutesAgo * MINUTE).toISOString();

  let clock = at(hours(27));
  const sessions = new SessionStore(dbPath, () => clock);
  const delegations = new DelegationStore(dbPath, () => clock);

  // The live session: two turns, accumulated cost.
  sessions.register(THREAD, CHANNEL, USER);
  clock = at(hours(26.5));
  sessions.recordTurn(THREAD, CHANNEL, 0.5);
  clock = at(hours(4));
  sessions.recordTurn(THREAD, CHANNEL, 1.0);

  // A dormant session the sweep closed inside the ~48h window — its last
  // activity predates the window, the CLOSE is what's recent — and one
  // closed long before it.
  clock = at(days(5) + hours(2));
  sessions.register(THREAD_CLOSED, CHANNEL, USER);
  clock = at(hours(26));
  sessions.closeSession(THREAD_CLOSED, CHANNEL);
  clock = at(days(15) + hours(12));
  sessions.register(THREAD_ANCIENT, CHANNEL, USER);
  clock = at(days(9) + hours(12));
  sessions.closeSession(THREAD_ANCIENT, CHANNEL);

  const dispatch = {
    taskId: 'task_live',
    dispatchId: 'ctx_live',
    worktreeId: '444c::/home/op/webapp::workspace:98',
    worktreeName: 'webapp-84-dashboard',
    worktreePath: '/home/op/webapp',
    repo: 'webapp',
    issueNumber: 84,
    agent: 'claude',
    workerHandle: 'term_live',
    threadTs: THREAD,
    channelId: CHANNEL,
    cardTs: '1751970010.000100',
    title: 'Dashboard read-only web view',
  };

  // In flight on the live session, with a later bus heartbeat.
  clock = at(hours(3));
  delegations.recordDispatch(dispatch);
  clock = at(2);
  delegations.recordBusActivity('ctx_live');

  // Closed inside the window: one completed, one failed (with a stall that
  // the close settles). One completed before the window — must not appear.
  clock = at(hours(21));
  delegations.recordDispatch({ ...dispatch, dispatchId: 'ctx_done', taskId: 'task_done', workerHandle: 'term_done' });
  clock = at(hours(18));
  delegations.closeDelegation('ctx_done', 'completed');
  clock = at(hours(17));
  delegations.recordDispatch({ ...dispatch, dispatchId: 'ctx_fail', taskId: 'task_fail', workerHandle: 'term_fail' });
  delegations.recordStall({
    dispatchId: 'ctx_fail',
    threadTs: THREAD,
    channelId: CHANNEL,
    workerHandle: 'term_fail',
    worktreeName: 'webapp-84-dashboard',
    lastOutput: 'error: worktree dirty',
    fingerprint: 'fp-fail',
    relayTs: '1751970011.000200',
  });
  clock = at(hours(16));
  delegations.closeDelegation('ctx_fail', 'failed');
  clock = at(days(4) + hours(12));
  delegations.recordDispatch({ ...dispatch, dispatchId: 'ctx_old', taskId: 'task_old', workerHandle: 'term_old' });
  clock = at(days(3) + hours(12));
  delegations.closeDelegation('ctx_old', 'completed');

  // In flight on a thread with no session row — must not hide.
  clock = at(hours(2));
  delegations.recordDispatch({
    ...dispatch,
    dispatchId: 'ctx_orphan',
    taskId: 'task_orphan',
    workerHandle: 'term_orphan',
    threadTs: THREAD_ORPHAN,
    worktreeName: 'sandbox-21-bench',
    worktreePath: '/home/op/sandbox',
    repo: 'sandbox',
    issueNumber: 21,
    agent: 'codex',
    title: 'bench harness',
  });

  // Gates: a pending decision gate, a pending escalation, an answered one.
  clock = at(hours(2));
  delegations.recordGate({
    msgId: 'msg_answered',
    threadTs: THREAD,
    channelId: CHANNEL,
    taskId: null,
    dispatchId: null,
    workerHandle: 'term_live',
    worktreeName: 'webapp-84-dashboard',
    kind: 'decision_gate',
    question: 'Keep the old route alive?',
    options: ['yes', 'no'],
    relayTs: '1751970012.000300',
  });
  clock = at(115);
  delegations.answerGate('msg_answered');
  clock = at(hours(1));
  delegations.recordGate({
    msgId: 'msg_gate',
    threadTs: THREAD,
    channelId: CHANNEL,
    taskId: 'task_live',
    dispatchId: 'ctx_live',
    workerHandle: 'term_live',
    worktreeName: 'webapp-84-dashboard',
    kind: 'decision_gate',
    question: 'Migrations diverge — rebase or merge?',
    options: ['rebase', 'merge'],
    relayTs: '1751970013.000400',
  });
  clock = at(30);
  delegations.recordGate({
    msgId: 'msg_escalation',
    threadTs: THREAD,
    channelId: CHANNEL,
    taskId: 'task_live',
    dispatchId: 'ctx_live',
    workerHandle: 'term_live',
    worktreeName: 'webapp-84-dashboard',
    kind: 'escalation',
    question: 'CI is red on main — halt the merge?',
    options: [],
    relayTs: '1751970014.000500',
  });

  // The live worker's pending stall alert.
  clock = at(15);
  delegations.recordStall({
    dispatchId: 'ctx_live',
    threadTs: THREAD,
    channelId: CHANNEL,
    workerHandle: 'term_live',
    worktreeName: 'webapp-84-dashboard',
    lastOutput: '… waiting at a permissions prompt',
    fingerprint: 'fp-live',
    relayTs: '1751970015.000600',
  });

  sessions.close();
  delegations.close();
}

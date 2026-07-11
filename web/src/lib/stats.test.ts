import { describe, expect, it } from 'vitest';
import type { DelegationView, StateSnapshot } from '../api';
import { deriveOverviewStats } from './stats';

const delegation = (over: Partial<DelegationView>): DelegationView => ({
  dispatchId: 'ctx_a',
  threadTs: '1751970000.000100',
  repo: 'webapp',
  issueNumber: 84,
  agent: 'claude',
  worktreeName: 'webapp-84-dashboard',
  title: 'Dashboard read-only web view',
  status: 'dispatched',
  dispatchedAt: '2026-07-11T09:00:00.000Z',
  lastBusAt: null,
  closedAt: null,
  ...over,
});

const snapshot = (over: Partial<StateSnapshot>): StateSnapshot => ({
  asOf: '2026-07-11T12:00:00.000Z',
  noStateYet: false,
  daemon: { unitState: 'active' },
  sessions: [],
  pendingGates: [],
  pendingStalls: [],
  recentlyClosed: { delegations: [], sessions: [] },
  ...over,
});

const session = (delegations: DelegationView[]) => ({
  threadTs: '1751970000.000100',
  channelId: 'C0EXAMPLE123',
  status: 'open' as const,
  createdAt: '2026-07-11T08:00:00.000Z',
  lastActivityAt: '2026-07-11T11:00:00.000Z',
  turnCount: 2,
  costUsdTotal: 1.5,
  delegations,
});

const gate = {
  msgId: 'msg_gate',
  threadTs: '1751970000.000100',
  kind: 'decision_gate' as const,
  question: 'Rebase or merge?',
  options: ['rebase', 'merge'],
  worktreeName: 'webapp-84-dashboard',
  relayedAt: '2026-07-11T11:00:00.000Z',
};

const stall = {
  dispatchId: 'ctx_a',
  threadTs: '1751970000.000100',
  worktreeName: 'webapp-84-dashboard',
  lastOutput: 'waiting at a prompt',
  alertedAt: '2026-07-11T11:45:00.000Z',
};

describe('deriveOverviewStats', () => {
  it('is all zeros on an empty snapshot', () => {
    expect(deriveOverviewStats(snapshot({}))).toEqual({
      openSessions: 0,
      delegationsInFlight: 0,
      needsAttention: 0,
      closedTotal: 0,
      closedSessions: 0,
      closedCostUsd: 0,
    });
  });

  it('counts sessions, in-flight delegations, and pending gates + stalls', () => {
    const stats = deriveOverviewStats(
      snapshot({
        sessions: [session([delegation({}), delegation({ dispatchId: 'ctx_b' })]), session([])],
        pendingGates: [gate, { ...gate, msgId: 'msg_esc', kind: 'escalation' as const }],
        pendingStalls: [stall],
      }),
    );
    expect(stats.openSessions).toBe(2);
    expect(stats.delegationsInFlight).toBe(2);
    expect(stats.needsAttention).toBe(3);
  });

  it('counts only dispatched delegations as in flight', () => {
    const stats = deriveOverviewStats(
      snapshot({
        sessions: [
          session([
            delegation({}),
            delegation({ dispatchId: 'ctx_done', status: 'completed' }),
            delegation({ dispatchId: 'ctx_fail', status: 'failed' }),
          ]),
        ],
      }),
    );
    expect(stats.delegationsInFlight).toBe(1);
  });

  it('totals the recently-closed window: delegations, sessions, and session cost', () => {
    const stats = deriveOverviewStats(
      snapshot({
        recentlyClosed: {
          delegations: [
            delegation({ status: 'completed', closedAt: '2026-07-11T10:00:00.000Z' }),
            delegation({
              dispatchId: 'ctx_fail',
              status: 'failed',
              closedAt: '2026-07-11T09:30:00.000Z',
            }),
          ],
          sessions: [
            {
              threadTs: '1751970001.000200',
              channelId: 'C0EXAMPLE123',
              createdAt: '2026-07-06T10:00:00.000Z',
              lastActivityAt: '2026-07-10T10:00:00.000Z',
              closedAt: '2026-07-10T11:00:00.000Z',
              turnCount: 4,
              costUsdTotal: 2.25,
            },
            {
              threadTs: '1751970002.000300',
              channelId: 'C0EXAMPLE123',
              createdAt: '2026-07-06T10:00:00.000Z',
              lastActivityAt: '2026-07-09T10:00:00.000Z',
              closedAt: '2026-07-09T11:00:00.000Z',
              turnCount: 1,
              costUsdTotal: 0.4,
            },
          ],
        },
      }),
    );
    expect(stats.closedTotal).toBe(4);
    expect(stats.closedSessions).toBe(2);
    expect(stats.closedCostUsd).toBeCloseTo(2.65);
  });

  /**
   * The closed tile and the Recently closed section header both render
   * `closedTotal`. Every closed row the section lists — delegation or session —
   * must be inside it, or the strip contradicts the list right under it.
   */
  it('closedTotal counts every row the Recently closed section renders', () => {
    const closedSession = {
      threadTs: '1751970001.000200',
      channelId: 'C0EXAMPLE123',
      createdAt: '2026-07-06T10:00:00.000Z',
      lastActivityAt: '2026-07-10T10:00:00.000Z',
      closedAt: '2026-07-10T11:00:00.000Z',
      turnCount: 4,
      costUsdTotal: 2.25,
    };
    const recentlyClosed = {
      delegations: [
        delegation({ status: 'completed' as const, closedAt: '2026-07-11T10:00:00.000Z' }),
        delegation({ dispatchId: 'ctx_fail', status: 'failed' as const, closedAt: '2026-07-11T09:30:00.000Z' }),
        delegation({ dispatchId: 'ctx_c', status: 'completed' as const, closedAt: '2026-07-11T09:00:00.000Z' }),
      ],
      sessions: [closedSession, { ...closedSession, threadTs: '1751970002.000300' }],
    };
    const stats = deriveOverviewStats(snapshot({ recentlyClosed }));
    const rowsTheSectionRenders =
      recentlyClosed.delegations.length + recentlyClosed.sessions.length;

    expect(stats.closedTotal).toBe(rowsTheSectionRenders);
    expect(stats.closedTotal).toBe(5);
  });
});

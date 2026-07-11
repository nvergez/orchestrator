import type { StateSnapshot } from '../api';

/**
 * The overview strip's numbers, derived purely from the snapshot the page
 * already has — the tiles must never disagree with the sections below them.
 */
export interface OverviewStats {
  openSessions: number;
  delegationsInFlight: number;
  needsAttention: number;
  /** Everything the Recently closed section lists: its tile reads this, never its own sum. */
  closedTotal: number;
  closedSessions: number;
  closedCostUsd: number;
}

export function deriveOverviewStats(snapshot: StateSnapshot): OverviewStats {
  const { delegations, sessions } = snapshot.recentlyClosed;
  return {
    openSessions: snapshot.sessions.length,
    delegationsInFlight: snapshot.sessions.reduce(
      (count, session) =>
        count + session.delegations.filter((d) => d.status === 'dispatched').length,
      0,
    ),
    needsAttention: snapshot.pendingGates.length + snapshot.pendingStalls.length,
    closedTotal: delegations.length + sessions.length,
    closedSessions: sessions.length,
    closedCostUsd: sessions.reduce((sum, session) => sum + session.costUsdTotal, 0),
  };
}

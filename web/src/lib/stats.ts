import type { StateSnapshot } from '../api';

/**
 * The overview strip's numbers, derived purely from the snapshot the page
 * already has — the tiles must never disagree with the sections below them.
 */
export interface OverviewStats {
  openSessions: number;
  delegationsInFlight: number;
  needsAttention: number;
  closedDelegations: number;
  closedSessions: number;
  closedCostUsd: number;
}

export function deriveOverviewStats(snapshot: StateSnapshot): OverviewStats {
  return {
    openSessions: snapshot.sessions.length,
    delegationsInFlight: snapshot.sessions.reduce(
      (count, session) =>
        count + session.delegations.filter((d) => d.status === 'dispatched').length,
      0,
    ),
    needsAttention: snapshot.pendingGates.length + snapshot.pendingStalls.length,
    closedDelegations: snapshot.recentlyClosed.delegations.length,
    closedSessions: snapshot.recentlyClosed.sessions.length,
    closedCostUsd: snapshot.recentlyClosed.sessions.reduce(
      (sum, session) => sum + session.costUsdTotal,
      0,
    ),
  };
}

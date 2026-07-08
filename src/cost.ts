/**
 * Cost ledger arithmetic (spec §7 — measure-only, nothing ever blocks).
 * The SQLite `cost_usd_total` column is the persisted source of truth;
 * everything here is pure so crossings derive from before/after totals and
 * survive restarts for free — no "already warned" flag to keep in sync.
 */

/**
 * Thresholds crossed by a turn that moved the session total from `before`
 * to `after`, in ascending order. A threshold is crossed exactly when the
 * total reaches it (before < t ≤ after), so a monotonically growing ledger
 * crosses each threshold at most once per session — including across
 * restarts, since `before` comes from the persisted row.
 */
export function crossedThresholds(
  before: number,
  after: number,
  thresholds: readonly number[],
): number[] {
  return [...thresholds].sort((a, b) => a - b).filter((t) => before < t && after >= t);
}

/**
 * The SDK reports `total_cost_usd` cumulatively per `query()` call — every
 * result message carries the running total since its process started, and a
 * cold-resumed process starts back at zero. This meter turns those running
 * totals into per-turn deltas; one instance lives and dies with one process.
 */
export class TurnCostMeter {
  private reportedUsd = 0;

  /** Per-turn cost given the process-cumulative total from a result message. */
  turnCost(cumulativeUsd: number): number {
    const delta = Math.max(0, cumulativeUsd - this.reportedUsd);
    this.reportedUsd = cumulativeUsd;
    return delta;
  }
}

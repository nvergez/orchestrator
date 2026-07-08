/**
 * Reference verbatims fixed by the Slack UX mock (spec §8,
 * docs/prototypes/slack-ux/conversations.md).
 */

/** Scenario G1 — root @mention by a third party. */
export function refusalLine(allowedUserId: string): string {
  return `v1: only <@${allowedUserId}> can drive me.`;
}

/**
 * Scenario D — 💸 cost threshold crossed (spec §7: measure-only, so the line
 * itself says nothing is blocked). The mock's `**bold**` is doc markdown for
 * Slack bold, hence single asterisks here. The second line is dropped once
 * the last configured threshold is crossed — there is no next warning.
 */
export function costWarningLine(
  totalUsd: number,
  crossedThresholdUsd: number,
  nextThresholdUsd?: number,
): string {
  const line =
    `💸 This thread has cost *$${totalUsd.toFixed(2)}* ` +
    `($${crossedThresholdUsd} threshold crossed) — info only, nothing is blocked.`;
  if (nextThresholdUsd === undefined) return line;
  return `${line}\nNext warning at $${nextThresholdUsd}.`;
}

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

/** Scenario B — the one-line autonomy gate: `🚦 <command> on <worktree> — go?` */
export function gateLine(command: string, worktree?: string): string {
  const location = worktree === undefined ? '' : ` on \`${worktree}\``;
  return `🚦 \`${command}\`${location} — go?`;
}

/**
 * Issue #10 §4 — the one-line conditional routing gate, posted by the session
 * whenever repo or agent was inferred. Spec §4 shows the short form; the
 * ticket (which wins) appends the "name another" escape hatch.
 */
export function delegationGateLine(repo: string, agent: string): string {
  return `→ I'm delegating on *${repo}* with *${agent}*. Go? (or name another repo/agent)`;
}

/** Zero match — stop + list (scenario "Zero match" in the mock, issue #10 §2). */
export function zeroMatchLine(repoNames: string[]): string {
  const list = repoNames.map((name) => `\`${name}\``).join(', ');
  return `No repo I drive matches. I know: ${list}. Rephrase targeting one of them.`;
}

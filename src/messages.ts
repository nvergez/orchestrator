/**
 * Reference verbatims fixed by the Slack UX mock (spec §8,
 * docs/prototypes/slack-ux/conversations.md).
 */

/** Scenario G1 — root @mention by a third party. */
export function refusalLine(allowedUserId: string): string {
  return `v1: only <@${allowedUserId}> can drive me.`;
}

/** Canned walking-skeleton acknowledgment — no Claude behind it yet (#14). */
export const ACK_TEXT =
  '👋 Heard. Walking skeleton online — canned reply, no brain wired up yet.';

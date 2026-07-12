/** Slack identifies a thread by conversation plus root-message timestamp. */
export interface SlackThread {
  channelId: string;
  threadTs: string;
}

/** Collision-free in-memory key for maps that span configured channels. */
export function slackThreadKey(threadTs: string, channelId: string): string {
  return `${channelId}:${threadTs}`;
}

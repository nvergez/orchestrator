/** Slack identifies a thread by conversation plus root-message timestamp. */
export interface SlackThread {
  channelId: string;
  threadTs: string;
}

/** Collision-free in-memory key for maps that span configured channels. */
export function slackThreadKey(thread: SlackThread): string;
export function slackThreadKey(threadTs: string, channelId: string): string;
export function slackThreadKey(threadOrTs: SlackThread | string, channelId?: string): string {
  if (typeof threadOrTs === 'string' && channelId === undefined) {
    throw new Error('channelId is required to identify a Slack thread');
  }
  const thread =
    typeof threadOrTs === 'string'
      ? { threadTs: threadOrTs, channelId: channelId as string }
      : threadOrTs;
  return `${thread.channelId}:${thread.threadTs}`;
}

import { createHash } from 'node:crypto';
import type { DelegationRow, DelegationStore } from './delegations.ts';
import type { ThreadSurface } from './thread-surface.ts';

/** Deliver from the durable result, checkpointing each successful Slack post.
 * A Slack failure leaves the remaining answer and worktree for a retry. */
export async function deliverQuestion(row: DelegationRow, store: DelegationStore, surface: ThreadSurface): Promise<void> {
  if (row.kind !== 'question' || row.status !== 'completed' || row.resultText === null) return;
  const progress = store.questionDeliveryProgress(row.dispatchId);
  if (progress.finished) return;
  const answer = row.resultText;
  let offset = progress.postedChars;
  while (offset < answer.length) {
    let end = Math.min(offset + 3500, answer.length);
    // Never split a UTF-16 surrogate pair. No trimming or inserted text:
    // concatenating the posted bodies reproduces the worker's exact answer.
    if (end < answer.length && /[\uD800-\uDBFF]/.test(answer[end - 1]!)) end -= 1;
    const digest = createHash('sha256').update(`${row.dispatchId}:${offset}`).digest('hex');
    const clientMessageId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    await surface.post(row.channelId, row.threadTs, answer.slice(offset, end), clientMessageId);
    offset = end;
    store.recordQuestionDelivery(row.dispatchId, offset);
  }
  await surface.finishCard(row, {
    durationMs: Date.parse(row.closedAt ?? row.dispatchedAt) - Date.parse(row.dispatchedAt),
    issueUrl: undefined,
    reportText: answer,
  });
  // Reactions belong to the terminal event (or reconciliation batch), not
  // this potentially delayed retry of its human-readable answer.
  await surface.cleanupDeliveredWorktree(row);
  store.recordQuestionDelivery(row.dispatchId, offset, true);
}

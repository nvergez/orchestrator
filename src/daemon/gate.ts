import type { Logger } from '../kernel/logger.ts';

/**
 * The 🚦 confirm gate (spec §7/§8): a CONFIRM-tier command suspends inside
 * `canUseTool` while a one-line gate message sits in the thread; an
 * allowed user's next reply — and nobody else's — resolves it (issue #93:
 * the allow-list is one shared trust boundary, not per-thread ownership).
 * "go" — bare
 * or with a trailing comment ("go — <note>", issue #47) — releases exactly
 * that call; anything else cancels it, with the verbatim reply relayed back
 * to the session so it can react.
 *
 * Pending gates are pure runtime state (spec §9): a daemon restart kills the
 * suspended turn anyway, so there is nothing durable to persist.
 */

export interface GateVerdict {
  approved: boolean;
  /** The human's verbatim reply, or a synthetic reason when nobody answered. */
  reply: string;
}

/** The slice of GateKeeper that `canUseTool` suspends on. */
export interface GateRequester {
  request(
    threadTs: string,
    channelId: string,
    gateText: string,
    signal?: AbortSignal,
  ): Promise<GateVerdict>;
}

/** The slice the Slack event path resolves gates through. */
export interface GateResolver {
  tryResolve(threadTs: string, channelId: string, userId: string, text: string): boolean;
}

/** The slice a session process holds: suspend on gates, release them at death. */
export interface SessionGates extends GateRequester {
  cancelThread(threadTs: string, channelId: string): void;
}

/**
 * Replies that count as approval, normalized. The mock fixes "go"; the rest
 * are its everyday equivalents, kept to a deliberately small closed set:
 * anything unrecognized denies (fail-closed) but travels back verbatim, so a
 * "wait, rebase first" both cancels the call and tells the session why.
 */
const APPROVALS = new Set([
  'go',
  'go ahead',
  'yes',
  'y',
  'yep',
  'yeah',
  'ok',
  'okay',
  'approve',
  'approved',
  '👍',
  '✅',
]);

/**
 * What may sit between an approval token and a trailing comment (issue #47):
 * real punctuation or a newline. Deliberately NOT a bare space ("go later
 * maybe" is not an approval), NOT "?" ("go?" is a question), and an ASCII
 * hyphen only separates with whitespace before it — glued it reads as a
 * compound word ("ok-ish"), which is a hedge, not an approval.
 */
const PREFIX_SEPARATOR = /^(\s*[,.;:!…—–]|\s+-|\s*\n)/;

export function isApproval(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const bare = normalized.replace(/[.!]+$/, '').trim();
  if (APPROVALS.has(bare)) return true;
  // Approval-prefix (issue #47): "go — <comment>" / "yes, but <caveat>" /
  // "ok. also <more>" approve. Only the leading token decides; the whole
  // reply still travels back in the verdict, so the comment reaches the
  // session verbatim instead of silently re-gating the same command.
  for (const approval of APPROVALS) {
    if (
      normalized.startsWith(approval) &&
      PREFIX_SEPARATOR.test(normalized.slice(approval.length))
    ) {
      return true;
    }
  }
  return false;
}

interface PendingGate {
  settle(verdict: GateVerdict): void;
}

export interface GateKeeperOptions {
  /** The authorized humans (issue #93) — any of them may resolve a gate. */
  allowedUserIds: readonly string[];
  /** chat.postMessage into the thread — how the 🚦 line reaches the human. */
  post: (threadTs: string, channelId: string, text: string) => Promise<unknown>;
  logger: Logger;
}

export class GateKeeper implements SessionGates, GateResolver {
  private readonly allowedUserIds: readonly string[];
  private readonly post: (threadTs: string, channelId: string, text: string) => Promise<unknown>;
  private readonly logger: Logger;
  /** FIFO of unanswered gates per thread (keyed `channelId:threadTs`) —
   * one reply resolves one gate. */
  private readonly pending = new Map<string, PendingGate[]>();

  constructor(options: GateKeeperOptions) {
    this.allowedUserIds = options.allowedUserIds;
    this.post = options.post;
    this.logger = options.logger;
  }

  /** Suspends until the thread answers; resolves with the human's verdict. */
  async request(
    threadTs: string,
    channelId: string,
    gateText: string,
    signal?: AbortSignal,
  ): Promise<GateVerdict> {
    if (signal?.aborted === true) {
      return { approved: false, reply: 'the session was interrupted before the gate was posted' };
    }

    let resolvePromise!: (verdict: GateVerdict) => void;
    const verdict = new Promise<GateVerdict>((resolve) => {
      resolvePromise = resolve;
    });

    let settled = false;
    const key = threadKey(threadTs, channelId);
    const gate: PendingGate = {
      settle: (result) => {
        if (settled) return;
        settled = true;
        this.remove(key, gate);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(result);
      },
    };
    const onAbort = (): void =>
      gate.settle({ approved: false, reply: 'the session was interrupted while the gate was pending' });

    const queue = this.pending.get(key) ?? [];
    queue.push(gate);
    this.pending.set(key, queue);
    signal?.addEventListener('abort', onAbort);

    try {
      await this.post(threadTs, channelId, gateText);
      this.logger.info({ threadTs, gateText }, '🚦 gate posted, call suspended');
    } catch (error) {
      // If the human can never see the gate, the call must not hang forever.
      this.logger.warn({ err: error, threadTs }, 'could not post 🚦 gate message');
      gate.settle({ approved: false, reply: 'the 🚦 gate message could not be posted to Slack' });
    }
    return verdict;
  }

  /**
   * Routes a thread reply into the oldest pending gate. Returns true when the
   * reply was consumed (it must not also become a session turn). Replies from
   * anyone but the authorized user never resolve anything — defense in depth
   * behind the source filter (spec §7).
   */
  tryResolve(threadTs: string, channelId: string, userId: string, text: string): boolean {
    const queue = this.pending.get(threadKey(threadTs, channelId));
    const gate = queue?.[0];
    if (gate === undefined) return false;
    if (!this.allowedUserIds.includes(userId)) {
      this.logger.warn({ threadTs, userId }, 'gate reply from a non-authorized user ignored');
      return false;
    }
    const approved = isApproval(text);
    this.logger.info({ threadTs, approved, reply: text }, '🚦 gate resolved');
    gate.settle({ approved, reply: text });
    return true;
  }

  /** Denies whatever is still pending when a thread's process goes away. */
  cancelThread(threadTs: string, channelId: string): void {
    const queue = this.pending.get(threadKey(threadTs, channelId));
    if (queue === undefined) return;
    for (const gate of [...queue]) {
      gate.settle({ approved: false, reply: 'the session ended before the gate was answered' });
    }
  }

  private remove(key: string, gate: PendingGate): void {
    const queue = this.pending.get(key);
    if (queue === undefined) return;
    const index = queue.indexOf(gate);
    if (index !== -1) queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(key);
  }
}

/** The (channel, thread) pair flattened for the pending map (issue #93). */
function threadKey(threadTs: string, channelId: string): string {
  return `${channelId}:${threadTs}`;
}

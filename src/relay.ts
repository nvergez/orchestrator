import { commandSegments, flagValue, hasFlag, isOrcaCommand, shellQuote } from './guardrails.ts';
import { parseOrcaEnvelope } from './orca.ts';
import { applyRootReaction, type ReactionSurface, type RootReaction } from './watcher.ts';
import type { DelegationStore, PendingGateRow } from './delegations.ts';
import type { PrepareVerdict } from './dispatch.ts';
import type { Logger } from './logger.ts';

/**
 * The route-back-down half of the gate relay (spec §6, issue #21). The
 * SESSION routes a human reply — the LLM, anchored on the `pending_gates`
 * registry, decides which gate (if any) the message answers and runs
 * `orca orchestration reply --id <msg_id>`. This coordinator is the code
 * around that judgment call, riding the same seams as the delegation
 * coordinator (issue #19):
 *
 * - `decorateReply` (from the Slack event path): threads with relayed gates
 *   get the registry snapshot prepended to the human's message — the "turn
 *   context" the routing instructions in the system prompt anchor on.
 * - `prepare` (from canUseTool): hard enforcement the LLM cannot drift past.
 *   A reply may only target one of THIS thread's gates (cross-thread routing
 *   is impossible by construction), an answered gate never re-routes, and a
 *   bare option number is rewritten to that option's exact text — fidelity
 *   is absolute, the worker receives the option verbatim.
 * - `sanctionsSend` (from canUseTool, before the tier verdict): `terminal
 *   send` is CONFIRM by classification, but a send targeting the worker
 *   terminal of a gate this thread relayed carries a human answer — the
 *   reply-failure fallback or a best-effort late correction (issue #9) — so
 *   it runs AUTO, without the 🚦 ceremony.
 * - `observe` (from the PostToolUse hook): a reply (or fallback send) that
 *   actually succeeded flips the gate to `answered` and settles the root
 *   reaction — ❓/🚨 while gates remain, back to 👀 when none do.
 *
 * `gate-resolve` never appears here: DAG gates are reserved for coordinator
 * DAG decisions (issue #9), and the classifier gates the command itself.
 */

export interface GateRelayOptions {
  store: DelegationStore;
  surface: ReactionSurface;
  logger: Logger;
}

/** The slice a session process holds (canUseTool + hooks, issue #21). */
export interface SessionRelay {
  sanctionsSend(threadTs: string, command: string): boolean;
  prepare(threadTs: string, command: string): PrepareVerdict;
  observe(threadTs: string, command: string, stdout: string): Promise<void>;
}

export class GateRelay implements SessionRelay {
  private readonly store: DelegationStore;
  private readonly surface: ReactionSurface;
  private readonly logger: Logger;

  constructor(options: GateRelayOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.logger = options.logger;
  }

  // ── the turn context ─────────────────────────────────────────────────────

  /**
   * Prepends the thread's gate registry to a human message (spec §6: the
   * session routes "anchored on the registry"). Answered gates ride along so
   * the LLM can recognize — and refuse to re-route — a late correction. A
   * thread that never relayed a gate passes through untouched.
   */
  decorateReply(threadTs: string, text: string): string {
    const gates = this.store.listGatesForThread(threadTs);
    if (gates.length === 0) return text;
    return [
      '[relayed worker gates — daemon context, not part of the human message]',
      ...gates.map((gate) => contextLine(gate)),
      'Follow your worker-gate instructions. The human message follows:',
      '---',
      text,
    ].join('\n');
  }

  // ── prepare: the canUseTool seam ─────────────────────────────────────────

  /**
   * True for the one sanctioned `terminal send`: a single-segment, --json
   * send whose --terminal is the worker handle of a gate this thread
   * relayed. Anything else keeps its CONFIRM tier.
   */
  sanctionsSend(threadTs: string, command: string): boolean {
    const segments = commandSegments(command);
    if (segments.length !== 1) return false;
    const tokens = segments[0] as string[];
    if (!isOrcaCommand(tokens, 'terminal', 'send')) return false;
    if (!hasFlag(tokens, '--json')) return false;
    const handle = flagValue(tokens, '--terminal');
    if (handle === undefined) return false;
    return this.store
      .listGatesForThread(threadTs)
      .some((gate) => gate.workerHandle === handle);
  }

  /** Registry enforcement on `orchestration reply` — non-reply commands pass. */
  prepare(threadTs: string, command: string): PrepareVerdict {
    const segments = commandSegments(command);
    const replies = segments.filter((tokens) => isOrcaCommand(tokens, 'orchestration', 'reply'));
    if (replies.length === 0) return { action: 'proceed', command };
    // One reply per command, alone: the observer maps one --json envelope to
    // one gate flip, and the fidelity rewrite must know what it rebuilds.
    if (segments.length > 1) {
      return deny(
        'run `orca orchestration reply` as its own command — nothing chained around it',
      );
    }
    const tokens = replies[0] as string[];

    const msgId = flagValue(tokens, '--id');
    if (msgId === undefined) {
      return deny('the reply must target a gate: --id <msg_id> from the relayed-gates context');
    }
    const gate = this.store.getGate(msgId);
    if (gate === undefined || gate.threadTs !== threadTs) {
      // Cross-thread routing is impossible by construction (issue #9): a
      // reply in this thread can only reach this thread's own gates.
      return deny(
        `\`${msgId}\` is not a gate relayed in this thread — replies only route back ` +
          "to this thread's own relayed gates (spec §6)",
      );
    }
    if (gate.status === 'answered') {
      const handle = gate.workerHandle ?? '<worker handle>';
      return deny(
        'that gate was already answered — an answered gate never re-routes (spec §6). ' +
          'Tell the user their earlier answer went down; if this is a correction, pass it ' +
          `best-effort with \`orca terminal send --terminal ${handle} --text "<correction>" ` +
          '--enter --json` and say there is no cancellation guarantee',
      );
    }
    if (!hasFlag(tokens, '--json')) {
      return deny('`orca orchestration reply` must carry --json here — add it and retry');
    }
    const body = flagValue(tokens, '--body');
    if (body === undefined || body.trim() === '') {
      return deny('the reply must carry --body "<the exact answer text>"');
    }

    // Fidelity is absolute (issue #9): a bare option number goes down as
    // that option's exact text — rewritten here so no paraphrase can slip
    // between the human's "2" and the worker's stdin.
    const choice = /^(\d+)\.?$/.exec(body.trim());
    if (choice !== null && gate.options.length > 0) {
      const index = Number(choice[1]);
      const option = gate.options[index - 1];
      if (index < 1 || option === undefined) {
        return deny(
          `that gate has ${gate.options.length} option${gate.options.length === 1 ? '' : 's'} — ` +
            `there is no option ${index}. Ask the human which they meant; do not guess`,
        );
      }
      const rewritten = tokens
        .map((token, i) => {
          if (token.startsWith('--body=')) return `--body=${option}`;
          return tokens[i - 1] === '--body' ? option : token;
        })
        .map(shellQuote)
        .join(' ');
      this.logger.info(
        { threadTs, msgId, choice: index, option },
        'bare option number rewritten to the option text — fidelity',
      );
      return { action: 'proceed', command: rewritten };
    }
    return { action: 'proceed', command };
  }

  // ── observe: the PostToolUse seam ────────────────────────────────────────

  /** Reads a finished command's output. Never throws — hooks must not crash a turn. */
  async observe(threadTs: string, command: string, stdout: string): Promise<void> {
    try {
      for (const tokens of commandSegments(command)) {
        if (isOrcaCommand(tokens, 'orchestration', 'reply')) {
          await this.observeReply(tokens, stdout);
        } else if (isOrcaCommand(tokens, 'terminal', 'send')) {
          await this.observeSend(threadTs, tokens, stdout);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, threadTs, command }, 'gate relay observer failed');
    }
  }

  /** A reply that reached the bus answers its gate — pending → answered. */
  private async observeReply(tokens: string[], stdout: string): Promise<void> {
    if (parseOrcaEnvelope(stdout) === null) return; // failed → the gate stays pending
    const msgId = flagValue(tokens, '--id');
    if (msgId === undefined) return;
    const gate = this.store.getGate(msgId);
    if (gate === undefined || !this.store.answerGate(msgId)) return;
    this.logger.info(
      { threadTs: gate.threadTs, msgId, workerHandle: gate.workerHandle },
      'gate answered — human reply relayed down',
    );
    await this.settleRootReaction(gate.threadTs);
  }

  /**
   * A sanctioned fallback send also answers the (oldest) pending gate of its
   * worker — the reply path failed, but the human's answer went down. A send
   * to a worker with only answered gates is a late correction: nothing to flip.
   */
  private async observeSend(threadTs: string, tokens: string[], stdout: string): Promise<void> {
    if (parseOrcaEnvelope(stdout) === null) return;
    const handle = flagValue(tokens, '--terminal');
    if (handle === undefined) return;
    const gate = this.store
      .listPendingGates(threadTs)
      .find((candidate) => candidate.workerHandle === handle);
    if (gate === undefined || !this.store.answerGate(gate.msgId)) return;
    this.logger.info(
      { threadTs, msgId: gate.msgId, workerHandle: handle },
      'gate answered via the terminal send fallback',
    );
    await this.settleRootReaction(gate.threadTs);
  }

  /** ❓/🚨 while gates remain, 👀 when the last one was answered (spec §8). */
  private async settleRootReaction(threadTs: string): Promise<void> {
    const pending = this.store.listPendingGates(threadTs);
    const name: RootReaction =
      pending.length === 0
        ? 'eyes'
        : pending.some((gate) => gate.kind === 'escalation')
          ? 'rotating_light'
          : 'question';
    await applyRootReaction(this.surface, this.logger, threadTs, name);
  }
}

const deny = (message: string): PrepareVerdict => ({ action: 'deny', message });

/** One registry row, flattened for the LLM's turn context. */
function contextLine(gate: PendingGateRow): string {
  const status = gate.status === 'pending' ? 'PENDING' : 'ANSWERED';
  const kind = gate.kind === 'escalation' ? '🚨 escalation' : '❓ question';
  const from = gate.worktreeName === null ? 'an unmatched worker' : `\`${gate.worktreeName}\``;
  const parts = [
    `- [${status}] ${kind} ${gate.msgId} from ${from} (ack ref: ${gateRef(gate)}` +
      `${gate.workerHandle === null ? '' : `, worker terminal ${gate.workerHandle}`})`,
    `  asked: "${gate.question}"`,
  ];
  if (gate.options.length > 0) {
    parts.push(`  options: ${gate.options.map((option, i) => `${i + 1}) ${option}`).join(' · ')}`);
  }
  return parts.join('\n');
}

/** `repo#n` out of the worktree name, degrading to the task id / message id. */
function gateRef(gate: PendingGateRow): string {
  const match = gate.worktreeName === null ? null : /^(.*?)-(\d+)-/.exec(gate.worktreeName);
  if (match !== null) return `${match[1]}#${match[2]}`;
  return gate.taskId ?? gate.msgId;
}

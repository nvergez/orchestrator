import { commandSegments, flagValue, hasFlag, isOrcaCommand, shellQuote } from '../kernel/guardrails.ts';
import { parseOrcaEnvelope } from '../kernel/orca.ts';
import { worktreeIssueRef } from './worktree-name.ts';
import type { ThreadSurface } from './thread-surface.ts';
import type { PrepareVerdict } from './dispatch.ts';
import type { DelegationStore, PendingGateRow, StallAlertRow } from './delegations.ts';
import type { Logger } from '../kernel/logger.ts';

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
 *   bare option number is rewritten to that option's exact text — on the
 *   reply body and on the gate-answer `terminal send` fallback alike (issue
 *   #50): fidelity is absolute, the worker receives the option verbatim.
 * - `sanctionsSend` (from canUseTool, before the tier verdict): `terminal
 *   send` is CONFIRM by classification, but a send targeting the worker
 *   terminal of a gate this thread relayed carries a human answer — the
 *   reply-failure fallback or a best-effort late correction (issue #9) — so
 *   it runs AUTO, without the 🚦 ceremony. A pending watchdog stall alert
 *   (issue #22) vouches the same way: a stalled worker has no `ask` to
 *   reply to, so the sanctioned send IS its answer path.
 * - `observe` (from the PostToolUse hook): a reply (or fallback send) that
 *   actually succeeded flips the gate — or the stall alert the send just
 *   nudged — to `answered` and settles the root reaction — ❓/🚨 while
 *   gates or stalls remain, back to 👀 when none do.
 *
 * `gate-resolve` never appears here: DAG gates are reserved for coordinator
 * DAG decisions (issue #9), and the classifier gates the command itself.
 */

export interface GateRelayOptions {
  store: DelegationStore;
  surface: ThreadSurface;
  logger: Logger;
}

/** The slice canUseTool consults before a command runs (issue #21). */
export interface RelayPolicy {
  sanctionsSend(threadTs: string, command: string): boolean;
  prepare(threadTs: string, command: string): PrepareVerdict;
}

/** The slice the PostToolUse hooks feed after a command ran. */
export interface RelayObserver {
  observe(threadTs: string, command: string, stdout: string): Promise<void>;
}

/** What a session process holds — both seams together. */
export type SessionRelay = RelayPolicy & RelayObserver;

export class GateRelay implements SessionRelay {
  private readonly store: DelegationStore;
  private readonly surface: ThreadSurface;
  private readonly logger: Logger;
  /**
   * The last reply attempt per thread — how the follow-up `terminal send`
   * is attributed to a gate. A FAILED reply's send is the fallback and
   * answers exactly that gate; a send after an answered-gate denial is a
   * late correction and flips nothing. Runtime-only state: the send follows
   * its reply within the same turn, and losing it merely degrades the
   * attribution to the unambiguous-single-pending heuristic below.
   */
  private readonly lastReply = new Map<string, { msgId: string; outcome: 'failed' | 'correction' }>();

  constructor(options: GateRelayOptions) {
    this.store = options.store;
    this.surface = options.surface;
    this.logger = options.logger;
  }

  // ── the turn context ─────────────────────────────────────────────────────

  /**
   * Prepends the thread's gate and stall-alert registries to a human message
   * (spec §6: the session routes "anchored on the registry"). Answered
   * entries ride along so the LLM can recognize — and refuse to re-route —
   * a late correction, and closed entries so it can tell the human a moot
   * question apart from an open one (issue #46). Superseded rows stay out:
   * their question lives on in the re-ask successor, and listing both would
   * recreate exactly the duplicate-gate disambiguation noise the supersede
   * exists to kill. A thread that never relayed anything passes through
   * untouched.
   */
  decorateReply(threadTs: string, text: string): string {
    const gates = this.store
      .listGatesForThread(threadTs)
      .filter((gate) => gate.status !== 'superseded');
    const stalls = this.store.listStallsForThread(threadTs);
    if (gates.length === 0 && stalls.length === 0) return text;
    return [
      '[relayed worker gates & watchdog stall alerts — daemon context, not part of the human message]',
      ...gates.map((gate) => contextLine(gate)),
      ...stalls.map((stall) => stallContextLine(stall)),
      'Follow your worker-gate instructions. The human message follows:',
      '---',
      text,
    ].join('\n');
  }

  // ── prepare: the canUseTool seam ─────────────────────────────────────────

  /**
   * True for the sanctioned `terminal send`: a single-segment, --json send
   * to a worker this thread's registry vouches for RIGHT NOW — the worker
   * still has a pending gate here (the reply-failure fallback), a pending
   * watchdog stall alert (issue #22: the nudge IS the answer path — there
   * is no `ask` to reply to), or the thread's last reply attempt named one
   * of its gates (the late correction the denial pointed at). Anything else
   * keeps its CONFIRM tier: a worker whose gates and stalls are long
   * answered must not stay a silent AUTO target forever.
   */
  sanctionsSend(threadTs: string, command: string): boolean {
    const segments = commandSegments(command);
    if (segments.length !== 1) return false;
    const tokens = segments[0] as string[];
    if (!isOrcaCommand(tokens, 'terminal', 'send')) return false;
    if (!hasFlag(tokens, '--json')) return false;
    const handle = flagValue(tokens, '--terminal');
    if (handle === undefined) return false;
    const last = this.lastReply.get(threadTs);
    if (last !== undefined && this.store.getGate(last.msgId)?.workerHandle === handle) {
      return true;
    }
    return (
      this.store.listPendingGates(threadTs).some((gate) => gate.workerHandle === handle) ||
      // The stall nudge must land as an ANSWER: keystrokes plus enter (spec
      // §6) — a send without --enter would leave the prompt sitting, so it
      // keeps its 🚦 instead of riding the stall's sanction.
      (hasFlag(tokens, '--enter') &&
        this.store.listPendingStalls(threadTs).some((stall) => stall.workerHandle === handle))
    );
  }

  /** Registry enforcement on `orchestration reply` — non-reply commands pass. */
  prepare(threadTs: string, command: string): PrepareVerdict {
    const segments = commandSegments(command);
    const replies = segments.filter((tokens) => isOrcaCommand(tokens, 'orchestration', 'reply'));
    if (replies.length === 0) return this.prepareSend(threadTs, command, segments);
    // One reply per command, alone: the observer maps one --json envelope to
    // one gate flip, and the fidelity rewrite must know what it rebuilds.
    if (segments.length > 1) {
      return deny(
        'run `orca orchestration reply` as its own command — nothing chained around it',
      );
    }
    let tokens = replies[0] as string[];

    const msgId = flagValue(tokens, '--id');
    if (msgId === undefined) {
      return deny('the reply must target a gate: --id <msg_id> from the relayed-gates context');
    }
    let gate = this.store.getGate(msgId);
    if (gate === undefined || gate.threadTs !== threadTs) {
      // Cross-thread routing is impossible by construction (issue #9): a
      // reply in this thread can only reach this thread's own gates.
      return deny(
        `\`${msgId}\` is not a gate relayed in this thread — replies only route back ` +
          "to this thread's own relayed gates (spec §6)",
      );
    }
    let rewritten = false;
    if (gate.status === 'superseded') {
      // A stale re-asked gate forwards to the one ask the worker still
      // listens on (issue #46): a reply down the stale id returns ok:true
      // into a void — the known expired-ask trap. Same question, so the
      // human's answer applies to the successor verbatim.
      const successor = this.successorOf(gate);
      if (successor === undefined) {
        return deny(
          'that question was re-asked and this gate superseded — reply to the live gate ' +
            'from the relayed-gates context instead',
        );
      }
      tokens = replaceFlagValue(tokens, '--id', successor.msgId);
      rewritten = true;
      this.logger.info(
        { threadTs, staleMsgId: msgId, msgId: successor.msgId },
        'reply to a superseded gate forwarded to its live re-ask',
      );
      gate = successor;
    }
    if (gate.status === 'closed') {
      return deny(
        'that question is moot — its delegation already closed with the gate unanswered ' +
          '(issue #46), so nothing listens for a reply. Tell the user instead of routing it',
      );
    }
    if (gate.status === 'answered') {
      // Remember the denial: it sanctions the correction send that follows,
      // and tells observeSend that send answers nothing new.
      this.lastReply.set(threadTs, { msgId: gate.msgId, outcome: 'correction' });
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
    const choice = optionChoice(gate, body);
    if (choice !== null) {
      if (choice.option === undefined) return noSuchOption(gate, choice.index);
      tokens = replaceFlagValue(tokens, '--body', choice.option);
      rewritten = true;
      this.logger.info(
        { threadTs, msgId: gate.msgId, choice: choice.index, option: choice.option },
        'bare option number rewritten to the option text — fidelity',
      );
    }
    if (!rewritten) return { action: 'proceed', command };
    return { action: 'proceed', command: tokens.map(shellQuote).join(' ') };
  }

  /**
   * The same fidelity on the send half (issue #50): the reply-failure
   * fallback and the late correction type the human's answer straight into
   * the worker terminal, and a bare digit there is exactly as ambiguous as
   * on the reply — it only means the right thing against the numbering the
   * worker happens to hold at that moment (a re-ask may have renumbered,
   * issue #46). So a lone `terminal send` whose --text is a bare option
   * number types the selected option's verbatim text instead. Free text —
   * and every send the registry cannot attribute to an options-carrying
   * gate — passes through untouched.
   */
  private prepareSend(threadTs: string, command: string, segments: string[][]): PrepareVerdict {
    const untouched: PrepareVerdict = { action: 'proceed', command };
    // Only a lone send can be rebuilt from tokens — a chained one keeps its
    // CONFIRM tier anyway (sanctionsSend refuses multi-segment commands).
    if (segments.length !== 1) return untouched;
    let tokens = segments[0] as string[];
    if (!isOrcaCommand(tokens, 'terminal', 'send')) return untouched;
    const handle = flagValue(tokens, '--terminal');
    const text = flagValue(tokens, '--text');
    if (handle === undefined || text === undefined) return untouched;
    const gate = this.sendGate(threadTs, handle);
    if (gate === undefined) return untouched;
    const choice = optionChoice(gate, text);
    if (choice === null) return untouched;
    if (choice.option === undefined) return noSuchOption(gate, choice.index);
    tokens = replaceFlagValue(tokens, '--text', choice.option);
    this.logger.info(
      { threadTs, msgId: gate.msgId, workerHandle: handle, choice: choice.index, option: choice.option },
      'bare option number in a gate-answer send rewritten to the option text — fidelity',
    );
    return { action: 'proceed', command: tokens.map(shellQuote).join(' ') };
  }

  /**
   * The gate a send to this worker carries an answer for — observeSend's
   * attribution, applied before the send runs: the gate the thread's last
   * reply named (followed through any supersede chain, so the options are
   * the LIVE ask's — the numbering the worker is showing), else the
   * worker's single pending gate. A pending stall alert on the same worker
   * blocks that heuristic: stall answers are literal keystrokes for
   * whatever prompt the terminal shows (issue #22) — only the explicit
   * last-reply attribution outranks a stall.
   */
  private sendGate(threadTs: string, handle: string): PendingGateRow | undefined {
    const last = this.lastReply.get(threadTs);
    if (last !== undefined) {
      const named = this.store.getGate(last.msgId);
      if (named !== undefined && named.workerHandle === handle) {
        const live = this.successorOf(named);
        // A closed gate never routes an answer (issue #46: the question is
        // moot) — a send after its delegation ended stays untouched rather
        // than rewritten against a dead ask's numbering.
        return live?.status === 'closed' ? undefined : live;
      }
    }
    if (this.store.listPendingStalls(threadTs).some((stall) => stall.workerHandle === handle)) {
      return undefined;
    }
    const pending = this.store
      .listPendingGates(threadTs)
      .filter((gate) => gate.workerHandle === handle);
    return pending.length === 1 ? pending[0] : undefined;
  }

  /**
   * The end of a superseded gate's re-ask chain — whatever its terminal
   * status, so the caller's pending/answered/closed handling applies to the
   * gate that actually owns the question now. Undefined on a dangling
   * pointer or a cycle (a hand-edited registry) — refuse rather than guess.
   */
  private successorOf(gate: PendingGateRow): PendingGateRow | undefined {
    const seen = new Set<string>([gate.msgId]);
    let current = gate;
    while (current.status === 'superseded') {
      if (current.supersededBy === null || seen.has(current.supersededBy)) return undefined;
      seen.add(current.supersededBy);
      const next = this.store.getGate(current.supersededBy);
      if (next === undefined || next.threadTs !== gate.threadTs) return undefined;
      current = next;
    }
    return current;
  }

  // ── observe: the PostToolUse seam ────────────────────────────────────────

  /** Reads a finished command's output. Never throws — hooks must not crash a turn. */
  async observe(threadTs: string, command: string, stdout: string): Promise<void> {
    try {
      for (const tokens of commandSegments(command)) {
        if (isOrcaCommand(tokens, 'orchestration', 'reply')) {
          await this.observeReply(threadTs, tokens, stdout);
        } else if (isOrcaCommand(tokens, 'terminal', 'send')) {
          await this.observeSend(threadTs, tokens, stdout);
        }
      }
    } catch (error) {
      this.logger.warn({ err: error, threadTs, command }, 'gate relay observer failed');
    }
  }

  /** A reply that reached the bus answers its gate — pending → answered. */
  private async observeReply(threadTs: string, tokens: string[], stdout: string): Promise<void> {
    const msgId = flagValue(tokens, '--id');
    if (msgId === undefined) return;
    if (parseOrcaEnvelope(stdout) === null) {
      // The reply failed (the ask likely hit its timeout): the gate stays
      // pending, and the fallback send that follows answers THIS gate.
      if (this.store.getGate(msgId)?.status === 'pending') {
        this.lastReply.set(threadTs, { msgId, outcome: 'failed' });
      }
      return;
    }
    const gate = this.store.getGate(msgId);
    if (gate === undefined || !this.store.answerGate(msgId)) return;
    this.lastReply.delete(threadTs);
    this.logger.info(
      { threadTs: gate.threadTs, msgId, workerHandle: gate.workerHandle },
      'gate answered — human reply relayed down',
    );
    await this.surface.settleRoot(gate.threadTs);
  }

  /**
   * A sanctioned send answers the gate it is FOR: the one whose reply just
   * failed (the fallback), never the one a correction denial named. Without
   * that attribution, only a worker's single unambiguous pending gate flips
   * — with two pending (an escalation plus an ask), guessing which one the
   * send answered could mark the wrong question answered and get its real
   * answer refused later.
   */
  private async observeSend(threadTs: string, tokens: string[], stdout: string): Promise<void> {
    if (parseOrcaEnvelope(stdout) === null) return;
    const handle = flagValue(tokens, '--terminal');
    if (handle === undefined) return;
    // A stalled worker whose terminal got keystrokes AND enter has been
    // nudged, whatever else the send was for — its ⚠️ alert is no longer
    // awaiting an answer (issue #22). An enter-less send leaves the prompt
    // sitting, so the alert stays pending.
    if (hasFlag(tokens, '--enter')) {
      let nudged = false;
      for (const stall of this.store.listPendingStalls(threadTs)) {
        if (stall.workerHandle !== handle || !this.store.answerStall(stall.dispatchId)) continue;
        nudged = true;
        this.logger.info(
          { threadTs, dispatchId: stall.dispatchId, workerHandle: handle },
          'stall alert answered — the nudge reached the worker terminal',
        );
      }
      if (nudged) await this.surface.settleRoot(threadTs);
    }
    const last = this.lastReply.get(threadTs);
    if (last !== undefined && this.store.getGate(last.msgId)?.workerHandle === handle) {
      this.lastReply.delete(threadTs);
      if (last.outcome === 'correction') {
        this.logger.info(
          { threadTs, msgId: last.msgId, workerHandle: handle },
          'late correction passed on best-effort — nothing to flip',
        );
        return;
      }
      await this.answerBySend(threadTs, last.msgId, handle);
      return;
    }
    const pending = this.store
      .listPendingGates(threadTs)
      .filter((gate) => gate.workerHandle === handle);
    if (pending.length !== 1) {
      if (pending.length > 1) {
        this.logger.warn(
          { threadTs, workerHandle: handle, pending: pending.map((gate) => gate.msgId) },
          'unattributed send to a worker with several pending gates — none flipped',
        );
      }
      return;
    }
    await this.answerBySend(threadTs, (pending[0] as PendingGateRow).msgId, handle);
  }

  private async answerBySend(threadTs: string, msgId: string, handle: string): Promise<void> {
    if (!this.store.answerGate(msgId)) return;
    this.logger.info(
      { threadTs, msgId, workerHandle: handle },
      'gate answered via the terminal send fallback',
    );
    await this.surface.settleRoot(threadTs);
  }
}

const deny = (message: string): PrepareVerdict => ({ action: 'deny', message });

/** A bare "2" / "2." read against a gate's numbered options. Null when the
 * value is free text or the gate carried no options (both pass verbatim);
 * `option` stays undefined when the number is out of range. */
function optionChoice(
  gate: PendingGateRow,
  value: string,
): { index: number; option: string | undefined } | null {
  const match = /^(\d+)\.?$/.exec(value.trim());
  if (match === null || gate.options.length === 0) return null;
  const index = Number(match[1]);
  return { index, option: index < 1 ? undefined : gate.options[index - 1] };
}

const noSuchOption = (gate: PendingGateRow, index: number): PrepareVerdict =>
  deny(
    `that gate has ${gate.options.length} option${gate.options.length === 1 ? '' : 's'} — ` +
      `there is no option ${index}. Ask the human which they meant; do not guess`,
  );

/** Swaps one flag's value in a token list — `--flag value` or `--flag=value`. */
function replaceFlagValue(tokens: string[], flag: string, value: string): string[] {
  return tokens.map((token, i) => {
    if (token.startsWith(`${flag}=`)) return `${flag}=${value}`;
    return tokens[i - 1] === flag ? value : token;
  });
}

/** One registry row, flattened for the LLM's turn context. Superseded rows
 * never reach here — decorateReply filters them before the map. */
function contextLine(gate: PendingGateRow): string {
  const status =
    gate.status === 'pending' ? 'PENDING' : gate.status === 'closed' ? 'CLOSED' : 'ANSWERED';
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
  const ref = gate.worktreeName === null ? null : worktreeIssueRef(gate.worktreeName);
  return ref ?? gate.taskId ?? gate.msgId;
}

/** One stall-alert row, flattened for the LLM's turn context (issue #22). */
function stallContextLine(stall: StallAlertRow): string {
  const status = stall.status === 'pending' ? 'PENDING' : 'ANSWERED';
  const from = stall.worktreeName === null ? 'an unmatched worker' : `\`${stall.worktreeName}\``;
  const ref =
    (stall.worktreeName === null ? null : worktreeIssueRef(stall.worktreeName)) ??
    stall.dispatchId;
  const terminal =
    stall.workerHandle === null
      ? 'worker terminal unknown — no route down'
      : `worker terminal ${stall.workerHandle}`;
  return [
    `- [${status}] ⚠️ stall from ${from} (ack ref: ${ref}, ${terminal})` +
      ' — stalled without asking; an answer goes down as keystrokes via terminal send',
    `  last output: "${oneLine(stall.lastOutput)}"`,
  ].join('\n');
}

/** The stored tail flattened to one context line, capped. */
function oneLine(text: string): string {
  const flat = text.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ⏎ ');
  return flat.length > 200 ? `…${flat.slice(-200)}` : flat;
}

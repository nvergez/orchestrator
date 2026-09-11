import type { RequestKind } from './requests.ts';

/**
 * Reference verbatims fixed by the Slack UX mock (spec §8,
 * docs/prototypes/slack-ux/conversations.md).
 */

/** Scenario G1 — root @mention by a third party. Deliberately generic
 * (issue #93): enumerating the allowed users would leak the allow-list to
 * exactly the people it exists to keep out. */
export function refusalLine(): string {
  return 'Only authorized operators can drive me.';
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
 * Scenario A — the delegation card (issue #19): one message per delegation,
 * posted when the worktree is ready and edited at milestones only, never a
 * token stream. GitHub links rich (`<url|repo#n>`), worktree name as code;
 * a repo without a GitHub remote (folder repos) degrades to plain `repo#n`.
 */
export function delegationCard(opts: {
  repo: string;
  issueNumber: number | null;
  kind?: RequestKind | null;
  title: string;
  worktreeName: string;
  agent: string;
  /** `https://github.com/<owner>/<repo>/issues/<n>` when the repo has one. */
  issueUrl?: string;
  /** Rendered milestone lines, oldest first (`• 14:04 — worktree ready`). */
  milestones: string[];
}): string {
  if (opts.kind === 'question') {
    return `🔎 Looking on *${opts.repo}*…\n\`${opts.worktreeName}\``;
  }
  const ref = `${opts.repo}#${opts.issueNumber}`;
  const issue = opts.issueUrl === undefined ? ref : `<${opts.issueUrl}|${ref}>`;
  return [
    `⚙️ *${opts.worktreeName} — ${opts.title}*`,
    `${opts.agent}${opts.issueNumber === null ? '' : ` · issue ${issue}`}`,
    ...opts.milestones,
  ].join('\n');
}

/** A delegation-card milestone line; `at` is a local wall-clock HH:MM. */
export function milestoneLine(at: string, text: string): string {
  return `• ${at} — ${text}`;
}

/**
 * Scenario A end — the card's final state on `worker_done` (issue #20): ✅
 * (or ❌) with the durable links. The milestones give way to the links: the
 * card is now a result record, not a progress log. `prLinks` come out of the
 * worker's report (extractPullRequestLinks); the failure reason is the
 * worker's subject, verbatim.
 */
export function completedCard(opts: {
  repo: string;
  issueNumber: number | null;
  worktreeName: string;
  kind?: RequestKind | null;
  title: string;
  worktreePath: string | null;
  durationMs: number;
  issueUrl?: string;
  prLinks: Array<{ url: string; label: string }>;
  failureReason?: string;
}): string {
  const ref = opts.worktreeName;
  const failed = opts.failureReason !== undefined;
  const header = failed
    ? `❌ *${ref} — ${opts.title} — failed after ${formatDuration(opts.durationMs)}*`
    : `✅ *${ref} — ${opts.kind === 'question' ? 'answered' : `${opts.title} — delivered`} in ${formatDuration(opts.durationMs)}*`;
  const lines = [header];
  if (opts.failureReason !== undefined) lines.push(`• reason: ${opts.failureReason}`);
  for (const pr of opts.prLinks) lines.push(`• PR: <${pr.url}|${pr.label}>`);
  if (opts.kind !== 'question' && opts.issueNumber !== null) {
    const issueRef = `${opts.repo}#${opts.issueNumber}`;
    lines.push(`• issue: ${opts.issueUrl === undefined ? issueRef : `<${opts.issueUrl}|${issueRef}>`}`);
  }
  if (opts.kind !== 'question' && opts.worktreePath !== null) lines.push(`• worktree: \`${opts.worktreePath}\``);
  return lines.join('\n');
}

/**
 * Issue #20 — the daemon's own short summary when no session could take the
 * wake (thread closed, or the row lost its thread): the completion still
 * lands as a NEW message, never silence. When the session does wake, its
 * voice writes this line's richer sibling instead.
 */
export function workerDoneFallbackLine(subject: string, failed: boolean, report = ''): string {
  const pr = failed ? undefined : extractPullRequestLinks(report)[0];
  if (pr) return `${pr.url}\n${subject}. Details in the card ⤴`;
  if (!failed && report.trim() !== '') return report;
  const head = failed ? '❌ Failed' : '✅ Delivered';
  return `${head} — ${subject}. Details in the card ⤴`;
}

/**
 * Scenario C / "Worker escalation" — the relayed gate message (issue #21,
 * content contract fixed by issue #9): who is asking (worktree + issue
 * link), the question VERBATIM in a blockquote — never paraphrased — the
 * numbered options inside the same quote, and the fixed reply instruction.
 * An escalation is the same mold marked 🚨; the "a number or free text"
 * tail appears only when there are options to number.
 */
export function gateRelayMessage(opts: {
  kind: 'decision_gate' | 'escalation';
  worktreeName: string | null;
  repo: string | null;
  issueNumber: number | null;
  /** `https://…/issues/<n>` when the repo has a GitHub remote. */
  issueUrl?: string;
  question: string;
  options: string[];
}): string {
  const escalation = opts.kind === 'escalation';
  const who = opts.worktreeName === null ? '*A worker*' : `*\`${opts.worktreeName}\`*`;
  const plainRef =
    opts.repo !== null && opts.issueNumber !== null ? `${opts.repo}#${opts.issueNumber}` : null;
  const ref =
    plainRef === null
      ? ''
      : ` (${opts.issueUrl === undefined ? plainRef : `<${opts.issueUrl}|${plainRef}>`})`;
  const quoted = [
    ...opts.question.split('\n'),
    ...opts.options.map((option, index) => `*${index + 1}.* ${option}`),
  ].map((line) => `> ${line}`);
  return [
    `${escalation ? '🚨' : '❓'} ${who}${ref} ${escalation ? 'escalates' : 'asks'}:`,
    '',
    ...quoted,
    '',
    opts.options.length > 0
      ? 'Reply in this thread — a number or free text.'
      : 'Reply in this thread.',
  ].join('\n');
}

/**
 * Scenario "Stalled worker (watchdog)" — the ⚠️ alert (issue #22): same mold
 * as a gate (who + issue link), but it says explicitly that the worker
 * stalled WITHOUT asking a question, shows the last terminal output verbatim
 * (code-quoted, truncated upstream), and points the reply at the terminal —
 * there is no `ask` to answer, so the route back is `terminal send` (spec §6).
 */
export function stalledWorkerAlert(opts: {
  worktreeName: string | null;
  repo: string | null;
  issueNumber: number | null;
  /** `https://…/issues/<n>` when the repo has a GitHub remote. */
  issueUrl?: string;
  /** How long since the worktree last showed any sign of life. */
  stalledForMs: number;
  /** The truncated tail of the worker terminal; empty when unreadable. */
  lastOutput: string;
}): string {
  const who = opts.worktreeName === null ? '*A worker*' : `*\`${opts.worktreeName}\`*`;
  const plainRef =
    opts.repo !== null && opts.issueNumber !== null ? `${opts.repo}#${opts.issueNumber}` : null;
  const ref =
    plainRef === null
      ? ''
      : ` (${opts.issueUrl === undefined ? plainRef : `<${opts.issueUrl}|${plainRef}>`})`;
  const tail =
    opts.lastOutput.trim() === ''
      ? ['> (no recent output could be read)']
      : opts.lastOutput
          .split('\n')
          .map((line) => (line.trim() === '' ? '>' : `> \`${line.replaceAll('`', "'")}\``));
  return [
    `⚠️ ${who}${ref} seems stalled —`,
    `no sign for ${formatDuration(opts.stalledForMs)}, without having asked a question. Last output:`,
    '',
    ...tail,
    '',
    "Tell me what to answer, I'll relay it to its terminal.",
  ].join('\n');
}

/**
 * The watchdog's second signal (issue #48): the worker LOOKS alive — a TUI
 * spinner keeps its terminal clocks fresh, so `stalledWorkerAlert` can never
 * fire — but the bus has heard nothing from it for the whole in-flight
 * window. Same mold as the stall alert; what it quotes instead of terminal
 * output is the runtime's view of the agent (`worktree ps` state) and its
 * last assistant message — where the live incident's root cause was sitting.
 */
export function inflightWorkerAlert(opts: {
  worktreeName: string | null;
  repo: string | null;
  issueNumber: number | null;
  /** `https://…/issues/<n>` when the repo has a GitHub remote. */
  issueUrl?: string;
  /** How long the delegation has been in flight with a mute bus. */
  inFlightForMs: number;
  /** The agent state `worktree ps` reports; null when unreported. */
  agentState: string | null;
  /** The agent's last assistant message, truncated upstream; '' when unreadable. */
  lastAssistantMessage: string;
}): string {
  const who = opts.worktreeName === null ? '*A worker*' : `*\`${opts.worktreeName}\`*`;
  const plainRef =
    opts.repo !== null && opts.issueNumber !== null ? `${opts.repo}#${opts.issueNumber}` : null;
  const ref =
    plainRef === null
      ? ''
      : ` (${opts.issueUrl === undefined ? plainRef : `<${opts.issueUrl}|${plainRef}>`})`;
  const quoted =
    opts.lastAssistantMessage.trim() === ''
      ? ['> (no assistant message could be read)']
      : opts.lastAssistantMessage
          .split('\n')
          .map((line) => (line.trim() === '' ? '>' : `> \`${line.replaceAll('`', "'")}\``));
  return [
    `⚠️ ${who}${ref} needs attention —`,
    `in flight for ${formatDuration(opts.inFlightForMs)} without a word on the bus ` +
      `(agent state: \`${opts.agentState ?? 'unknown'}\`). Last assistant message:`,
    '',
    ...quoted,
    '',
    "Tell me what to answer, I'll relay it to its terminal.",
  ].join('\n');
}

/**
 * Scenario C end — the fixed acknowledgment after an answer went back down.
 * Rendered by the session's voice (the routing turn's one visible line); the
 * template lives here so the system prompt and the tests share one source.
 */
export function gateAnswerAck(ref: string, forwardedText: string): string {
  return `✅ Relayed to \`${ref}\` — "${forwardedText}"`;
}

/** `27 min`, `1 h 05 min`, `under a minute` — the card's duration wording. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
}

/**
 * GitHub pull-request URLs in a worker's report → the card's rich links,
 * labeled `<repo>#<n>`, first appearance order, deduplicated.
 */
export function extractPullRequestLinks(text: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = [];
  const seen = new Set<string>();
  const pattern = /https:\/\/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({ url, label: `${match[1]}#${match[2]}` });
  }
  return links;
}

/**
 * Issue #19 — the global concurrent-worker cap is full: the delegation waits
 * its wave (the `worktree create` call stays suspended until a slot frees).
 */
export function workerCapLine(inFlight: number): string {
  const noun = inFlight === 1 ? 'worker' : 'workers';
  return `⏳ Worker cap reached (${inFlight} ${noun} in flight) — this delegation waits for a free slot.`;
}

/**
 * Spec §10: every daemon-side orca call is wrapped — when the runtime is
 * down the thread gets this line, and the daemon carries on.
 */
export function orcaUnavailableLine(detail: string): string {
  return `⚠️ Orca runtime unavailable — ${detail}`;
}

/**
 * The success cleanup's one visible failure mode (issue #43): the runtime
 * refused to remove a delivered delegation's worktree (usually a dirty
 * tree), so it stays on disk for inspection and the thread hears why.
 * Silence on success — a removed worktree needs no announcement.
 */
export function worktreeKeptLine(worktreeName: string, reason: string): string {
  return `🧹 Could not clean up worktree \`${worktreeName}\` — kept for inspection.\n> ${reason}`;
}

/**
 * Scenario F′ — live-session cap reached with every session mid-turn: the
 * message waits its turn instead of being rejected (spec §3).
 */
export function queuedLine(activeSessions: number): string {
  const noun = activeSessions === 1 ? 'session' : 'sessions';
  return `⏳ Queued (${activeSessions} active ${noun}) — I'll get to it as soon as a slot frees up.`;
}

/**
 * "Daemon restart — reconciliation" (issue #25): the fixed reboot verbatim —
 * `⚠️ Restarted — <repo>#<n> was in flight: <observed state>. Reply to
 * resume supervision.` One message per affected thread; several delegations
 * in flight group into one bulleted message, never a second ⚠️.
 */
export function restartNotice(items: Array<{ ref: string; state: string }>): string {
  const single = items.length === 1 ? items[0] : undefined;
  if (single !== undefined) {
    return `⚠️ Restarted — \`${single.ref}\` was in flight: ${single.state}. Reply to resume supervision.`;
  }
  return [
    `⚠️ Restarted — ${items.length} delegations were in flight:`,
    ...items.map((item) => `• \`${item.ref}\` — ${item.state}`),
    'Reply to resume supervision.',
  ].join('\n');
}

/**
 * The fixed answers to a bare memory command (issue #120). Deterministic
 * lines, not prose: `forget` runs without a model in the loop precisely so
 * it still works when the session is confused, and a line a voice could
 * restyle would undermine that.
 */
export function forgetLine(outcome: 'deleted' | 'not_yours' | 'unknown' | 'disabled', memoryId: string): string {
  switch (outcome) {
    case 'deleted':
      return `🧽 Forgotten — \`${memoryId}\` is gone.`;
    case 'not_yours':
      return `🧽 \`${memoryId}\` is not one of yours — you can only forget what I was shown about you.`;
    case 'unknown':
      return `🧽 I have nothing under \`${memoryId}\`. The id is the one in brackets next to a memory.`;
    case 'disabled':
      return '🧽 I am not keeping memories of anyone right now.';
  }
}

/** The opt-out and its inverse — the purge is stated plainly, with the count. */
export function memorySettingLine(setting: 'forget_me' | 'remember_me' | 'disabled', purged = 0): string {
  switch (setting) {
    case 'forget_me':
      return purged === 0
        ? '🧽 Nothing of yours was kept, and nothing will be from now on.'
        : `🧽 Forgotten — ${String(purged)} ${purged === 1 ? 'memory' : 'memories'} about you purged, and I will keep no more. Say \`remember me\` to undo that.`;
    case 'remember_me':
      return '🧽 I will keep memories about you again. Nothing purged comes back.';
    case 'disabled':
      return '🧽 I am not keeping memories of anyone right now.';
  }
}

/** "Brief moments" — the only reply a closed thread ever gets (spec §3: closed is final). */
export const CLOSED_THREAD_LINE =
  'Session closed. Mention me on a new root message to start again.';

/**
 * One ledger delegation as the 🔚 summary names it (issue #51): the fields
 * `DelegationRow` durably holds, plus the registry-derived issue link — absent
 * for a folder repo without a remote, so the line degrades to the plain
 * `repo#n` exactly like the card.
 */
export interface ClosingDelegation {
  repo: string | null;
  issueNumber: number | null;
  /** The naming fallback for a row that never resolved a `repo#n`. */
  worktreeName: string | null;
  taskId: string;
  status: 'dispatched' | 'completed' | 'failed';
  /** `https://…/issues/<n>` when the repo has a GitHub remote. */
  issueUrl?: string;
}

/** The card vocabulary (spec §8): ✅ done · ❌ failed · ⚙️ still in flight. */
const CLOSING_STATUS_ICON = { completed: '✅', failed: '❌', dispatched: '⚙️' } as const;

/** `• ✅ <url|repo#n>` — one delegation's line in the 🔚 summary (issue #51). */
function closingDelegationLine(delegation: ClosingDelegation): string {
  const name = delegation.worktreeName === null ? delegation.taskId : `\`${delegation.worktreeName}\``;
  const issue = delegation.issueUrl === undefined ? '' : ` · <${delegation.issueUrl}|issue>`;
  const tail = delegation.status === 'dispatched' ? ' — still in flight' : '';
  return `• ${CLOSING_STATUS_ICON[delegation.status]} ${name}${issue}${tail}`;
}

/**
 * "Brief moments" — the 🔚 closing summary, posted by an explicit
 * `@orchestrator close` only: the dormancy sweep closes silently. Each of the
 * thread's delegations gets its own line with the final outcome and issue link
 * (issue #51, from the #19 ledger) — the thread's durable at-a-glance record;
 * the cost/turn line stays the mock's verbatim.
 */
export function closingSummary(opts: {
  delegations: ClosingDelegation[];
  costUsd: number;
  turnCount: number;
}): string {
  return [
    '🔚 Session closed.',
    ...(opts.delegations.length === 0
      ? ['• no delegations']
      : opts.delegations.map(closingDelegationLine)),
    `• thread cost: $${opts.costUsd.toFixed(2)} · ${opts.turnCount} turn${opts.turnCount === 1 ? '' : 's'}`,
    'Mention me on a new root message to start again.',
  ].join('\n');
}


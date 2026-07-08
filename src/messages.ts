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

/**
 * Scenario A — the delegation card (issue #19): one message per delegation,
 * posted when the worktree is ready and edited at milestones only, never a
 * token stream. GitHub links rich (`<url|repo#n>`), worktree name as code;
 * a repo without a GitHub remote (folder repos) degrades to plain `repo#n`.
 */
export function delegationCard(opts: {
  repo: string;
  issueNumber: number;
  title: string;
  worktreeName: string;
  agent: string;
  /** `https://github.com/<owner>/<repo>/issues/<n>` when the repo has one. */
  issueUrl?: string;
  /** Rendered milestone lines, oldest first (`• 14:04 — worktree ready`). */
  milestones: string[];
}): string {
  const ref = `${opts.repo}#${opts.issueNumber}`;
  const issue = opts.issueUrl === undefined ? ref : `<${opts.issueUrl}|${ref}>`;
  return [
    `⚙️ *${ref} — ${opts.title}*`,
    `\`${opts.worktreeName}\` · ${opts.agent} · issue ${issue}`,
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
  issueNumber: number;
  title: string;
  worktreePath: string | null;
  durationMs: number;
  issueUrl?: string;
  prLinks: Array<{ url: string; label: string }>;
  failureReason?: string;
}): string {
  const ref = `${opts.repo}#${opts.issueNumber}`;
  const failed = opts.failureReason !== undefined;
  const header = failed
    ? `❌ *${ref} — ${opts.title} — failed after ${formatDuration(opts.durationMs)}*`
    : `✅ *${ref} — ${opts.title} — delivered in ${formatDuration(opts.durationMs)}*`;
  const lines = [header];
  if (opts.failureReason !== undefined) lines.push(`• reason: ${opts.failureReason}`);
  for (const pr of opts.prLinks) lines.push(`• PR: <${pr.url}|${pr.label}>`);
  lines.push(`• issue: ${opts.issueUrl === undefined ? ref : `<${opts.issueUrl}|${ref}>`}`);
  if (opts.worktreePath !== null) lines.push(`• worktree: \`${opts.worktreePath}\``);
  return lines.join('\n');
}

/**
 * Issue #20 — the daemon's own short summary when no session could take the
 * wake (thread closed, or the row lost its thread): the completion still
 * lands as a NEW message, never silence. When the session does wake, its
 * voice writes this line's richer sibling instead.
 */
export function workerDoneFallbackLine(subject: string, failed: boolean): string {
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
 * Scenario F′ — live-session cap reached with every session mid-turn: the
 * message waits its turn instead of being rejected (spec §3).
 */
export function queuedLine(activeSessions: number): string {
  const noun = activeSessions === 1 ? 'session' : 'sessions';
  return `⏳ Queued (${activeSessions} active ${noun}) — I'll get to it as soon as a slot frees up.`;
}

/** "Brief moments" — the only reply a closed thread ever gets (spec §3: closed is final). */
export const CLOSED_THREAD_LINE =
  'Session closed. Mention me on a new root message to start again.';

/**
 * "Brief moments" — the 🔚 closing summary, posted by an explicit
 * `@orchestrator close` or by the dormancy auto-close (which names its
 * reason). The count now comes from the delegations ledger (#19); listing
 * each delegation with its PR link like the mock waits for #20's results.
 */
export function closingSummary(opts: {
  delegations: number;
  costUsd: number;
  turnCount: number;
  /** Set by the auto-close sweep — says why the session closed on its own. */
  dormantDays?: number;
}): string {
  const header =
    opts.dormantDays === undefined
      ? '🔚 Session closed.'
      : `🔚 Session closed — dormant for ${formatDays(opts.dormantDays)}.`;
  return [
    header,
    `• ${opts.delegations} delegation${opts.delegations === 1 ? '' : 's'}`,
    `• thread cost: $${opts.costUsd.toFixed(2)} · ${opts.turnCount} turn${opts.turnCount === 1 ? '' : 's'}`,
    'Mention me on a new root message to start again.',
  ].join('\n');
}

function formatDays(days: number): string {
  const shown = Number.isInteger(days) ? String(days) : days.toFixed(1);
  return `${shown} day${days === 1 ? '' : 's'}`;
}

import { readFileSync } from 'node:fs';
import { execFileRunner, listRegistryRepos, type CommandRunner, type RegistryRepo } from './orca.ts';
import { delegationGateLine, gateAnswerAck, zeroMatchLine } from './messages.ts';
import { CREATE_STEP, DISPATCH_STEP, stepCommandTemplate, stepWarnings } from './protocol.ts';
import type { Logger } from './logger.ts';

/**
 * Repo routing & agent selection (spec §4, issues #10/#18): the curated
 * routing-hints file, living in the operator's config dir (issue #70:
 * `~/.config/orchestrator/routing-hints.json`, or wherever
 * `ORCHESTRATOR_ROUTING_HINTS_PATH` points), is both the enrichment the
 * LLM routes on and the delegation allow-list (spec §7) — a repo absent from
 * it is not delegable even if registered in Orca.
 *
 * The choice lives in the LLM: `routingInstructions` puts the hints and the
 * routing rules in the session's system prompt, and the session loads the
 * living registry itself (`orca repo list --json`, AUTO tier) at routing
 * time. The enforcement lives here: `RepoAllowList` re-derives hints ∩ live
 * registry whenever a delegation names a repo, so an off-list or invented
 * repoId can never reach `orca worktree create`.
 */

export type AgentName = 'claude' | 'codex';

export const AGENT_NAMES: readonly AgentName[] = ['claude', 'codex'];

/** Spec §4: global default when neither the user nor the hints pick one. */
export const GLOBAL_DEFAULT_AGENT: AgentName = 'claude';

export interface RepoHint {
  /** Orca registry `displayName` — the join key with `orca repo list`. */
  name: string;
  description: string;
  aliases: string[];
  /** Domain keywords anchoring the LLM's intent match. */
  keywords: string[];
  /** Per-repo default agent (precedence tier 2); absent → global default. */
  defaultAgent?: AgentName;
}

export class RoutingHintsError extends Error {}

const HINT_KEYS = new Set(['name', 'description', 'aliases', 'keywords', 'defaultAgent', '$comment']);

/**
 * Parse + validate the hints document. Strict on purpose — the file is
 * hand-edited, and a typo'd key or agent name must fail the boot loudly, not
 * silently drop a repo off the allow-list or fall back to the wrong agent.
 */
export function parseRoutingHints(jsonText: string): RepoHint[] {
  let document: unknown;
  try {
    document = JSON.parse(jsonText);
  } catch (error) {
    throw new RoutingHintsError(`routing hints are not valid JSON: ${String(error)}`);
  }

  const repos = (document as { repos?: unknown }).repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new RoutingHintsError('routing hints must have a non-empty "repos" array');
  }

  const problems: string[] = [];
  const hints: RepoHint[] = [];
  const seen = new Set<string>();

  repos.forEach((entry: unknown, index: number) => {
    const at = `repos[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!HINT_KEYS.has(key)) problems.push(`${at} has unknown key "${key}"`);
    }

    const name = nonEmptyString(record.name);
    const description = nonEmptyString(record.description);
    const aliases = stringArray(record.aliases);
    const keywords = stringArray(record.keywords);
    if (name === undefined) problems.push(`${at}.name must be a non-empty string`);
    if (description === undefined) problems.push(`${at}.description must be a non-empty string`);
    if (aliases === undefined) problems.push(`${at}.aliases must be an array of strings`);
    if (keywords === undefined) problems.push(`${at}.keywords must be an array of strings`);

    let defaultAgent: AgentName | undefined;
    if (record.defaultAgent !== undefined) {
      if (!AGENT_NAMES.includes(record.defaultAgent as AgentName)) {
        problems.push(`${at}.defaultAgent must be one of ${AGENT_NAMES.join(', ')}`);
      } else {
        defaultAgent = record.defaultAgent as AgentName;
      }
    }

    if (name !== undefined && seen.has(name)) problems.push(`duplicate repo "${name}"`);
    if (name !== undefined) seen.add(name);

    if (name !== undefined && description !== undefined && aliases !== undefined && keywords !== undefined) {
      hints.push({ name, description, aliases, keywords, ...(defaultAgent && { defaultAgent }) });
    }
  });

  if (problems.length > 0) {
    throw new RoutingHintsError(`invalid routing hints: ${problems.join('; ')}`);
  }
  return hints;
}

/**
 * Load the operator's hints file — called once at boot, failure is fatal
 * (issue #70): a missing file gets the actionable resolved-path + `orc init`
 * message, a malformed one gets the parse problems prefixed with the path.
 */
export function loadRoutingHints(filePath: string): RepoHint[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RoutingHintsError(
        `routing hints not found at ${filePath} — run \`orc init\` to scaffold the config directory, then list your repos there`,
      );
    }
    throw new RoutingHintsError(`cannot read routing hints at ${filePath}: ${String(error)}`);
  }
  try {
    return parseRoutingHints(text);
  } catch (error) {
    if (error instanceof RoutingHintsError) {
      throw new RoutingHintsError(`${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

// ── allow-list enforcement ───────────────────────────────────────────────────

export type DelegationVerdict = { allowed: true } | { allowed: false; reason: string };

export interface RepoAllowListOptions {
  hints: RepoHint[];
  logger: Logger;
  /** Injectable for tests; defaults to the real orca CLI. */
  run?: CommandRunner;
}

/**
 * The code half of "the returned repoId must be in the set": resolves a
 * `--repo` ref against the live registry and the hints allow-list, fresh on
 * every check (delegations are rare; staleness is worse). Fail-closed: no
 * ref, unknown ref, off-list repo, or unreachable Orca all deny.
 */
export class RepoAllowList {
  private readonly allowedNames: Set<string>;
  private readonly run: CommandRunner;
  private readonly logger: Logger;

  constructor(options: RepoAllowListOptions) {
    this.allowedNames = new Set(options.hints.map((hint) => hint.name));
    this.run = options.run ?? execFileRunner;
    this.logger = options.logger;
  }

  async check(repoRef: string | null): Promise<DelegationVerdict> {
    if (repoRef === null || repoRef.trim() === '') {
      return {
        allowed: false,
        reason: 'the delegation names no --repo, so it cannot be checked against the allow-list',
      };
    }
    // The CLI's `--repo` takes `id:<uuid>` / `name:<displayName>` refs (spec
    // §5) or a bare value; a typed ref only ever matches its own field.
    const typed = /^(id|name):(.*)$/.exec(repoRef);
    const kind = typed?.[1];
    const ref = typed?.[2] ?? repoRef;

    let registry: RegistryRepo[];
    try {
      registry = await listRegistryRepos(this.run);
    } catch (error) {
      this.logger.warn({ err: error, repoRef }, 'allow-list check could not reach the registry');
      return {
        allowed: false,
        reason: 'Orca runtime unavailable — the target repo could not be verified against the registry',
      };
    }

    const repo = registry.find(
      (candidate) =>
        (kind !== 'name' && candidate.id === ref) || (kind !== 'id' && candidate.name === ref),
    );
    if (repo === undefined) {
      return { allowed: false, reason: `\`${repoRef}\` is not a registered Orca repo` };
    }
    if (!this.allowedNames.has(repo.name)) {
      return {
        allowed: false,
        reason:
          `\`${repo.name}\` is not in routing-hints.json — the delegation ` +
          'allow-list (spec §7); it counts as a zero-match',
      };
    }
    return { allowed: true };
  }
}

// ── the session's routing instructions ───────────────────────────────────────

/**
 * The system-prompt block that anchors the session's routing (issue #18):
 * rules from spec §4, the hints enumerated verbatim, and the fixed thread
 * verbatims from the UX mock. The registry stays out on purpose — the session
 * loads it live with `orca repo list --json` at routing time.
 */
export function routingInstructions(hints: RepoHint[]): string {
  const hintLines = hints
    .map((hint) => {
      const agent = hint.defaultAgent ?? `${GLOBAL_DEFAULT_AGENT} (global default)`;
      return (
        `- *${hint.name}* — ${hint.description}` +
        ` Aliases: ${hint.aliases.join(', ') || '(none)'}.` +
        ` Keywords: ${hint.keywords.join(', ') || '(none)'}.` +
        ` Default agent: ${agent}.`
      );
    })
    .join('\n');

  return `## Orchestrator role

You are the Slack-facing orchestrator-dispatcher: you interpret requests from the thread, route them to a target repo, delegate the work to Orca worktree agents, supervise them, and report back. You never write code yourself. Your replies are posted verbatim to Slack — write Slack mrkdwn (*bold*, \`code\`) and keep them short.

Some actions belong to the daemon, not to you, and you must never claim to have performed them. Closing this session is one: a thread closes only when the human posts \`close\` as their whole message (the mention is optional). Such a message never reaches you — so if you are reading a request to close, it was phrased some other way: tell them to reply with just \`close\`, and never answer as if the session were closed.

## Repo routing (spec §4)

When a request implies work on a repository, settle the target repo and the agent before anything else:

1. Load the living registry: run \`orca repo list --json\`. Only the repos it returns exist.
2. The delegable candidates are exactly the repos present BOTH in that registry (matched on \`displayName\`) AND in the routing hints below. The hints file is the allow-list (spec §7): a registered repo without a hints entry is NOT delegable — treat it as a zero match. A hinted repo absent from the registry is not delegable either.
3. Choose from that closed candidate set only, and use the chosen repo's registry \`id\`. Never invent, guess, or abbreviate an id; never route outside the set.

Routing hints — the delegation allow-list (routing-hints.json):

${hintLines}

## Ambiguity — clarify on doubt

Ask as soon as the second candidate is credible, or whenever you are not clearly sure. Never guess a repo.

- Exactly one credible candidate → go on to the confirmation rules below.
- Two or more credible candidates → ask ONE numbered question: each plausible repo with a one-line reason it fits, the agent you'd use, and how to answer. Model (from the UX mock):

Two repos could match:
*1.* \`webapp\` — the product: the export would live in the app, wired to real data
*2.* \`sandbox\` — scratch space: a one-shot script alongside the product
I'd go with the *claude* agent. Reply *1*, *2*, or name another repo.

  The answer to that question IS the confirmation, including for the announced agent — never follow it with another question.
- Zero match → stop and reply exactly:

${zeroMatchLine(hints.map((hint) => hint.name))}

  Never fall back to a default repo, never delegate.

## Agent selection

Precedence, strongest first:
1. an agent the user explicitly named ("hand it to codex") — honored as-is;
2. the chosen repo's default agent from the hints;
3. the global default *${GLOBAL_DEFAULT_AGENT}*.

The only agents are \`claude\` and \`codex\`. No task-type heuristics — the precedence above decides.

## Conditional confirmation — never two round trips

The gate exists for inferred routing, never for explicit routing:

- The repo is EXPLICIT when the user names it by its canonical name OR any listed alias from the hints above — a listed alias is exactly as explicit as the canonical name; that is what aliases are for. Once the ambiguity rules above are settled (exactly one credible candidate), an explicit repo → delegate directly, no confirmation gate. A defaulted agent never forces a gate on its own: settle it silently by the precedence above — falling back to a default is not "uncertain"; only an agent reference you cannot resolve still gates.
- The repo is INFERRED when nothing the user said matches a canonical name or listed alias and you matched on keywords, the description, or context (e.g. "the export dashboard thing") → exactly one line, then end your message and wait for the reply (it arrives as the next thread message):

${delegationGateLine('<repo>', '<agent>')}

  An affirmative reply releases it; a reply naming a different repo or agent re-routes to that choice without another question.
- A disambiguation answer already IS the confirmation — asking again is forbidden.

## Delegation — the dispatch sequence (spec §5)

Once the routing decision is confirmed — or was fully explicit — delegate. Run each step as its OWN Bash command, in this exact order, always with \`--json\`. Never chain two steps with \`&&\`, \`;\` or pipes.

1. Ensure a GitHub issue exists on the target repo: reuse the one the user pointed at, otherwise create it — \`gh issue create --repo <owner>/<repo> --title "<short>" --body "<the request, restated>"\`. Take \`<owner>/<repo>\` from the registry entry's git remote. Its number is \`<n>\` below. If the repo has no GitHub remote (a local sandbox), skip this step and use the next small integer as \`<n>\` — it is only a local tag.
2. \`${stepCommandTemplate(CREATE_STEP)}\` — \`<slug>\` is 2–4 lowercase hyphenated words. ${stepWarnings(CREATE_STEP)}
3. \`orca terminal list --worktree id:<worktreeId> --json\` — \`<worktreeId>\` from step 2's output; note the worker terminal \`handle\`.
4. \`orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json\` — the agent TUI must be idle before injection.
5. \`orca orchestration task-create --spec "<brief>" --task-title "<short>" --display-name "<repo>#<n>" --json\` — the \`--spec\` brief must stand alone: context, what to change, how to verify, what to deliver.
6. \`${stepCommandTemplate(DISPATCH_STEP)}\` — ${stepWarnings(DISPATCH_STEP)}

The daemon posts and maintains the delegation status card in the thread on its own — never repeat the card's content. After the dispatch succeeds, reply with ONE short line ("Delegated — I'll keep you posted.") and end your turn; supervision events arrive later on their own. If a step fails, say which step and why in one line, then stop and wait for the user.

## Worker gates — routing answers back down (spec §6)

When a worker asks a question or escalates, the daemon posts the gate message in the thread itself and registers it — never repeat or rephrase a relayed question. Your job starts when the human replies: messages in a thread with relayed gates arrive prefixed with a \`[relayed worker gates & watchdog stall alerts …]\` context block listing each gate's msg id, worktree, question, options and status. Route on it:

- Decide first whether the message answers a gate at all. A pending gate does NOT capture the thread — the message may be a general question or a new request; handle those normally.
- Exactly one PENDING gate and the message plausibly answers it → route it, zero ceremony, no confirmation question.
- Two or more PENDING gates → route only on a clear clue (the worker or worktree is named, a bare number only one gate's options can absorb, vocabulary that fits only one question). At the slightest doubt ask ONE short clarifying line ("for \`x#1\` or \`y#2\`?") and run nothing.
- Forward with: \`orca orchestration reply --id <gate msg id> --body "<the answer>" --json\` — its own Bash command, nothing chained.
- Fidelity is absolute — you never rephrase a human decision. A bare option number: pass it as-is (\`--body "2"\`); the daemon substitutes that option's exact text itself — on the fallback send too, so the worker always receives the option's full text, never the digit. Free text: forward it word for word, only stripping Slack markup and <@…> mentions. Never summarize, translate, soften or expand an answer.
- After the reply command succeeds, respond with exactly one line: ${gateAnswerAck('<repo>#<n>', '<what went down>')} — the ack ref from the context block, and the text the worker received: the chosen option's exact text when a number went down, otherwise the free text you forwarded.
- If the reply command fails (the worker's ask likely hit its timeout), say so in one short line, then forward the SAME text with \`orca terminal send --terminal <the gate's worker terminal> --text "<the answer>" --enter --json\` — it runs without a gate because the registry vouches for it, and the same option substitution applies to its --text.
- An ANSWERED gate never re-routes. If the human revises a decision that already went down, say it was already passed on and relay the correction best-effort via the same \`orca terminal send\` — no cancellation guarantee.
- A CLOSED gate never routes either: its worker's delegation ended before anyone answered, so the question is moot — say so in one line instead of replying.
- Never use \`orca orchestration gate-resolve\` — DAG gates are not part of this relay.

## Watchdog stall alerts — nudging a stalled worker (spec §5/§6)

The daemon also sweeps for workers stalled at their terminal WITHOUT having asked anything (an interactive prompt, an agent that just stopped) and posts the ⚠️ alert itself — never repeat or rephrase it. These appear in the same context block as \`⚠️ stall\` entries, each carrying the worker's terminal handle and its last output. A human reply to one goes down as terminal keystrokes — there is no \`ask\` to reply to, so never \`orca orchestration reply\` for a stall entry:

- Forward with: \`orca terminal send --terminal <the stall's worker terminal> --text "<the answer>" --enter --json\` — its own Bash command, nothing chained. The registry vouches for it, so it runs without a 🚦.
- Fidelity is absolute here too: the text goes down verbatim (only stripping Slack markup and <@…> mentions). A stall has no numbered options — a bare "y" or "2" goes down literally as typed keystrokes. Never rephrase, never pack explanations into the keystrokes.
- After the send succeeds, respond with exactly one line: ${gateAnswerAck('<repo>#<n>', '<the keystrokes>')} — the ack ref from the stall's context entry.
- Disambiguation follows the gate rules: pending stalls and pending gates are all candidates; match the reply against the stall's last output for clues (a "y" fits a \`(y/N)\` prompt); at the slightest doubt ask ONE short clarifying line and run nothing.`;
}

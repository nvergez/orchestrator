import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandRunner } from './orca-health.ts';
import { delegationGateLine, zeroMatchLine } from './messages.ts';
import type { Logger } from './logger.ts';

/**
 * Repo routing & agent selection (spec §4, issues #10/#18): the curated
 * routing-hints file, versioned at the repo root, is both the enrichment the
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

/** Load the versioned hints file — called once at boot, failure is fatal. */
export function loadRoutingHints(filePath: string): RepoHint[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new RoutingHintsError(`cannot read routing hints at ${filePath}: ${String(error)}`);
  }
  return parseRoutingHints(text);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

// ── living registry ──────────────────────────────────────────────────────────

export interface RegistryRepo {
  id: string;
  /** The registry `displayName` — what a hints entry's `name` pins. */
  name: string;
}

/** Registry calls must not hang a suspended canUseTool call forever. */
const REGISTRY_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

export const orcaRunner: CommandRunner = (command, args) =>
  execFileAsync(command, args, { timeout: REGISTRY_TIMEOUT_MS });

/** `orca repo list --json` → the living registry. Throws when Orca is down. */
export async function listRegistryRepos(run: CommandRunner): Promise<RegistryRepo[]> {
  const { stdout } = await run('orca', ['repo', 'list', '--json']);
  const envelope = JSON.parse(stdout) as { ok?: boolean; result?: { repos?: unknown } };
  const repos = envelope.result?.repos;
  if (envelope.ok !== true || !Array.isArray(repos)) {
    throw new Error('unexpected `orca repo list` response shape');
  }
  // An entry without id or displayName cannot be matched — dropping it only
  // narrows the delegable surface, which is the fail-closed direction.
  return repos.flatMap((repo: unknown) => {
    const record = repo as { id?: unknown; displayName?: unknown };
    return typeof record.id === 'string' && typeof record.displayName === 'string'
      ? [{ id: record.id, name: record.displayName }]
      : [];
  });
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
    this.run = options.run ?? orcaRunner;
    this.logger = options.logger;
  }

  async check(repoRef: string | null): Promise<DelegationVerdict> {
    if (repoRef === null || repoRef.trim() === '') {
      return {
        allowed: false,
        reason: 'the delegation names no --repo, so it cannot be checked against the allow-list',
      };
    }
    // Accept the CLI's `id:<uuid>` ref form (spec §5) plus bare id or name.
    const ref = repoRef.replace(/^(id|name):/, '');

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

    const repo = registry.find((candidate) => candidate.id === ref || candidate.name === ref);
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
*1.* \`forwardly\` — the product: the export would live in the app, wired to real data
*2.* \`scratch\` — sandbox: a one-shot script alongside the product
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

- The user explicitly named BOTH the repo and the agent → no confirmation; the routing decision is final immediately.
- Anything inferred or uncertain (repo, agent, or both) → exactly one line, then end your message and wait for the reply (it arrives as the next thread message):

${delegationGateLine('<repo>', '<agent>')}

  An affirmative reply releases it; a reply naming a different repo or agent re-routes to that choice without another question.
- A disambiguation answer already IS the confirmation — asking again is forbidden.

## Current build — stop at the routing decision

Dispatch is not wired up yet (next slice). Once the routing decision is confirmed — or was fully explicit — state it in one line (target repo, its registry \`id\`, the agent) and stop. Do not run \`orca worktree create\` yet.`;
}

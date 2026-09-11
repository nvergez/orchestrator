/**
 * The tier classifier behind `canUseTool` (spec §7, issue #8): every Bash
 * command the orchestrator session asks for lands in exactly one tier —
 * AUTO runs silently, CONFIRM suspends behind the 🚦 thread gate, FORBIDDEN
 * is denied outright. Pure: no I/O, fully unit-testable. The same shell
 * reader also powers `extractDelegationRepoRefs` (issue #18) — the seam
 * permissions.ts runs the repo allow-list on.
 *
 * The binary boundary is fail-closed: only bare `orca` / `gh` / `git` (plus
 * the spec-gated `rm`) are recognized, compound commands take the tier of
 * their most dangerous segment, and command substitution — which could
 * smuggle anything — is forbidden without further analysis. Inside that
 * boundary the default is the opposite: a recognized binary runs, and only
 * the named irreversible commands (spec §7) suspend behind the 🚦.
 */

export type Tier = 'auto' | 'confirm' | 'forbidden';

export interface Verdict {
  tier: Tier;
  /** Human-readable ground for the verdict — logged, and shown on denials. */
  reason: string;
}

/** What the 🚦 gate line shows for a CONFIRM command. */
export interface GateDescription {
  command: string;
  /** `repo/worktree` label when the command targets one via `git -C`. */
  worktree?: string;
}

const SEVERITY: Record<Tier, number> = { auto: 0, confirm: 1, forbidden: 2 };

const auto = (reason: string): Verdict => ({ tier: 'auto', reason });
const confirm = (reason: string): Verdict => ({ tier: 'confirm', reason });
const forbidden = (reason: string): Verdict => ({ tier: 'forbidden', reason });

export function classifyCommand(command: string): Verdict {
  const parsed = parse(command);
  if (parsed.hasSubstitution) {
    return forbidden('command/process substitution can execute arbitrary commands');
  }
  if (parsed.segments.length === 0) {
    return forbidden('empty command');
  }

  let worst = auto('read/observe');
  for (const segment of parsed.segments) {
    const verdict = classifySegment(segment);
    if (SEVERITY[verdict.tier] > SEVERITY[worst.tier]) worst = verdict;
  }
  return worst;
}

/**
 * Render a CONFIRM command for the one-line 🚦 gate: a single git segment's
 * `-C <path>` is lifted out as the `repo/worktree` label (matching the UX
 * mock); anything else is shown verbatim, collapsed to one line.
 */
export function describeGate(command: string): GateDescription {
  const oneLine = command.trim().replace(/\s+/g, ' ');
  const parsed = parse(command);
  const tokens = parsed.segments.length === 1 ? (parsed.segments[0] as string[]) : [];
  // The parsed tokens are the ground truth for "-C is really the global
  // flag" — a `-C` inside a quoted argument never appears as its own token.
  const path = tokens[0] === 'git' && tokens[1] === '-C' ? tokens[2] : undefined;
  if (path !== undefined) {
    const match = oneLine.match(/(^|\s)-C\s+([^\s'"]+)(?=\s|$)/);
    if (match !== null && match[2] === path) {
      const parts = path.split('/').filter((part) => part !== '');
      if (parts.length > 0) {
        return {
          command: oneLine.replace(match[0], match[1] ?? '').replace(/\s+/g, ' ').trim(),
          worktree: parts.slice(-2).join('/'),
        };
      }
    }
  }
  return { command: oneLine };
}

/**
 * The `--repo` values of every `orca worktree create` segment in the command
 * — what the allow-list check in permissions.ts runs on before any tier is
 * honored (spec §7: the routing hints file is the delegation allow-list). A
 * create carrying no `--repo` yields a null entry so the caller can fail
 * closed on it.
 */
export function extractDelegationRepoRefs(command: string): Array<string | null> {
  const refs: Array<string | null> = [];
  for (const tokens of parse(command).segments) {
    if (tokens[0] !== 'orca') continue;
    // Adjacent `worktree create` tokens anywhere in the segment — not just as
    // the first non-flag words — so a value-carrying flag ahead of the
    // subcommand cannot route a create around the allow-list.
    const isCreate = tokens.some(
      (token, index) => token === 'worktree' && tokens[index + 1] === 'create',
    );
    if (!isCreate) continue;
    let found = false;
    for (let i = 1; i < tokens.length; i += 1) {
      const token = tokens[i] as string;
      if (token === '--repo') {
        refs.push(tokens[i + 1] ?? null);
        found = true;
      } else if (token.startsWith('--repo=')) {
        refs.push(token.slice('--repo='.length));
        found = true;
      }
    }
    if (!found) refs.push(null);
  }
  return refs;
}

/**
 * The quote-stripped tokens of each top-level command segment — the shell
 * surface the delegation coordinator (issue #19) and the gate relay (issue
 * #21) read commands and flag values through, so they can never disagree
 * with the classifier about where a segment starts or what is quoted.
 */
export function commandSegments(command: string): string[][] {
  return parse(command).segments;
}

// ── token helpers over a parsed segment ──────────────────────────────────────

/** Adjacent `<topic> <action>` anywhere in an orca segment — value-carrying
 * flags ahead of the subcommand cannot hide it. */
export function isOrcaCommand(tokens: string[], topic: string, action: string): boolean {
  return (
    tokens[0] === 'orca' &&
    tokens.some((token, index) => token === topic && tokens[index + 1] === action)
  );
}

export function hasFlag(tokens: string[], flag: string): boolean {
  return flagCount(tokens, flag) > 0;
}

export function flagCount(tokens: string[], flag: string): number {
  return tokens.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
}

export function flagValue(tokens: string[], flag: string): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === flag) return tokens[i + 1];
    if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  }
  return undefined;
}

const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Re-quotes one stripped token for a rebuilt command line. */
export function shellQuote(token: string): string {
  if (token !== '' && SAFE_TOKEN.test(token)) return token;
  return `'${token.replaceAll("'", String.raw`'\''`)}'`;
}

// ── shell surface parsing ────────────────────────────────────────────────────

interface ParsedCommand {
  /** Quote-stripped tokens of each top-level command segment. */
  segments: string[][];
  /** `$(…)`, backticks, or `<(…)`/`>(…)` seen where the shell would run them. */
  hasSubstitution: boolean;
}

/**
 * A deliberately small shell reader: enough quoting/operator awareness to
 * split compound commands and spot substitution, never enough to be clever.
 * A misread never smuggles a binary past the allow-list: the first word of
 * every segment is matched literally, and substitution is forbidden whole.
 */
function parse(command: string): ParsedCommand {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  let hasSubstitution = false;

  const endToken = (): void => {
    if (hasToken) tokens.push(current);
    current = '';
    hasToken = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;

    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      // Escape survives inside double quotes too — close enough to bash for
      // classification purposes ("\$(x)" stays literal, as in the shell).
      const next = command[i + 1];
      if (next !== undefined) {
        current += next;
        hasToken = true;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        if ((ch === '$' && command[i + 1] === '(') || ch === '`') hasSubstitution = true;
        current += ch;
      }
      i += 1;
      continue;
    }

    switch (ch) {
      case "'":
        inSingle = true;
        hasToken = true;
        i += 1;
        break;
      case '"':
        inDouble = true;
        hasToken = true;
        i += 1;
        break;
      case '`':
        hasSubstitution = true;
        i += 1;
        break;
      case '$':
        if (command[i + 1] === '(') {
          hasSubstitution = true;
          i += 2;
        } else {
          current += ch;
          hasToken = true;
          i += 1;
        }
        break;
      case '<':
      case '>': {
        if (command[i + 1] === '(') {
          hasSubstitution = true;
          i += 2;
          break;
        }
        // A pure-digit token glued to the operator is the fd, not an argument.
        if (hasToken && /^\d+$/.test(current)) {
          current = '';
          hasToken = false;
        } else {
          endToken();
        }
        let j = i + 1;
        while (j < command.length && '><&|'.includes(command[j] as string)) j += 1;
        while (j < command.length && (command[j] === ' ' || command[j] === '\t')) j += 1;
        // Swallow the redirect target so it is never read as an argument.
        while (j < command.length && !' \t\n;|&<>'.includes(command[j] as string)) j += 1;
        i = j;
        break;
      }
      case '&':
      case '|':
      case ';':
      case '\n':
      case '(':
      case ')':
        endSegment();
        i += 1;
        if ((ch === '&' || ch === '|') && command[i] === ch) i += 1;
        break;
      case ' ':
      case '\t':
      case '\r':
        endToken();
        i += 1;
        break;
      case '#':
        if (!hasToken) {
          while (i < command.length && command[i] !== '\n') i += 1;
        } else {
          current += ch;
          i += 1;
        }
        break;
      default:
        current += ch;
        hasToken = true;
        i += 1;
        break;
    }
  }
  endSegment();
  return { segments, hasSubstitution };
}

// ── per-binary rules ─────────────────────────────────────────────────────────

// ── per-binary rules ─────────────────────────────────────────────────────────

/**
 * Inside the allow-listed binaries the default is AUTO. `orca`, `gh` and
 * `git` are the orchestrator's working surface, and gating whatever the
 * classifier did not recognize turned every guessed CLI spelling, every
 * ordinary `gh` write and every local `git` command into a 🚦 the human had
 * to answer for nothing. Only the commands below earn a gate: the ones whose
 * damage nobody can undo from the thread — destroying work that was never
 * pushed, rewriting published history, merging, or handing the operator's
 * credentials around. Typing into a worker's terminal is not one of them:
 * the relay already owns what a send may carry (relay.ts), and a nudge is
 * undone by the next one. Reversible writes (a commit, a branch, a PR, a
 * comment) run silently; the review of what a worker produced happens on the
 * pull request, not at the command line.
 */
function classifySegment(tokens: string[]): Verdict {
  const head = tokens[0] as string;
  switch (head) {
    case 'orca':
      return classifyOrca(tokens.slice(1));
    case 'gh':
      return classifyGh(tokens.slice(1));
    case 'git':
      return classifyGit(tokens.slice(1));
    case 'rm':
      return confirm('`rm` deletes files on the machine irreversibly');
    default:
      // Also catches wrappers (sudo/env/bash -c) and VAR=… prefixes: the
      // first word must literally be an allow-listed binary.
      return forbidden(`\`${head}\` is outside the orca/gh/git allow-list`);
  }
}

/** First `count` non-flag words — the `<topic> <action>` of a CLI call. */
function commandWords(args: string[], count: number): (string | undefined)[] {
  const words: (string | undefined)[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    words.push(arg);
    if (words.length === count) break;
  }
  while (words.length < count) words.push(undefined);
  return words;
}

/**
 * A `--help` the CLI is guaranteed to honor as the help flag. Presence alone
 * is not enough: quote-stripping makes `--text '--help'` identical to
 * `--text --help`, where a CLI parser may consume the token as the flag's
 * value and run the command anyway — so a `--help` sitting right after a
 * value-taking-looking flag falls through to the normal rules, and nothing
 * after a literal `--` counts (operands, not flags). Misreads land on the
 * stricter tier, per the module contract.
 */
function carriesHelp(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === '--') return false;
    if (token !== '--help') continue;
    const prev = args[i - 1];
    if (prev !== undefined && prev.startsWith('-') && !prev.includes('=')) continue;
    return true;
  }
  return false;
}

/**
 * True when a long flag appears, or a short cluster carries one of `short` —
 * so `-fd` is read the way git reads it, not as an opaque token.
 */
function carriesFlag(tokens: string[], short: RegExp, long: readonly string[]): boolean {
  return tokens.some(
    (token) =>
      long.includes(token.split('=')[0] as string) ||
      (/^-[a-zA-Z]+$/.test(token) && short.test(token.slice(1))),
  );
}

/** Worktree actions that take a worktree — and its unpushed work — away. */
const ORCA_WORKTREE_DESTROY = new Set(['delete', 'remove', 'rm', 'archive']);

function classifyOrca(args: string[]): Verdict {
  // Help output mutates nothing (issue #45) — AUTO even on gated or
  // forbidden topics, because the CLI short-circuits on `--help` before
  // validating required flags (verified live: `orca worktree rm --help`
  // prints usage and exits 0).
  if (carriesHelp(args)) return auto('`--help` prints usage');
  const [topic, action] = commandWords(args, 2);
  if (topic === 'automation' || topic === 'automations') {
    return forbidden('Orca automation management from Slack is out of scope (spec §7)');
  }
  if (topic === 'repo' && action !== undefined && action !== 'list') {
    return forbidden('repo creation/registration from Slack is out of scope (spec §7)');
  }
  if (topic === 'worktree' && action !== undefined && ORCA_WORKTREE_DESTROY.has(action)) {
    return confirm('removing a worktree destroys whatever its worker never pushed');
  }
  return auto('orca is the delegation surface — reversible by design');
}

const GH_FORBIDDEN_REPO_ACTIONS = new Set([
  'create',
  'delete',
  'rename',
  'fork',
  'edit',
  'archive',
  'unarchive',
  'transfer',
  'sync',
]);

/** Release actions that publish or unpublish outside GitHub's review flow. */
const GH_RELEASE_WRITES = new Set(['create', 'delete', 'edit', 'upload', 'delete-asset']);

function classifyGh(args: string[]): Verdict {
  const [topic, action] = commandWords(args, 2);
  if (topic === 'repo' && action !== undefined && GH_FORBIDDEN_REPO_ACTIONS.has(action)) {
    return forbidden('GitHub repo management from Slack is out of scope (spec §7)');
  }
  if (topic === 'pr' && action === 'merge') {
    return confirm('`gh pr merge` lands code on the default branch');
  }
  if (topic === 'release' && action !== undefined && GH_RELEASE_WRITES.has(action)) {
    return confirm('a release ships outside the repo — never on the orchestrator\'s own call');
  }
  if (topic === 'issue' && action === 'delete') {
    return confirm('deleting an issue is irreversible');
  }
  if (topic === 'auth') {
    return confirm('`gh auth` reads or rewrites the operator\'s GitHub credentials');
  }
  if (topic === 'api' && mutatesOverApi(args)) {
    return confirm('`gh api` with a write method can do anything the token can');
  }
  return auto('gh reads and reversible writes — the PR is the review surface');
}

/**
 * A `gh api` call that writes: an explicit non-read `--method`, or the
 * fields that make gh default to POST. A read stays AUTO like any other.
 */
function mutatesOverApi(args: string[]): boolean {
  const method = flagValue(args, '-X') ?? flagValue(args, '--method');
  if (method !== undefined) return !['GET', 'HEAD'].includes(method.toUpperCase());
  return args.some((token) =>
    ['-f', '-F', '--field', '--raw-field', '--input'].includes(token.split('=')[0] as string),
  );
}

/** git global flags that consume the next token when not written as --x=y. */
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function classifyGit(args: string[]): Verdict {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) {
    i += GIT_VALUE_GLOBALS.has(args[i] as string) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return auto('bare git prints usage');

  switch (sub) {
    case 'push':
      return classifyPush(rest);
    case 'reset':
      return rest.includes('--hard')
        ? confirm('`git reset --hard` throws away work that was never committed')
        : auto('git reset moves a ref, the work stays');
    case 'clean':
      return carriesFlag(rest, /f/, ['--force'])
        ? confirm('`git clean -f` deletes untracked files outright')
        : auto('git clean without --force only lists');
    case 'branch':
      return carriesFlag(rest, /d/i, ['--delete'])
        ? confirm('branch deletion')
        : auto('git branch');
    case 'tag':
      return carriesFlag(rest, /d/, ['--delete'])
        ? confirm('tag deletion')
        : auto('git tag');
    case 'worktree':
      return rest[0] === 'remove' || rest[0] === 'prune'
        ? confirm('removing a worktree destroys whatever it holds uncommitted')
        : auto('git worktree');
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear'
        ? confirm('a dropped stash is unrecoverable')
        : auto('git stash');
    case 'filter-branch':
      return confirm('`git filter-branch` rewrites history irreversibly');
    default:
      // Commits, checkouts, merges, rebases: local, reversible, and the
      // orchestrator barely runs them — gating them bought nothing.
      return auto('git works inside a worktree and stays undoable');
  }
}

/** Force, delete and mirror pushes overwrite what is already published. */
function classifyPush(rest: string[]): Verdict {
  const destructive = rest.some(
    (token) =>
      token.startsWith('--force') ||
      token === '--delete' ||
      token === '--mirror' ||
      token === '--prune' ||
      // A leading `+` on a refspec is the force marker.
      token.startsWith('+') ||
      (/^-[a-zA-Z]+$/.test(token) && /[fd]/.test(token.slice(1))),
  );
  return destructive
    ? confirm('a force/delete push overwrites history other people already have')
    : auto('`git push` publishes a branch — reviewable on the PR, not at the gate');
}

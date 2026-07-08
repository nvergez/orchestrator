/**
 * The tier classifier behind `canUseTool` (spec §7, issue #8): every Bash
 * command the orchestrator session asks for lands in exactly one tier —
 * AUTO runs silently, CONFIRM suspends behind the 🚦 thread gate, FORBIDDEN
 * is denied outright. Pure: no I/O, fully unit-testable.
 *
 * Fail-closed by construction: only bare `orca` / `gh` / `git` (plus the
 * spec-gated `rm`) are recognized; compound commands take the tier of their
 * most dangerous segment; command substitution — which could smuggle
 * anything — is forbidden without further analysis.
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
  if (worst.tier === 'auto' && parsed.writesFile) {
    return confirm('output is redirected into a file');
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
    const [topic, action] = commandWords(tokens.slice(1), 2);
    if (topic !== 'worktree' || action !== 'create') continue;
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

// ── shell surface parsing ────────────────────────────────────────────────────

interface ParsedCommand {
  /** Quote-stripped tokens of each top-level command segment. */
  segments: string[][];
  /** `$(…)`, backticks, or `<(…)`/`>(…)` seen where the shell would run them. */
  hasSubstitution: boolean;
  /** Output redirected somewhere other than /dev/null or another fd. */
  writesFile: boolean;
}

/**
 * A deliberately small shell reader: enough quoting/operator awareness to
 * split compound commands and spot substitution, never enough to be clever.
 * Anything it misreads falls toward a stricter tier, not a looser one —
 * misparsed segments land on unknown-command defaults (CONFIRM at best).
 */
function parse(command: string): ParsedCommand {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  let hasSubstitution = false;
  let writesFile = false;

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
        const operator = command.slice(i, j);
        while (j < command.length && (command[j] === ' ' || command[j] === '\t')) j += 1;
        let target = '';
        while (j < command.length && !' \t\n;|&<>'.includes(command[j] as string)) {
          target += command[j] as string;
          j += 1;
        }
        if (ch === '>' && !operator.includes('&') && target !== '/dev/null') {
          writesFile = true;
        }
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
  return { segments, hasSubstitution, writesFile };
}

// ── per-binary rules ─────────────────────────────────────────────────────────

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
      return confirm('`rm` deletes files (spec §7: deletions are gated)');
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

const ORCA_AUTO: Record<string, Set<string>> = {
  // Reads plus the full delegation sequence (issue #8: no double ceremony —
  // the routing gate of #10 already covers inferred delegations).
  worktree: new Set(['ps', 'create']),
  terminal: new Set(['list', 'wait']),
  // reply/gate-resolve are AUTO for relays carrying a human reply (spec §7).
  // The "carrying a human reply" condition is not checkable from the command
  // string alone; the #9 relay slice anchors it on the pending_gates
  // registry once that exists. Until then the enumerated commands are AUTO.
  orchestration: new Set([
    'check',
    'task-list',
    'task-create',
    'dispatch',
    'reply',
    'gate-resolve',
  ]),
};

function classifyOrca(args: string[]): Verdict {
  const [topic, action] = commandWords(args, 2);
  if (topic === 'automation' || topic === 'automations') {
    return forbidden('Orca automation management from Slack is out of scope (spec §7)');
  }
  if (topic === 'repo') {
    return action === 'list'
      ? auto('orca read')
      : forbidden('repo creation/registration from Slack is out of scope (spec §7)');
  }
  if (topic === 'worktree' && (action === 'delete' || action === 'remove' || action === 'rm')) {
    return confirm('worktree deletion');
  }
  if (topic === 'terminal' && action === 'send') {
    // Spec §7's AUTO list is `terminal list/wait` only: send types arbitrary
    // input into a worker terminal, so it gates until the #9 relay slice can
    // anchor "carries a human reply" on the pending_gates registry.
    return confirm('`orca terminal send` types into a worker terminal');
  }
  if (topic !== undefined && action !== undefined && ORCA_AUTO[topic]?.has(action) === true) {
    return auto('orca read/delegation/relay');
  }
  return confirm('unrecognized orca command — gated rather than trusted');
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

const GH_READ_ACTIONS = new Set(['view', 'list', 'status', 'diff', 'checks']);

function classifyGh(args: string[]): Verdict {
  const [topic, action] = commandWords(args, 2);
  if (topic === 'repo') {
    if (action !== undefined && GH_FORBIDDEN_REPO_ACTIONS.has(action)) {
      return forbidden('GitHub repo management from Slack is out of scope (spec §7)');
    }
    if (action === 'view' || action === 'list') return auto('gh read');
    return confirm('unrecognized gh repo command — gated');
  }
  if (topic === 'status' || topic === 'search') {
    return auto('gh read');
  }
  if (action !== undefined && GH_READ_ACTIONS.has(action)) {
    return auto('gh read');
  }
  return confirm('gh write operation — gated');
}

/** git global flags that consume the next token when not written as --x=y. */
const GIT_VALUE_GLOBALS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const GIT_READ_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'fetch',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'cat-file',
  'grep',
  'merge-base',
  'for-each-ref',
  'name-rev',
  'check-ignore',
  'version',
  'help',
]);

/**
 * Subcommands that are reads only in specific first-argument forms — bare
 * `git stash` pushes, `git stash list` reads. `bareIsRead` says whether the
 * argument-less form is one of the read forms.
 */
const GIT_READ_FORMS: Record<string, { forms: Set<string>; bareIsRead: boolean }> = {
  remote: { forms: new Set(['show', 'get-url', '-v']), bareIsRead: true },
  stash: { forms: new Set(['list', 'show']), bareIsRead: false },
  worktree: { forms: new Set(['list']), bareIsRead: false },
  config: {
    forms: new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']),
    bareIsRead: false,
  },
  reflog: { forms: new Set(['show']), bareIsRead: true },
};

function classifyGit(args: string[]): Verdict {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) {
    i += GIT_VALUE_GLOBALS.has(args[i] as string) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);

  if (sub === undefined) return auto('bare git prints usage');
  if (GIT_READ_SUBCOMMANDS.has(sub)) return auto('git read');

  const readForms = GIT_READ_FORMS[sub];
  if (readForms !== undefined) {
    const first = rest[0];
    const isRead = first === undefined ? readForms.bareIsRead : readForms.forms.has(first);
    return isRead ? auto('git read') : confirm(`\`git ${sub}\` mutation`);
  }

  switch (sub) {
    case 'push':
      return confirm('`git push` publishes commits (spec §7)');
    case 'merge':
      return confirm('`git merge` (spec §7)');
    case 'pull':
      return confirm('`git pull` runs a merge');
    case 'branch':
      return classifyRefListing(rest, 'branch');
    case 'tag':
      return classifyRefListing(rest, 'tag');
    default:
      return confirm(`\`git ${sub}\` mutates state — gated`);
  }
}

/**
 * `git branch` / `git tag` are reads only in their bare listing forms; a
 * delete/move/force flag — even buried in a short-option cluster like
 * `-avD` — or any positional argument flips them into gated writes.
 */
function classifyRefListing(rest: string[], kind: 'branch' | 'tag'): Verdict {
  // -a/-s are harmless on branch (--all) but writes on tag (--annotate/--sign).
  const shortMutating = kind === 'branch' ? /[mMcCf]/ : /[fasu]/;
  const longMutating =
    kind === 'branch'
      ? ['--move', '--copy', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description']
      : ['--force', '--annotate', '--sign', '--local-user'];
  const deletes = rest.some(
    (token) =>
      token === '--delete' || (/^-[a-zA-Z]+$/.test(token) && /[dD]/.test(token.slice(1))),
  );
  if (deletes) return confirm(`${kind} deletion (spec §7)`);
  const mutates = rest.some(
    (token) =>
      longMutating.includes(token.split('=')[0] as string) ||
      (/^-[a-zA-Z]+$/.test(token) && shortMutating.test(token.slice(1))),
  );
  const positional = rest.some((token) => !token.startsWith('-'));
  if (mutates || positional) return confirm(`${kind} creation/mutation`);
  return auto('git read');
}

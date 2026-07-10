import { hasFlag } from './guardrails.ts';

/**
 * The dispatch protocol's single source of truth (spec §5). Each flag
 * invariant of the delegation sequence lives here exactly once, as a
 * machine-usable rule (flag, required/forbidden) plus the human sentence
 * for it. `routingInstructions` (routing.ts) renders the prose the session
 * follows from this table, and the delegation coordinator's `prepare`
 * (delegation/dispatch.ts) enforces the same entries via `flagViolation` —
 * so the prose the LLM reads and the checks that stop it cannot drift apart.
 *
 * Deliberately NOT table-driven — enforced (or stated) elsewhere, because
 * their machine form is not a flag rule and forcing them in would make the
 * table dishonest:
 * - one-step-per-Bash-call: prose intro + `prepare`'s segment count.
 * - the worktree `--name` shape (`<repo>-<issue#>-<slug>` bound to
 *   `--issue`): a cross-flag validator (worktree-name.ts) in
 *   `prepareCreate`; the prose carries the shape inside the command
 *   template's fixed args.
 * - `--repo` presence: enforced by the routing allow-list (permissions.ts
 *   over `extractDelegationRepoRefs`), which fails closed on a missing ref.
 * - dispatch `--to` targeting a listed handle awaited to tui-idle, the
 *   worker cap, the no-`$` rewrite guard: stateful/mechanical daemon
 *   concerns in `prepare` — the prose orders the steps, the tracker
 *   enforces the order.
 * - guardrails.ts tier classification: a different axis (what may run at
 *   all, spec §7), independent of this table on purpose.
 */

export type FlagRule =
  | {
      presence: 'required';
      flag: string;
      /** How the flag reads in the prose command template (`--issue <n>`). */
      placeholder?: string;
      /** Optional reason — surfaces in the deny message, not the prose. */
      why?: string;
    }
  | {
      presence: 'forbidden';
      flag: string;
      /** The reason — rendered into the prose warning AND the deny message. */
      why: string;
    };

export interface ProtocolStep {
  /** `orca <topic> <action>` — the segment identity `prepare` matches on. */
  topic: string;
  action: string;
  /** Fixed placeholder args of the prose command template — the flags whose
   * rules are enforced elsewhere (see the module comment). */
  fixedArgs: string;
  /** The table: checked by `flagViolation` in declaration order, required
   * ones rendered into the prose command template in declaration order. */
  flags: FlagRule[];
}

/** Step 2 of the sequence — `orca worktree create`. */
export const CREATE_STEP: ProtocolStep = {
  topic: 'worktree',
  action: 'create',
  fixedArgs: '--repo id:<repoId> --name <repo>-<n>-<slug>',
  flags: [
    {
      presence: 'forbidden',
      flag: '--prompt',
      why:
        'the brief travels with `dispatch --inject`, or the worker misses ' +
        'the coordinator preamble and never reports done',
    },
    { presence: 'required', flag: '--agent', placeholder: '<agent>' },
    { presence: 'required', flag: '--issue', placeholder: '<n>' },
    { presence: 'required', flag: '--no-parent' },
    { presence: 'required', flag: '--json' },
  ],
};

/** Step 6 of the sequence — `orca orchestration dispatch`. */
export const DISPATCH_STEP: ProtocolStep = {
  topic: 'orchestration',
  action: 'dispatch',
  fixedArgs: '--task <taskId> --to <handle>',
  flags: [
    {
      presence: 'forbidden',
      flag: '--from',
      why: 'the daemon supplies the thread mailbox terminal itself',
    },
    {
      presence: 'required',
      flag: '--inject',
      why: 'the worker receives the coordinator preamble and can emit worker_done',
    },
    { presence: 'required', flag: '--json' },
  ],
};

/** The step's prose command template — fixed args, then the required flags. */
export function stepCommandTemplate(step: ProtocolStep): string {
  const required = step.flags
    .filter((rule) => rule.presence === 'required')
    .map((rule) => (rule.placeholder === undefined ? rule.flag : `${rule.flag} ${rule.placeholder}`))
    .join(' ');
  return `orca ${step.topic} ${step.action} ${step.fixedArgs} ${required}`;
}

/** The step's prose warnings — one `NEVER pass …` per forbidden flag. */
export function stepWarnings(step: ProtocolStep): string {
  return step.flags
    .filter((rule) => rule.presence === 'forbidden')
    .map((rule) => `NEVER pass \`${rule.flag}\`: ${rule.why}.`)
    .join(' ');
}

/**
 * The machine half: the first table rule the command's tokens violate,
 * phrased as the deny message `prepare` returns — undefined when every
 * flag rule of the step holds.
 */
export function flagViolation(step: ProtocolStep, tokens: string[]): string | undefined {
  for (const rule of step.flags) {
    if (rule.presence === 'forbidden' && hasFlag(tokens, rule.flag)) {
      return `never pass ${rule.flag} — ${rule.why} (spec §5)`;
    }
    if (rule.presence === 'required' && !hasFlag(tokens, rule.flag)) {
      const command = `\`orca ${step.topic} ${step.action}\``;
      return rule.why === undefined
        ? `${command} must carry ${rule.flag} here (spec §5) — add it and retry`
        : `${command} must carry ${rule.flag} — ${rule.why} (spec §5); add it and retry`;
    }
  }
  return undefined;
}

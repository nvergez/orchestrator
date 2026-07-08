import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { classifyCommand, describeGate, extractDelegationRepoRefs } from './guardrails.ts';
import { gateLine } from './messages.ts';
import type { GateRequester } from './gate.ts';
import type { DelegationVerdict } from './routing.ts';
import type { Logger } from './logger.ts';

/** The slice of RepoAllowList this hook consults for every delegation. */
export interface DelegationPolicy {
  /** Verdict on one `--repo` ref; null means the create carried none. */
  check(repoRef: string | null): Promise<DelegationVerdict>;
}

/**
 * The `canUseTool` enforcement hook (spec §7): the bridge between the pure
 * tier classifier and the SDK's permission protocol. One instance per
 * session, bound to its Slack thread so CONFIRM gates land in the right
 * place.
 */
export function buildCanUseTool(opts: {
  threadTs: string;
  gates: GateRequester;
  allowList: DelegationPolicy;
  logger: Logger;
}): CanUseTool {
  const { threadTs, gates, allowList, logger } = opts;
  return async (toolName, input, { signal }) => {
    // The session's base tool set is Bash-only, but fail closed anyway: the
    // orchestrator routes/delegates/supervises, it never codes (spec §7).
    if (toolName !== 'Bash') {
      logger.warn({ threadTs, toolName }, 'non-Bash tool call denied');
      return {
        behavior: 'deny',
        message:
          `The ${toolName} tool is not available to the orchestrator — ` +
          'it only runs orca / gh / git commands through Bash.',
      };
    }

    const command = typeof input.command === 'string' ? input.command : '';
    const verdict = classifyCommand(command);
    logger.info(
      { threadTs, command, tier: verdict.tier, reason: verdict.reason },
      'bash command classified',
    );

    // Routing enforcement (spec §4/§7, issue #18): a delegation's --repo must
    // resolve to a repo that is both registered AND in the hints allow-list —
    // checked before any tier is honored, so an off-list repo is denied, not
    // gated. Substitution-carrying commands never get here (forbidden above).
    if (verdict.tier !== 'forbidden') {
      for (const repoRef of extractDelegationRepoRefs(command)) {
        const check = await allowList.check(repoRef);
        if (!check.allowed) {
          logger.warn(
            { threadTs, command, repoRef, reason: check.reason },
            'delegation denied by the repo allow-list',
          );
          return {
            behavior: 'deny',
            message:
              `Delegation refused: ${check.reason}. Treat this as a zero-match ` +
              '(stop and list the delegable repos) — do not retry with another ref ' +
              'for the same repo.',
          };
        }
      }
    }

    switch (verdict.tier) {
      case 'auto':
        return { behavior: 'allow', updatedInput: input };
      case 'forbidden':
        return {
          behavior: 'deny',
          message:
            `Forbidden: ${verdict.reason}. Only orca / gh / git commands are ` +
            'available to the orchestrator; this is a hard boundary — do not retry ' +
            'and do not ask the user to approve it.',
        };
      case 'confirm': {
        const gate = describeGate(command);
        const answer = await gates.request(threadTs, gateLine(gate.command, gate.worktree), signal);
        if (answer.approved) {
          return { behavior: 'allow', updatedInput: input };
        }
        return {
          behavior: 'deny',
          message:
            `The user did not approve the 🚦 gate — they replied: "${answer.reply}". ` +
            'The command was not run.',
        };
      }
    }
  };
}

const FORCE_ASK: HookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'ask',
    permissionDecisionReason:
      'orchestrator guardrails: every Bash call is classified in canUseTool',
  },
};

/**
 * A PreToolUse hook that forces the 'ask' path for every Bash call, so
 * filesystem permission rules (e.g. allow rules accumulated in
 * ~/.claude/settings.json on the VPS) can never route a command around the
 * classifier. `canUseTool` stays the single enforcement point.
 */
export function guardrailHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ matcher: 'Bash', hooks: [() => Promise.resolve(FORCE_ASK)] }],
  };
}

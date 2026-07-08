import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { classifyCommand, describeGate } from './guardrails.ts';
import { gateLine } from './messages.ts';
import type { GateRequester } from './gate.ts';
import type { Logger } from './logger.ts';

/**
 * The `canUseTool` enforcement hook (spec §7): the bridge between the pure
 * tier classifier and the SDK's permission protocol. One instance per
 * session, bound to its Slack thread so CONFIRM gates land in the right
 * place.
 */
export function buildCanUseTool(opts: {
  threadTs: string;
  gates: GateRequester;
  logger: Logger;
}): CanUseTool {
  const { threadTs, gates, logger } = opts;
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

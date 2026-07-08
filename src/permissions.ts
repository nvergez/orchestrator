import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { classifyCommand, describeGate, extractDelegationRepoRefs } from './guardrails.ts';
import { gateLine } from './messages.ts';
import type { GateRequester } from './gate.ts';
import type { DelegationVerdict } from './routing.ts';
import type { DispatchObserver, DispatchPreparer } from './dispatch.ts';
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
 * place. The delegation coordinator (issue #19) gets the last word on an
 * approved command: it holds the worker cap on `worktree create` and
 * rewrites `orchestration dispatch` to origin from the thread mailbox.
 */
export function buildCanUseTool(opts: {
  threadTs: string;
  gates: GateRequester;
  allowList: DelegationPolicy;
  delegations: DispatchPreparer;
  logger: Logger;
}): CanUseTool {
  const { threadTs, gates, allowList, delegations, logger } = opts;
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
        break;
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
        if (!answer.approved) {
          return {
            behavior: 'deny',
            message:
              `The user did not approve the 🚦 gate — they replied: "${answer.reply}". ` +
              'The command was not run.',
          };
        }
        break;
      }
    }

    // The delegation seam runs last, on an already-classified-and-approved
    // command: a wave wait must not start for a command a gate then refuses.
    const prepared = await delegations.prepare(threadTs, command, signal);
    if (prepared.action === 'deny') {
      logger.warn(
        { threadTs, command, reason: prepared.message },
        'command denied by the delegation coordinator',
      );
      return { behavior: 'deny', message: `Delegation refused: ${prepared.message}.` };
    }
    return {
      behavior: 'allow',
      updatedInput: prepared.command === command ? input : { ...input, command: prepared.command },
    };
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
 * Session hooks. PreToolUse forces the 'ask' path for every Bash call, so
 * filesystem permission rules (e.g. allow rules accumulated in
 * ~/.claude/settings.json on the VPS) can never route a command around the
 * classifier — `canUseTool` stays the single enforcement point. PostToolUse
 * (and its failure twin) feed every finished Bash command to the delegation
 * observer, which is how the card, the 👀 and the `delegations` row happen
 * without trusting the session to report its own outputs.
 */
export function guardrailHooks(opts: {
  threadTs: string;
  delegations: DispatchObserver;
  logger: Logger;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const { threadTs, delegations, logger } = opts;
  const observe = async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') {
      const command = (input.tool_input as { command?: unknown } | null)?.command;
      if (typeof command === 'string') {
        const stdout =
          input.hook_event_name === 'PostToolUse' ? bashStdout(input.tool_response) : '';
        // observe never throws; a hook rejection would fail the whole turn.
        await delegations.observe(threadTs, command, stdout).catch((error: unknown) => {
          logger.warn({ err: error, threadTs }, 'delegation observer hook failed');
        });
      }
    }
    return {};
  };
  return {
    PreToolUse: [{ matcher: 'Bash', hooks: [() => Promise.resolve(FORCE_ASK)] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [observe] }],
    PostToolUseFailure: [{ matcher: 'Bash', hooks: [observe] }],
  };
}

/** The Bash tool's response carries stdout in one of a few shapes — read all. */
function bashStdout(response: unknown): string {
  if (typeof response === 'string') return response;
  if (typeof response !== 'object' || response === null) return '';
  const record = response as { stdout?: unknown; content?: unknown };
  if (typeof record.stdout === 'string') return record.stdout;
  if (Array.isArray(record.content)) {
    return record.content
      .map((block: unknown) => {
        const text = (block as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

import {
  query,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './logger.ts';
import type { ProcessFactory, TurnEvents, TurnOutcome } from './sessions.ts';
import { TurnCostMeter } from './cost.ts';
import { buildCanUseTool, guardrailHooks, type DelegationPolicy } from './permissions.ts';
import type { DispatchObserver, DispatchPreparer } from './dispatch.ts';
import type { SessionGates } from './gate.ts';
import type { SessionRelay } from './relay.ts';

/** The coordinator slice a session process holds (issue #19). */
export type SessionDelegations = DispatchPreparer & DispatchObserver;

/**
 * The Claude Agent SDK adapter behind `OrchestratorProcess` (spec §1/§3):
 * one `claude` subprocess per live thread, fed over streaming input so warm
 * turns reuse the process, cold starts resume via the persisted session_id.
 */

/** Push-based async iterable — the SDK's streaming-input channel. */
class Pushable<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.values.push(value);
  }

  /** Ends the stream; a healthy CLI exits once its input closes. */
  end(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** How long `end()` waits for the subprocess to finish before abandoning it. */
const END_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Gate-denial conduct appended to every session's system prompt (issue #47):
 * a denied 🚦 travels back as a tool-permission error carrying the human's
 * verbatim reply, and without these lines the model tended to retry the same
 * command — an unexplained identical gate from the human's side — or to drop
 * the question it was mid-way through answering when a read got denied.
 */
const GATE_DENIAL_CONDUCT = `## 🚦 gate denials

When a command is denied because the user did not approve the 🚦 gate:
- Acknowledge it visibly in one short line ("Taking that as a no — skipping \`<command>\`."), then follow whatever the denial reply asked for instead. Never re-run the same command after a denial — a fresh identical 🚦 with no explanation reads as a bug, not persistence.
- If the denied command was a read you needed to answer the user's question, still answer best-effort from what you already know, saying which check was skipped.`;

class ClaudeProcess {
  private readonly input = new Pushable<SDKUserMessage>();
  private readonly session: Query;
  private readonly logger: Logger;
  // One meter per process — see TurnCostMeter for the cumulative semantics.
  private readonly costMeter = new TurnCostMeter();
  private readonly gates: SessionGates;
  private readonly delegations: SessionDelegations;
  private readonly threadTs: string;

  constructor(opts: {
    resumeSessionId: string | null;
    threadTs: string;
    cwd: string;
    gates: SessionGates;
    allowList: DelegationPolicy;
    delegations: SessionDelegations;
    relay: SessionRelay;
    systemPromptAppend: string;
    logger: Logger;
  }) {
    this.logger = opts.logger;
    this.gates = opts.gates;
    this.delegations = opts.delegations;
    this.threadTs = opts.threadTs;
    this.session = query({
      prompt: this.input,
      options: {
        ...(opts.resumeSessionId !== null && { resume: opts.resumeSessionId }),
        cwd: opts.cwd,
        // Post-then-edit needs deltas, not just whole assistant messages.
        includePartialMessages: true,
        // Spec §7: the session's only side-effecting tool is Bash — no
        // file-editing tools, the orchestrator never codes itself.
        tools: ['Bash'],
        // The orchestrator role and the routing rules (spec §4, issue #18)
        // ride on the Claude Code preset — appended, never replacing it, so
        // the CLI's own tool-use behavior stays intact.
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${opts.systemPromptAppend}\n\n${GATE_DENIAL_CONDUCT}`,
        },
        // Enforcement (spec §7): 'default' routes every would-prompt call
        // into canUseTool, and the PreToolUse ask-hook forces even
        // settings-allowed Bash commands down that same path — AUTO runs
        // silently, CONFIRM suspends behind the 🚦 gate, FORBIDDEN is denied.
        permissionMode: 'default',
        canUseTool: buildCanUseTool({
          threadTs: opts.threadTs,
          gates: opts.gates,
          allowList: opts.allowList,
          delegations: opts.delegations,
          relay: opts.relay,
          logger: opts.logger,
        }),
        hooks: guardrailHooks({
          threadTs: opts.threadTs,
          delegations: opts.delegations,
          relay: opts.relay,
          logger: opts.logger,
        }),
        // settingSources and env are deliberately NOT set: omitting them keeps
        // CLI-default settings loading (never `--bare`, spec §10 — bare would
        // strip the OAuth token) and lets the subprocess inherit process.env,
        // which is where systemd puts CLAUDE_CODE_OAUTH_TOKEN.
        // warn, not debug: the CLI only writes here when something is wrong
        // (API retries, auth trouble), and that must be visible in production
        // logs (issue #39).
        stderr: (data: string) => this.logger.warn({ src: 'claude-cli' }, data.trim()),
      },
    });
  }

  async runTurn(text: string, events: TurnEvents): Promise<TurnOutcome> {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });

    let sawText = false;
    while (true) {
      const { value: message, done } = await this.session.next();
      if (done === true || message === undefined) {
        this.releaseGates();
        return { status: 'process_ended' };
      }
      if (message.type === 'system' && message.subtype === 'init') {
        events.onSessionId(message.session_id);
      } else if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
        const event = message.event;
        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'text' &&
          sawText
        ) {
          // Blank line between the text blocks of a multi-step turn, so tool
          // rounds don't smear into one paragraph.
          events.onDelta('\n\n');
        } else if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          sawText = true;
          events.onDelta(event.delta.text);
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          return {
            status: 'success',
            resultText: message.result,
            costUsd: this.costMeter.turnCost(message.total_cost_usd),
          };
        }
        // A failed turn's spend is not ledgered (spec §7 counts completed
        // turns) and the meter dies with the dropped process — accepted loss.
        this.releaseGates();
        return {
          status: 'error',
          errors: message.errors.length > 0 ? message.errors : [message.subtype],
        };
      }
      // Everything else (assistant echoes, status, hooks…) is irrelevant to
      // the voice; the deltas above already carry the conversational text.
    }
  }

  /**
   * A dead or dying process can never release a suspended gate, and a
   * stranded gate would swallow the thread's next reply — deny whatever is
   * still pending whenever this process stops being able to answer. Worker
   * slots reserved for delegations this process will never dispatch go back
   * to the pool the same way (issue #19).
   */
  private releaseGates(): void {
    this.gates.cancelThread(this.threadTs);
    this.delegations.abandonThread(this.threadTs);
  }

  async end(): Promise<void> {
    this.releaseGates();
    this.input.end();
    const drained = (async () => {
      while (!(await this.session.next()).done) {
        // discard trailing messages until the subprocess exits
      }
    })();
    // If the timeout wins the race below, this promise is abandoned but still
    // live — a later rejection must not become an unhandledRejection crash.
    drained.catch((error: unknown) =>
      this.logger.debug({ err: error }, 'claude subprocess drain failed after end'),
    );
    const timeout = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), END_DRAIN_TIMEOUT_MS);
      timer.unref();
    });
    if ((await Promise.race([drained, timeout])) === 'timeout') {
      this.logger.warn('claude subprocess did not exit after input close; interrupting');
      await this.session.interrupt().catch(() => undefined);
    }
  }
}

export function createProcessFactory(opts: {
  cwd: string;
  gates: SessionGates;
  allowList: DelegationPolicy;
  delegations: SessionDelegations;
  relay: SessionRelay;
  systemPromptAppend: string;
  logger: Logger;
}): ProcessFactory {
  return ({ resumeSessionId, threadTs }) =>
    new ClaudeProcess({
      resumeSessionId,
      threadTs,
      cwd: opts.cwd,
      gates: opts.gates,
      allowList: opts.allowList,
      delegations: opts.delegations,
      relay: opts.relay,
      systemPromptAppend: opts.systemPromptAppend,
      logger: opts.logger,
    });
}

import {
  query,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from './logger.ts';
import type { ProcessFactory, TurnEvents, TurnOutcome } from './sessions.ts';

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

class ClaudeProcess {
  private readonly input = new Pushable<SDKUserMessage>();
  private readonly session: Query;
  private readonly logger: Logger;

  constructor(opts: { resumeSessionId: string | null; cwd: string; logger: Logger }) {
    this.logger = opts.logger;
    this.session = query({
      prompt: this.input,
      options: {
        ...(opts.resumeSessionId !== null && { resume: opts.resumeSessionId }),
        cwd: opts.cwd,
        // Post-then-edit needs deltas, not just whole assistant messages.
        includePartialMessages: true,
        // No canUseTool yet (that's the spec §7 slice), so 'default' makes the
        // CLI auto-deny anything that would normally prompt — reads still
        // work, nothing dangerous runs from a Slack message.
        permissionMode: 'default',
        // settingSources and env are deliberately NOT set: omitting them keeps
        // CLI-default settings loading (never `--bare`, spec §10 — bare would
        // strip the OAuth token) and lets the subprocess inherit process.env,
        // which is where systemd puts CLAUDE_CODE_OAUTH_TOKEN.
        stderr: (data: string) => this.logger.debug({ src: 'claude-cli' }, data.trim()),
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
          return { status: 'success', resultText: message.result };
        }
        return {
          status: 'error',
          errors: message.errors.length > 0 ? message.errors : [message.subtype],
        };
      }
      // Everything else (assistant echoes, status, hooks…) is irrelevant to
      // the voice; the deltas above already carry the conversational text.
    }
  }

  async end(): Promise<void> {
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

export function createProcessFactory(opts: { cwd: string; logger: Logger }): ProcessFactory {
  return ({ resumeSessionId }) =>
    new ClaudeProcess({ resumeSessionId, cwd: opts.cwd, logger: opts.logger });
}

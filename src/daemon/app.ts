import type { Attachments } from './attachments.ts';
import { classifyEvent, type Guard, type IncomingEvent, type MemoryCommand, type SlackFile } from './filter.ts';
import { forgetLine, memorySettingLine, refusalLine, type ForgetOutcome } from '../kernel/messages.ts';
import type { GateResolver } from './gate.ts';
import type { Logger } from '../kernel/logger.ts';
import type { CloseResult, ReplyResult, SessionTurn } from './sessions.ts';
import { readThreadContext, renderThreadContext, type ThreadContext } from './thread-context.ts';

/**
 * The slice of the Bolt App the router registers on — event subscription,
 * the error hook, and the refusal post. daemon.ts passes the real `App`;
 * app.test.ts a captured fake that invokes the handlers with synthetic
 * events.
 */
export interface SlackApp {
  event(
    name: 'app_mention' | 'message',
    handler: (args: { event: unknown }) => Promise<void>,
  ): void;
  error(handler: (error: Error) => Promise<void>): void;
  client: {
    conversations: {
      replies(args: { channel: string; ts: string; latest: string; inclusive: boolean; limit: number; cursor?: string }): Promise<{
        ok?: boolean;
        error?: string;
        messages?: Array<{ ts?: string; user?: string; text?: string; files?: SlackFile[] }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      }>;
    };
    chat: {
      postMessage(args: {
        channel: string;
        thread_ts: string;
        text: string;
      }): Promise<unknown>;
    };
  };
}

/** The slice of SessionManager the event handlers drive. */
export interface SessionGateway {
  status(threadTs: string, channelId: string): 'open' | 'closed' | 'unregistered';
  open(threadTs: string, channelId: string, rootUser: string, turn: SessionTurn): void;
  reply(threadTs: string, channelId: string, turn: SessionTurn): ReplyResult;
  close(threadTs: string, channelId: string): CloseResult;
}

/** Resolves `<@U…>` ids to names before a turn reaches Claude (user-names.ts). */
export interface MentionNames {
  render(text: string): Promise<string>;
}

/**
 * The slice of the memory keeper this router drives (issue #120). Reading
 * belongs to the harness on both paths: at spawn the portraits ride in the
 * system prompt, and a person who first speaks mid-flight gets theirs here,
 * in that turn's text — ending the process to refresh the prompt would deny
 * a pending 🚦 gate and release reserved worker slots (ADR 0009).
 */
export interface ThreadMemory {
  /** Records the speaker; returns their portrait iff they are a latecomer. */
  noteSpeaker(threadTs: string, channelId: string, userId: string): string;
  forget(userId: string, memoryId: string): ForgetOutcome;
  optOut(userId: string): number;
  optIn(userId: string): void;
  readonly enabled: boolean;
}

/** The slice of the gate relay the reply path decorates turns through (#21). */
export interface ReplyDecorator {
  /** Prepends the thread's relayed-gates registry; a no-op without gates. */
  decorateReply(threadTs: string, channelId: string, text: string): string;
}

const REPLY_LOG_LINES: Record<ReplyResult, string> = {
  turn: 'thread reply — resuming session',
  closed: 'reply in closed thread — reminder handled',
  unregistered: 'reply in unregistered thread ignored',
};

const CLOSE_LOG_LINES: Record<CloseResult, string> = {
  closing: 'close command — closing session',
  closed: 'close in already-closed thread — reminder handled',
  unregistered: 'close in unregistered thread ignored',
};

/**
 * Routes every subscribed event through the filter: `app_mention`, plus the
 * message event of whichever channel type is pinned — `message.groups` for a
 * private channel, `message.channels` for a public one (#38). Both arrive as
 * `type: "message"`, so one listener covers either.
 */
export function registerHandlers(
  app: SlackApp,
  guard: Guard,
  sessions: SessionGateway,
  gates: GateResolver,
  relay: ReplyDecorator,
  logger: Logger,
  attachments?: Attachments,
  names?: MentionNames,
  memory?: ThreadMemory,
): void {
  const handle = async ({ event }: { event: unknown }): Promise<void> => {
    // Slack's payload types for `message` are a union over subtypes, so field
    // access is awkward; the filter reads this flat envelope and tolerates
    // whatever fields are absent.
    const incoming = event as IncomingEvent;
    const decision = classifyEvent(incoming, guard);

    const prepare = async (text: string, userId: string, files = incoming.files, context?: ThreadContext): Promise<SessionTurn> => {
      // Who spoke is recorded before anything else in the turn: it decides
      // whose portraits the NEXT spawn injects, and a latecomer's portrait
      // rides in this turn's text because this turn may already be warm.
      const portrait = memory?.noteSpeaker(incoming.thread_ts ?? incoming.ts, incoming.channel!, userId) ?? '';
      // Authorship and addressing survive batching: people may be talking to
      // each other, and their messages must not look like one unnamed user.
      // Resolve the author in the same pass as mentions, context and images.
      const named = async (turn: SessionTurn): Promise<SessionTurn> => {
        // The author travels with the turn, not just inside its text: a
        // batch carries several, and the memory keeper binds a deletion
        // asked for during the turn to exactly the people who wrote it.
        if (turn.text.trim() === '' && turn.images.length === 0) return { ...turn, author: userId };
        const text = `${portrait}[Slack message from <@${userId}>; bot explicitly mentioned: ${incoming.type === 'app_mention' ? 'yes' : 'no'}]\n${turn.text}`;
        return { ...turn, author: userId, text: names ? await names.render(text) : text };
      };
      if (!attachments) return named({ text: renderThreadContext(context) + text, images: [] });
      const threadTs = incoming.thread_ts ?? incoming.ts;
      const channelId = incoming.channel!;
      const turn = await attachments.prepare(threadTs, channelId, userId, text, files, context);
      // A close already in the session FIFO can finish during this download.
      // Closed is final: its cleanup must not be undone by a late write.
      if (sessions.status(threadTs, channelId) === 'closed') await attachments.remove(threadTs, channelId);
      return named(turn);
    };

    switch (decision.action) {
      case 'ignore':
        logger.debug(
          { type: incoming.type, ts: incoming.ts, reason: decision.reason },
          'event ignored',
        );
        return;
      case 'refuse':
        logger.info({ ts: incoming.ts, user: incoming.user }, 'third-party mention refused');
        await app.client.chat.postMessage({
          channel: decision.channelId,
          thread_ts: decision.threadTs,
          text: refusalLine(),
        });
        return;
      case 'open':
        if (sessions.status(decision.threadTs, decision.channelId) === 'closed') {
          sessions.open(decision.threadTs, decision.channelId, decision.userId, { text: decision.text, images: [] });
          return;
        }
        logger.info(
          { threadTs: decision.threadTs, channelId: decision.channelId },
          'root mention — opening session',
        );
        sessions.open(decision.threadTs, decision.channelId, decision.userId, await prepare(decision.text, decision.userId, decision.files));
        return;
      case 'reply': {
        // A bare re-mention in an existing thread remains an empty no-op.
        // Only an unknown thread receives the "handle this thread" instruction.
        const turn = { text: decision.text, images: [] } as SessionTurn;
        // A pending 🚦 gate eats the reply (spec §7): it resolves the
        // suspended tool call instead of becoming a new session turn. The
        // filter already guarantees only the authorized user gets here;
        // tryResolve re-checks the user as defense in depth.
        if (
          incoming.user !== undefined &&
          gates.tryResolve(decision.threadTs, decision.channelId, incoming.user, decision.text)
        ) {
          logger.info({ threadTs: decision.threadTs }, 'thread reply resolved a pending 🚦 gate');
          return;
        }
        if (sessions.status(decision.threadTs, decision.channelId) === 'open') {
          Object.assign(turn, await prepare(decision.text, decision.userId, decision.files));
        }
        // A thread that relayed worker gates carries its registry into the
        // turn (spec §6): the session routes the reply anchored on it.
        const result = sessions.reply(
          decision.threadTs,
          decision.channelId,
          { ...turn, text: relay.decorateReply(decision.threadTs, decision.channelId, turn.text) },
        );
        if (result === 'unregistered' && decision.mentioned) {
          let context: ThreadContext | undefined;
          try {
            context = await readThreadContext(app.client.conversations, decision.channelId, decision.threadTs, incoming.ts, guard.botUserId);
          } catch (error) {
            logger.warn({ err: error, threadTs: decision.threadTs }, 'earlier thread messages could not be read');
            // Open even if posting the notice also fails.
            await app.client.chat.postMessage({
              channel: decision.channelId,
              thread_ts: decision.threadTs,
              text: '⚠️ Earlier messages could not be read; continuing with your mention alone.',
            }).catch((err: unknown) => logger.warn({ err }, 'thread context notice failed'));
          }
          sessions.open(decision.threadTs, decision.channelId, decision.userId,
            await prepare(decision.text || (decision.files?.length ? '' : 'Handle this thread.'), decision.userId, decision.files, context));
        }
        // Fixed-line posts are user-visible events (info); the rest is
        // ambient routing (debug).
        if (result === 'closed') {
          logger.info({ threadTs: decision.threadTs, result }, REPLY_LOG_LINES[result]);
        } else {
          logger.debug({ threadTs: decision.threadTs, result }, REPLY_LOG_LINES[result]);
        }
        return;
      }
      case 'memory': {
        // Deterministic and model-free, beside the bare `close` word: a wrong
        // memory must be removable exactly when the session is confused about
        // what it remembers.
        const text = memoryReply(decision.command, decision.userId);
        logger.info(
          { threadTs: decision.threadTs, userId: decision.userId, command: decision.command.kind },
          'bare memory command',
        );
        await app.client.chat.postMessage({
          channel: decision.channelId,
          thread_ts: decision.threadTs,
          text,
        });
        return;
      }
      case 'close': {
        // "@orchestrator close" while a 🚦 gate is pending denies the gate
        // first (the word travels back verbatim), so the suspended turn can
        // wrap up before the queued close runs — never a mid-turn kill.
        if (
          incoming.user !== undefined &&
          gates.tryResolve(decision.threadTs, decision.channelId, incoming.user, 'close')
        ) {
          logger.info({ threadTs: decision.threadTs }, 'close command denied a pending 🚦 gate');
        }
        const result = sessions.close(decision.threadTs, decision.channelId);
        if (result === 'unregistered') {
          logger.debug({ threadTs: decision.threadTs, result }, CLOSE_LOG_LINES[result]);
        } else {
          logger.info({ threadTs: decision.threadTs, result }, CLOSE_LOG_LINES[result]);
        }
        return;
      }
    }
  };

  /** The fixed answer to a bare memory command — never prose, never a voice. */
  const memoryReply = (command: MemoryCommand, userId: string): string => {
    const keeper = memory?.enabled === true ? memory : undefined;
    if (keeper === undefined) {
      return command.kind === 'forget'
        ? forgetLine('disabled', command.memoryId)
        : memorySettingLine('disabled');
    }
    if (command.kind === 'forget') return forgetLine(keeper.forget(userId, command.memoryId), command.memoryId);
    if (command.kind === 'forget_me') return memorySettingLine('forget_me', keeper.optOut(userId));
    keeper.optIn(userId);
    return memorySettingLine('remember_me');
  };

  // Thread reads are async; queue same-thread events so a second mention or
  // reply cannot overtake the opener before the session is registered.
  const pending = new Map<string, Promise<void>>();
  const ordered = (args: { event: unknown }): Promise<void> => {
    const event = args.event as IncomingEvent;
    const key = `${event.channel}:${event.thread_ts ?? event.ts}`;
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => handle(args));
    pending.set(key, next);
    void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => undefined);
    return next;
  };
  app.event('app_mention', ordered);
  app.event('message', ordered);
  app.error((error) => {
    logger.error({ err: error }, 'unhandled Bolt error');
    return Promise.resolve();
  });
}

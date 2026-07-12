import { describe, expect, it } from 'vitest';
import { classifyEvent } from './filter.ts';

const guard = {
  channelIds: ['C0EXAMPLE123', 'C0EXAMPLE789'],
  allowedUserIds: ['U0EXAMPLE456', 'U0EXAMPLE999'],
  botUserId: 'U0EXAMPLEBOT',
};

const mention = {
  type: 'app_mention' as const,
  channel: 'C0EXAMPLE123',
  user: 'U0EXAMPLE456',
  ts: '1751970000.000100',
  text: '<@U0EXAMPLEBOT> deploy the fix',
};

const threadReply = {
  type: 'message' as const,
  channel: 'C0EXAMPLE123',
  user: 'U0EXAMPLE456',
  ts: '1751970002.000300',
  thread_ts: '1751970000.000100',
  text: 'yes, go ahead',
};

describe('classifyEvent', () => {
  it('opens a session on a root @mention from the authorized user, mention stripped', () => {
    expect(classifyEvent(mention, guard)).toEqual({
      action: 'open',
      threadTs: '1751970000.000100',
      text: 'deploy the fix',
    });
  });

  it('accepts every configured channel and authorized user', () => {
    expect(
      classifyEvent(
        { ...mention, channel: 'C0EXAMPLE789', user: 'U0EXAMPLE999' },
        guard,
      ).action,
    ).toBe('open');
  });

  it('treats a mention inside a thread as a reply, not a new session (spec §3: open = root only)', () => {
    const inThread = { ...mention, thread_ts: '1751960000.000001' };

    expect(classifyEvent(inThread, guard)).toEqual({
      action: 'reply',
      threadTs: '1751960000.000001',
      text: 'deploy the fix',
    });
  });

  it('treats a plain thread reply from the authorized user as a reply — no re-mention needed', () => {
    expect(classifyEvent(threadReply, guard)).toEqual({
      action: 'reply',
      threadTs: '1751970000.000100',
      text: 'yes, go ahead',
    });
  });

  it('refuses a root app_mention from any other user', () => {
    const thirdParty = { ...mention, user: 'U0THIRDPARTY' };

    expect(classifyEvent(thirdParty, guard)).toEqual({
      action: 'refuse',
      threadTs: '1751970000.000100',
    });
  });

  it('stays silent on a third-party mention inside an existing thread (spec §7: never injected, never answered)', () => {
    const thirdPartyInThread = {
      ...mention,
      user: 'U0THIRDPARTY',
      thread_ts: '1751960000.000001',
    };

    expect(classifyEvent(thirdPartyInThread, guard)).toEqual({
      action: 'ignore',
      reason: 'third_party_in_thread',
    });
  });

  it('skips the message.channels copy of a mention — the app_mention event already carries it', () => {
    const messageCopy = {
      ...threadReply,
      text: '<@U0EXAMPLEBOT> deploy the fix',
    };

    expect(classifyEvent(messageCopy, guard)).toEqual({
      action: 'ignore',
      reason: 'mention_duplicate',
    });
  });

  it.each([
    [
      'a mention in another channel',
      { ...mention, channel: 'C0OTHERCHAN' },
      'wrong_channel',
    ],
    [
      'an event with no channel',
      { ...mention, channel: undefined },
      'wrong_channel',
    ],
    [
      'a subtype event, even from the authorized user',
      { ...threadReply, subtype: 'message_changed' },
      'subtype',
    ],
    [
      'a message from any bot',
      { ...threadReply, bot_id: 'B0SOMEBOT', user: undefined },
      'bot_message',
    ],
    [
      "the bot's own message",
      { ...threadReply, user: 'U0EXAMPLEBOT' },
      'self',
    ],
    [
      'an event with no user',
      { ...threadReply, user: undefined },
      'no_user',
    ],
    [
      'a root channel message without a mention, even from the authorized user',
      { ...threadReply, thread_ts: undefined },
      'not_a_mention',
    ],
    [
      'a third-party reply in a thread — silence, not a refusal',
      { ...threadReply, user: 'U0THIRDPARTY' },
      'third_party_in_thread',
    ],
    [
      'an in-thread mention that carries no content once the tag is stripped',
      { ...mention, thread_ts: '1751960000.000001', text: '<@U0EXAMPLEBOT>  ' },
      'empty_text',
    ],
    [
      'a thread reply with no text (e.g. attachment-only) — no empty turn injected',
      { ...threadReply, text: undefined },
      'empty_text',
    ],
    [
      'a thread reply that is only whitespace',
      { ...threadReply, text: '   ' },
      'empty_text',
    ],
  ])('ignores %s', (_label, event, reason) => {
    expect(classifyEvent(event, guard)).toEqual({ action: 'ignore', reason });
  });

  it('recognizes "@orchestrator close" in a thread as the explicit close command (spec §3)', () => {
    const closeCommand = {
      ...mention,
      thread_ts: '1751960000.000001',
      text: '<@U0EXAMPLEBOT> close',
    };

    expect(classifyEvent(closeCommand, guard)).toEqual({
      action: 'close',
      threadTs: '1751960000.000001',
    });
  });

  it.each([['Close'], ['CLOSE'], ['close.'], ['close!']])(
    'normalizes "%s" to the close command',
    (variant) => {
      const closeCommand = {
        ...mention,
        thread_ts: '1751960000.000001',
        text: `<@U0EXAMPLEBOT> ${variant}`,
      };

      expect(classifyEvent(closeCommand, guard).action).toBe('close');
    },
  );

  it('a mention-less "close" reply in a thread is the close command too (#38 landed)', () => {
    expect(classifyEvent({ ...threadReply, text: 'close' }, guard)).toEqual({
      action: 'close',
      threadTs: '1751970000.000100',
    });
  });

  it.each([['Close'], ['CLOSE'], ['close.'], ['close!'], ['  close  ']])(
    'normalizes the mention-less "%s" reply to the close command',
    (variant) => {
      expect(classifyEvent({ ...threadReply, text: variant }, guard).action).toBe('close');
    },
  );

  it('a mention-less "close" at the channel root still opens nothing (spec §3)', () => {
    expect(classifyEvent({ ...threadReply, thread_ts: undefined, text: 'close' }, guard)).toEqual({
      action: 'ignore',
      reason: 'not_a_mention',
    });
  });

  it('a third party cannot close the thread with a bare "close"', () => {
    expect(classifyEvent({ ...threadReply, user: 'U0INTRUDER', text: 'close' }, guard)).toEqual({
      action: 'ignore',
      reason: 'third_party_in_thread',
    });
  });

  it('a mention-less sentence containing "close" stays a reply', () => {
    expect(classifyEvent({ ...threadReply, text: 'close the PR when CI is green' }, guard)).toEqual({
      action: 'reply',
      threadTs: '1751970000.000100',
      text: 'close the PR when CI is green',
    });
  });

  it('a longer sentence mentioning close stays a reply for the session to interpret', () => {
    const sentence = {
      ...mention,
      thread_ts: '1751960000.000001',
      text: '<@U0EXAMPLEBOT> close it once the PR merges',
    };

    expect(classifyEvent(sentence, guard).action).toBe('reply');
  });

  it('a root "@orchestrator close" mention opens a session — close is a thread command', () => {
    expect(classifyEvent({ ...mention, text: '<@U0EXAMPLEBOT> close' }, guard).action).toBe(
      'open',
    );
  });

  it('a third-party "@orchestrator close" in a thread stays silence, never a close', () => {
    const thirdParty = {
      ...mention,
      user: 'U0THIRDPARTY',
      thread_ts: '1751960000.000001',
      text: '<@U0EXAMPLEBOT> close',
    };

    expect(classifyEvent(thirdParty, guard)).toEqual({
      action: 'ignore',
      reason: 'third_party_in_thread',
    });
  });

  it('a bare root mention still opens the session — the mention IS the open (spec §3)', () => {
    const bare = { ...mention, text: '<@U0EXAMPLEBOT>' };

    const decision = classifyEvent(bare, guard);

    expect(decision.action).toBe('open');
    expect(decision).toHaveProperty('threadTs', '1751970000.000100');
    // The turn needs *some* prompt; the filter substitutes a fixed one that
    // tells the session what happened instead of inventing user words.
    expect((decision as { text: string }).text).not.toBe('');
  });
});

describe('humanText via blocks (issue #41 — client context-block footers)', () => {
  // The claude.ai Slack MCP (and similar clients) append "*Sent with* @App"
  // as a `context` block; its text also leaks into event.text. Commands and
  // turn text must come from the rich_text block alone.
  const footerBlocks = (words: { user?: string; text: string }[]) => [
    {
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: words.map((w) =>
            w.user !== undefined
              ? { type: 'user', user_id: w.user }
              : { type: 'text', text: w.text },
          ),
        },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '*Envoyé avec* <@U0EXAMPLE789>' }],
    },
  ];

  it('close command still matches when a context footer pollutes event.text', () => {
    const event = {
      type: 'app_mention' as const,
      channel: 'C0EXAMPLE123',
      user: 'U0EXAMPLE456',
      ts: '1751970003.000400',
      thread_ts: '1751970000.000100',
      text: '<@U0EXAMPLEBOT> close *Envoyé avec* <@U0EXAMPLE789>',
      blocks: footerBlocks([
        { user: 'U0EXAMPLEBOT', text: '' },
        { text: ' close' },
      ]),
    };

    expect(classifyEvent(event, guard)).toEqual({
      action: 'close',
      threadTs: '1751970000.000100',
    });
  });

  it('strips the footer from reply text handed to the session', () => {
    const event = {
      ...threadReply,
      text: 'yes, go ahead *Envoyé avec* <@U0EXAMPLE789>',
      blocks: footerBlocks([{ text: 'yes, go ahead' }]),
    };

    expect(classifyEvent(event, guard)).toEqual({
      action: 'reply',
      threadTs: threadReply.thread_ts,
      text: 'yes, go ahead',
    });
  });

  it('detects the bot mention from the user element in blocks (mention_duplicate)', () => {
    const event = {
      ...threadReply,
      text: 'ignored',
      blocks: footerBlocks([
        { user: 'U0EXAMPLEBOT', text: '' },
        { text: ' hello' },
      ]),
    };

    expect(classifyEvent(event, guard)).toEqual({
      action: 'ignore',
      reason: 'mention_duplicate',
    });
  });

  it('falls back to event.text when no rich_text block exists (plain API posts)', () => {
    expect(classifyEvent(threadReply, guard)).toEqual({
      action: 'reply',
      threadTs: threadReply.thread_ts,
      text: 'yes, go ahead',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { classifyEvent } from './filter.ts';

const guard = {
  channelId: 'C0ASJR3LAE6',
  allowedUserId: 'U09CC6M3W1W',
  botUserId: 'U0BGRT64CPJ',
};

const mention = {
  type: 'app_mention' as const,
  channel: 'C0ASJR3LAE6',
  user: 'U09CC6M3W1W',
  ts: '1751970000.000100',
};

describe('classifyEvent', () => {
  it('acks an app_mention from the authorized user, threaded on the mention', () => {
    expect(classifyEvent(mention, guard)).toEqual({
      action: 'ack',
      threadTs: '1751970000.000100',
    });
  });

  it('acks inside the existing thread when the mention is itself a thread reply', () => {
    const inThread = { ...mention, thread_ts: '1751960000.000001' };

    expect(classifyEvent(inThread, guard)).toEqual({
      action: 'ack',
      threadTs: '1751960000.000001',
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
      { ...mention, subtype: 'message_changed' },
      'subtype',
    ],
    [
      'a message from any bot',
      { ...mention, type: 'message' as const, bot_id: 'B0SOMEBOT', user: undefined },
      'bot_message',
    ],
    [
      "the bot's own message",
      { ...mention, user: 'U0BGRT64CPJ' },
      'self',
    ],
    [
      'an event with no user',
      { ...mention, user: undefined },
      'no_user',
    ],
    [
      'a plain channel message without a mention, even from the authorized user',
      { ...mention, type: 'message' as const },
      'not_a_mention',
    ],
    [
      'a third-party reply in a thread — silence, not a refusal',
      {
        type: 'message' as const,
        channel: 'C0ASJR3LAE6',
        user: 'U0THIRDPARTY',
        ts: '1751970002.000300',
        thread_ts: '1751970000.000100',
      },
      'not_a_mention',
    ],
  ])('ignores %s', (_label, event, reason) => {
    expect(classifyEvent(event, guard)).toEqual({ action: 'ignore', reason });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Voice, type VoiceTransport } from './voice.ts';

interface Call {
  kind: 'post' | 'update';
  ts?: string;
  text: string;
}

const makeTransport = (): { transport: VoiceTransport; calls: Call[] } => {
  const calls: Call[] = [];
  let nextTs = 1;
  return {
    calls,
    transport: {
      post: (text) => {
        calls.push({ kind: 'post', text });
        return Promise.resolve(`ts-${nextTs++}`);
      },
      update: (ts, text) => {
        calls.push({ kind: 'update', ts, text });
        return Promise.resolve();
      },
    },
  };
};

describe('Voice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts a new message on the first delta — post, then edit', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport);

    voice.append('Hel');
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toEqual([{ kind: 'post', text: 'Hel' }]);
  });

  it('coalesces deltas inside the throttle window into a single edit', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport, { editIntervalMs: 1000 });

    voice.append('Hel');
    await vi.advanceTimersByTimeAsync(0);
    voice.append('lo');
    voice.append(' world');
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toEqual([
      { kind: 'post', text: 'Hel' },
      { kind: 'update', ts: 'ts-1', text: 'Hello world' },
    ]);
  });

  it('keeps editing the same message across successive windows — never a message per token', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport, { editIntervalMs: 1000 });

    voice.append('one');
    await vi.advanceTimersByTimeAsync(0);
    voice.append(' two');
    await vi.advanceTimersByTimeAsync(1000);
    voice.append(' three');
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toEqual([
      { kind: 'post', text: 'one' },
      { kind: 'update', ts: 'ts-1', text: 'one two' },
      { kind: 'update', ts: 'ts-1', text: 'one two three' },
    ]);
  });

  it('finalize flushes the tail without waiting for the next window', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport, { editIntervalMs: 1000 });

    voice.append('almost');
    await vi.advanceTimersByTimeAsync(0);
    voice.append(' done');
    await voice.finalize();

    expect(calls).toEqual([
      { kind: 'post', text: 'almost' },
      { kind: 'update', ts: 'ts-1', text: 'almost done' },
    ]);
  });

  it('finalize posts the fallback when the turn streamed no text at all', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport);

    await voice.finalize('(done — no reply text)');

    expect(calls).toEqual([{ kind: 'post', text: '(done — no reply text)' }]);
  });

  it('finalize with nothing to say posts nothing', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport);

    await voice.finalize();

    expect(calls).toEqual([]);
  });

  it('caps the message at maxLength so a huge turn cannot break chat.update', async () => {
    const { transport, calls } = makeTransport();
    const voice = new Voice(transport, { maxLength: 10 });

    voice.append('0123456789ABCDEF');
    await voice.finalize();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe('0123456789\n… [truncated]');
  });

  it('reports transport failures through onError instead of throwing into the turn', async () => {
    const errors: unknown[] = [];
    const voice = new Voice(
      {
        post: () => Promise.reject(new Error('slack down')),
        update: () => Promise.resolve(),
      },
      { onError: (err) => errors.push(err) },
    );

    voice.append('hello');
    await expect(voice.finalize()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('slack down');
  });
});

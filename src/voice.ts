/**
 * The "voice" surface (spec §8, UX prototype): a session's conversational
 * output streamed into the thread by post-then-edit — one Slack message per
 * turn, created on the first delta and edited in place at most once per
 * throttle window (Tier-3 friendly, never a message per token).
 */

export interface VoiceTransport {
  /** chat.postMessage into the thread; resolves with the new message's ts. */
  post(text: string): Promise<string>;
  /** chat.update of a previously posted message. */
  update(ts: string, text: string): Promise<void>;
}

export interface VoiceOptions {
  /** Minimum delay between edits (~1 edit/s per spec §8). */
  editIntervalMs?: number;
  /** Cap before Slack's 40k-char message limit rejects the edit. */
  maxLength?: number;
  /** Transport failures land here; the stream itself never throws. */
  onError?: (error: unknown) => void;
}

const TRUNCATION_MARKER = '\n… [truncated]';

export class Voice {
  private readonly transport: VoiceTransport;
  private readonly editIntervalMs: number;
  private readonly maxLength: number;
  private readonly onError: (error: unknown) => void;

  private buffer = '';
  private flushedText = '';
  private messageTs: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private lastFlushAt: number | null = null;
  private finalized = false;

  constructor(transport: VoiceTransport, options: VoiceOptions = {}) {
    this.transport = transport;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.maxLength = options.maxLength ?? 39_000;
    this.onError = options.onError ?? (() => undefined);
  }

  append(delta: string): void {
    this.buffer += delta;
    this.scheduleFlush();
  }

  /**
   * Flush whatever is left and stop the throttle. When the turn produced no
   * streamed text at all, `fallback` (if given) becomes the whole message.
   */
  async finalize(fallback?: string): Promise<void> {
    // From here on the throttle never re-arms — an in-flight flush completing
    // below would otherwise schedule one last pointless timer.
    this.finalized = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer === '' && fallback !== undefined) {
      this.buffer = fallback;
    }
    while (this.inflight !== null) {
      await this.inflight;
    }
    while (this.buffer !== '' && this.render() !== this.flushedText) {
      await this.flush();
    }
  }

  private render(): string {
    if (this.buffer.length <= this.maxLength) return this.buffer;
    return this.buffer.slice(0, this.maxLength) + TRUNCATION_MARKER;
  }

  private scheduleFlush(): void {
    if (this.finalized || this.timer !== null || this.inflight !== null) return;
    const sinceLast = this.lastFlushAt === null ? Infinity : Date.now() - this.lastFlushAt;
    const delay = Math.max(0, this.editIntervalMs - sinceLast);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inflight = this.flush().finally(() => {
        this.inflight = null;
        if (this.render() !== this.flushedText) this.scheduleFlush();
      });
    }, delay);
  }

  private async flush(): Promise<void> {
    const text = this.render();
    try {
      if (this.messageTs === null) {
        this.messageTs = await this.transport.post(text);
      } else if (text !== this.flushedText) {
        await this.transport.update(this.messageTs, text);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      // Even a failed flush counts as flushed: a retry storm against a down
      // Slack API helps nobody, and the next delta triggers a fresh attempt.
      this.flushedText = text;
      this.lastFlushAt = Date.now();
    }
  }
}

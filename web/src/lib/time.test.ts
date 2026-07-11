import { describe, expect, it } from 'vitest';
import { ago, clockTime, durationSince, formatDuration } from './time';

describe('formatDuration', () => {
  it('rounds down to the coarsest two units', () => {
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(3 * 24 * 3_600_000 + 2 * 3_600_000)).toBe('3d 2h');
  });
});

describe('ago / durationSince', () => {
  it('measures against the snapshot asOf, clamped at zero', () => {
    expect(ago('2026-07-11T11:58:00.000Z', '2026-07-11T12:00:00.000Z')).toBe('2m ago');
    expect(durationSince('2026-07-11T12:05:00.000Z', '2026-07-11T12:00:00.000Z')).toBe('<1m');
  });
});

describe('clockTime', () => {
  it('renders a zero-padded 24h wall clock', () => {
    // Built from local components, so the expectation holds in any zone.
    const nineFive = new Date(2026, 6, 11, 9, 5, 3);
    expect(clockTime(nineFive.toISOString())).toBe('09:05:03');
    const lateEvening = new Date(2026, 6, 11, 23, 59, 59);
    expect(clockTime(lateEvening.toISOString())).toBe('23:59:59');
  });
});

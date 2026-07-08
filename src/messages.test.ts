import { describe, expect, it } from 'vitest';
import { costWarningLine, refusalLine } from './messages.ts';

describe('refusalLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, scenario G1)', () => {
    expect(refusalLine('U09CC6M3W1W')).toBe(
      'v1: only <@U09CC6M3W1W> can drive me.',
    );
  });
});

describe('costWarningLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, scenario D)', () => {
    expect(costWarningLine(5.03, 5, 10)).toBe(
      '💸 This thread has cost *$5.03* ($5 threshold crossed) — info only, nothing is blocked.\n' +
        'Next warning at $10.',
    );
  });

  it('drops the "next warning" line after the last threshold', () => {
    expect(costWarningLine(10.47, 10)).toBe(
      '💸 This thread has cost *$10.47* ($10 threshold crossed) — info only, nothing is blocked.',
    );
  });

  it('always shows the total with two decimals', () => {
    expect(costWarningLine(5, 5, 10)).toContain('*$5.00*');
  });
});

import { describe, expect, it } from 'vitest';
import { refusalLine } from './messages.ts';

describe('refusalLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, scenario G1)', () => {
    expect(refusalLine('U09CC6M3W1W')).toBe(
      'v1: only <@U09CC6M3W1W> can drive me.',
    );
  });
});

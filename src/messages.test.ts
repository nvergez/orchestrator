import { describe, expect, it } from 'vitest';
import {
  costWarningLine,
  delegationGateLine,
  gateLine,
  refusalLine,
  zeroMatchLine,
} from './messages.ts';

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

describe('gateLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, scenario B)', () => {
    expect(gateLine('git push --force-with-lease', 'forwardly/csv-export-metrics')).toBe(
      '🚦 `git push --force-with-lease` on `forwardly/csv-export-metrics` — go?',
    );
  });

  it('matches the mock verbatim when no worktree is identifiable', () => {
    expect(gateLine('orca worktree delete forwardly-84-csv-export')).toBe(
      '🚦 `orca worktree delete forwardly-84-csv-export` — go?',
    );
  });
});

describe('delegationGateLine', () => {
  it('matches the issue #10 verbatim, in Slack mrkdwn', () => {
    expect(delegationGateLine('forwardly', 'claude')).toBe(
      "→ I'm delegating on *forwardly* with *claude*. Go? (or name another repo/agent)",
    );
  });
});

describe('zeroMatchLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, "Zero match")', () => {
    expect(zeroMatchLine(['forwardly', 'orca', 'scratch', 'orchestrator'])).toBe(
      'No repo I drive matches. I know: `forwardly`, `orca`, `scratch`, ' +
        '`orchestrator`. Rephrase targeting one of them.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLOSED_THREAD_LINE,
  closingSummary,
  costWarningLine,
  delegationGateLine,
  gateLine,
  queuedLine,
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

describe('queuedLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, scenario F′)', () => {
    expect(queuedLine(5)).toBe(
      "⏳ Queued (5 active sessions) — I'll get to it as soon as a slot frees up.",
    );
  });

  it('goes singular for a cap of one', () => {
    expect(queuedLine(1)).toContain('(1 active session)');
  });
});

describe('CLOSED_THREAD_LINE', () => {
  it('matches the fixed verbatim from #5 (docs/prototypes/slack-ux, brief moments)', () => {
    expect(CLOSED_THREAD_LINE).toBe(
      'Session closed. Mention me on a new root message to start again.',
    );
  });
});

describe('closingSummary', () => {
  it('follows the UX mock shape (docs/prototypes/slack-ux, explicit close)', () => {
    expect(closingSummary({ delegations: 0, costUsd: 6.84, turnCount: 19 })).toBe(
      '🔚 Session closed.\n' +
        '• 0 delegations\n' +
        '• thread cost: $6.84 · 19 turns\n' +
        'Mention me on a new root message to start again.',
    );
  });

  it('goes singular for one delegation and one turn', () => {
    const summary = closingSummary({ delegations: 1, costUsd: 0.5, turnCount: 1 });

    expect(summary).toContain('• 1 delegation\n');
    expect(summary).toContain('· 1 turn\n');
  });

  it('names the dormancy span when the auto-close sweep is the closer', () => {
    const summary = closingSummary({
      delegations: 0,
      costUsd: 2.1,
      turnCount: 4,
      dormantDays: 7,
    });

    expect(summary).toContain('🔚 Session closed — dormant for 7 days.');
  });

  it('always shows the cost with two decimals', () => {
    expect(closingSummary({ delegations: 0, costUsd: 5, turnCount: 2 })).toContain('$5.00');
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

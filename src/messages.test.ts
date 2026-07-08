import { describe, expect, it } from 'vitest';
import {
  CLOSED_THREAD_LINE,
  closingSummary,
  completedCard,
  costWarningLine,
  crudeWorkerEventLine,
  delegationCard,
  delegationGateLine,
  extractPullRequestLinks,
  formatDuration,
  gateLine,
  milestoneLine,
  orcaUnavailableLine,
  queuedLine,
  refusalLine,
  workerCapLine,
  workerDoneFallbackLine,
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

describe('delegationCard — scenario A (issue #19)', () => {
  it('renders the ⚙️ card with a rich GitHub issue link and code-formatted worktree', () => {
    expect(
      delegationCard({
        repo: 'forwardly',
        issueNumber: 84,
        title: 'CSV export of send metrics',
        worktreeName: 'forwardly-84-csv-export',
        agent: 'claude',
        issueUrl: 'https://github.com/lemlist/forwardly/issues/84',
        milestones: [
          '• 14:04 — issue linked, worktree ready',
          '• 14:05 — brief handed off (task `t-3f81`)',
        ],
      }),
    ).toBe(
      '⚙️ *forwardly#84 — CSV export of send metrics*\n' +
        '`forwardly-84-csv-export` · claude · issue ' +
        '<https://github.com/lemlist/forwardly/issues/84|forwardly#84>\n' +
        '• 14:04 — issue linked, worktree ready\n' +
        '• 14:05 — brief handed off (task `t-3f81`)',
    );
  });

  it('degrades to plain repo#n when the repo has no GitHub issue URL', () => {
    const card = delegationCard({
      repo: 'scratch',
      issueNumber: 21,
      title: 'bench',
      worktreeName: 'scratch-21-bench',
      agent: 'claude',
      milestones: ['• 16:20 — issue linked, worktree ready'],
    });

    expect(card).toContain('issue scratch#21');
    expect(card).not.toContain('<');
  });
});

describe('milestoneLine', () => {
  it('renders the bullet-time-dash shape of the mock', () => {
    expect(milestoneLine('14:04', 'worktree ready')).toBe('• 14:04 — worktree ready');
  });
});

describe('workerCapLine', () => {
  it('announces the wave wait with the in-flight count', () => {
    expect(workerCapLine(3)).toBe(
      '⏳ Worker cap reached (3 workers in flight) — this delegation waits for a free slot.',
    );
  });

  it('says "worker", singular, for one', () => {
    expect(workerCapLine(1)).toContain('(1 worker in flight)');
  });
});

describe('orcaUnavailableLine', () => {
  it('prefixes the ⚠️ and carries the detail', () => {
    expect(orcaUnavailableLine('nothing was dispatched.')).toBe(
      '⚠️ Orca runtime unavailable — nothing was dispatched.',
    );
  });
});

describe('completedCard — the ✅/❌ final state (issue #20)', () => {
  const base = {
    repo: 'forwardly',
    issueNumber: 84,
    title: 'CSV export of send metrics',
    worktreePath: '/home/dev/orca/workspaces/forwardly/forwardly-84-csv-export',
    durationMs: 27 * 60_000,
    issueUrl: 'https://github.com/lemlist/forwardly/issues/84',
    prLinks: [{ url: 'https://github.com/lemlist/forwardly/pull/87', label: 'forwardly#87' }],
  };

  it('renders the mock’s delivered card: header, PR, issue, worktree', () => {
    expect(completedCard(base)).toBe(
      [
        '✅ *forwardly#84 — CSV export of send metrics — delivered in 27 min*',
        '• PR: <https://github.com/lemlist/forwardly/pull/87|forwardly#87>',
        '• issue: <https://github.com/lemlist/forwardly/issues/84|forwardly#84>',
        '• worktree: `/home/dev/orca/workspaces/forwardly/forwardly-84-csv-export`',
      ].join('\n'),
    );
  });

  it('renders a failure with the reason first, verbatim', () => {
    const card = completedCard({ ...base, failureReason: 'Failed: e2e tests break on main' });
    expect(card).toContain('❌ *forwardly#84 — CSV export of send metrics — failed after 27 min*');
    expect(card.split('\n')[1]).toBe('• reason: Failed: e2e tests break on main');
  });

  it('degrades gracefully: no PR, no issue URL, no worktree path', () => {
    const card = completedCard({
      ...base,
      issueUrl: undefined,
      prLinks: [],
      worktreePath: null,
    });
    expect(card).toBe(
      [
        '✅ *forwardly#84 — CSV export of send metrics — delivered in 27 min*',
        '• issue: forwardly#84',
      ].join('\n'),
    );
  });
});

describe('workerDoneFallbackLine', () => {
  it('delivers and fails with the subject and the card pointer', () => {
    expect(workerDoneFallbackLine('CSV export shipped', false)).toBe(
      '✅ Delivered — CSV export shipped. Details in the card ⤴',
    );
    expect(workerDoneFallbackLine('Failed: broke', true)).toBe(
      '❌ Failed — Failed: broke. Details in the card ⤴',
    );
  });
});

describe('crudeWorkerEventLine — pre-#21 gate surfacing', () => {
  it('quotes the payload verbatim and names the reply command', () => {
    const line = crudeWorkerEventLine({
      kind: 'decision_gate',
      worktreeName: 'orca-53-lint-ci',
      repo: 'orca',
      issueNumber: 53,
      subject: 'Which lint config?',
      body: 'Two configs coexist.\n1. root\n2. app/',
      msgId: 'msg_1',
    });
    expect(line).toContain('❓ *`orca-53-lint-ci`* (orca#53) asks');
    expect(line).toContain('> Which lint config?');
    expect(line).toContain('> Two configs coexist.');
    expect(line).toContain('> 2. app/');
    expect(line).toContain('`orca orchestration reply --id msg_1 --body "<answer>"`');
  });

  it('marks an escalation 🚨 and survives a row the ledger never matched', () => {
    const line = crudeWorkerEventLine({
      kind: 'escalation',
      worktreeName: null,
      repo: null,
      issueNumber: null,
      subject: 'Blocked: main is broken',
      body: '',
      msgId: 'msg_2',
    });
    expect(line).toContain('🚨 *a worker* escalates');
    expect(line).toContain('> Blocked: main is broken');
  });
});

describe('formatDuration', () => {
  it('rounds to minutes, speaks hours past 60', () => {
    expect(formatDuration(20_000)).toBe('under a minute');
    expect(formatDuration(27 * 60_000)).toBe('27 min');
    expect(formatDuration(60 * 60_000)).toBe('1 h');
    expect(formatDuration(65 * 60_000)).toBe('1 h 05 min');
    expect(formatDuration(125 * 60_000)).toBe('2 h 05 min');
  });
});

describe('extractPullRequestLinks', () => {
  it('finds GitHub PR urls, labels them repo#n, deduplicates in order', () => {
    const text =
      'Opened https://github.com/lemlist/forwardly/pull/87 (see ' +
      'https://github.com/lemlist/forwardly/pull/87) and ' +
      'https://github.com/nvergez/scratch/pull/3.';
    expect(extractPullRequestLinks(text)).toEqual([
      { url: 'https://github.com/lemlist/forwardly/pull/87', label: 'forwardly#87' },
      { url: 'https://github.com/nvergez/scratch/pull/3', label: 'scratch#3' },
    ]);
  });

  it('returns nothing when the report names no PR', () => {
    expect(extractPullRequestLinks('all done, nothing to link')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CLOSED_THREAD_LINE,
  closingSummary,
  completedCard,
  costWarningLine,
  delegationCard,
  delegationGateLine,
  extractPullRequestLinks,
  formatDuration,
  gateAnswerAck,
  gateLine,
  gateRelayMessage,
  inflightWorkerAlert,
  milestoneLine,
  orcaUnavailableLine,
  queuedLine,
  refusalLine,
  restartNotice,
  stalledWorkerAlert,
  workerCapLine,
  workerDoneFallbackLine,
  zeroMatchLine,
} from './messages.ts';

describe('refusalLine', () => {
  it('stays generic — the allow-list is never enumerated to third parties (issue #93)', () => {
    expect(refusalLine()).toBe('Only authorized operators can drive me.');
    expect(refusalLine()).not.toContain('<@');
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
  const delegation = {
    repo: 'webapp',
    issueNumber: 84,
    worktreeName: 'webapp-84-csv-export',
    taskId: 'task_a1b2c3d4e5f6',
    status: 'completed',
  } as const;

  it('names each delegation with its outcome and issue link (issue #51, explicit close mock)', () => {
    const summary = closingSummary({
      delegations: [
        { ...delegation, issueUrl: 'https://github.com/acme/webapp/issues/84' },
        {
          ...delegation,
          issueNumber: 91,
          issueUrl: 'https://github.com/acme/webapp/issues/91',
        },
      ],
      costUsd: 6.84,
      turnCount: 19,
    });

    expect(summary).toBe(
      '🔚 Session closed.\n' +
        '• ✅ <https://github.com/acme/webapp/issues/84|webapp#84>\n' +
        '• ✅ <https://github.com/acme/webapp/issues/91|webapp#91>\n' +
        '• thread cost: $6.84 · 19 turns\n' +
        'Mention me on a new root message to start again.',
    );
  });

  it('marks a failed delegation ❌ and an in-flight one ⚙️ — the card vocabulary', () => {
    const summary = closingSummary({
      delegations: [
        {
          ...delegation,
          status: 'failed',
          issueUrl: 'https://github.com/acme/webapp/issues/84',
        },
        { ...delegation, issueNumber: 91, status: 'dispatched' },
      ],
      costUsd: 1.2,
      turnCount: 3,
    });

    expect(summary).toContain(
      '• ❌ <https://github.com/acme/webapp/issues/84|webapp#84>\n',
    );
    expect(summary).toContain('• ⚙️ webapp#91 — still in flight\n');
  });

  it('degrades to plain repo#n for a folder repo without a remote, like the card', () => {
    const summary = closingSummary({
      delegations: [{ ...delegation }],
      costUsd: 0.5,
      turnCount: 2,
    });

    expect(summary).toContain('• ✅ webapp#84\n');
    expect(summary).not.toContain('<');
  });

  it('falls back to the worktree name, then the task id, when the row never resolved repo#n', () => {
    const summary = closingSummary({
      delegations: [
        { ...delegation, repo: null },
        { ...delegation, repo: null, worktreeName: null },
      ],
      costUsd: 0.5,
      turnCount: 2,
    });

    expect(summary).toContain('• ✅ `webapp-84-csv-export`\n');
    expect(summary).toContain('• ✅ task_a1b2c3d4e5f6\n');
  });

  it('keeps the summary shape when the thread never delegated', () => {
    expect(closingSummary({ delegations: [], costUsd: 6.84, turnCount: 19 })).toBe(
      '🔚 Session closed.\n' +
        '• no delegations\n' +
        '• thread cost: $6.84 · 19 turns\n' +
        'Mention me on a new root message to start again.',
    );
  });

  it('goes singular for one turn', () => {
    const summary = closingSummary({ delegations: [], costUsd: 0.5, turnCount: 1 });

    expect(summary).toContain('· 1 turn\n');
  });

  it('names the dormancy span when the auto-close sweep is the closer', () => {
    const summary = closingSummary({
      delegations: [],
      costUsd: 2.1,
      turnCount: 4,
      dormantDays: 7,
    });

    expect(summary).toContain('🔚 Session closed — dormant for 7 days.');
  });

  it('always shows the cost with two decimals', () => {
    expect(closingSummary({ delegations: [], costUsd: 5, turnCount: 2 })).toContain('$5.00');
  });
});

describe('gateLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, scenario B)', () => {
    expect(gateLine('git push --force-with-lease', 'webapp/csv-export-metrics')).toBe(
      '🚦 `git push --force-with-lease` on `webapp/csv-export-metrics` — go?',
    );
  });

  it('matches the mock verbatim when no worktree is identifiable', () => {
    expect(gateLine('orca worktree delete webapp-84-csv-export')).toBe(
      '🚦 `orca worktree delete webapp-84-csv-export` — go?',
    );
  });
});

describe('delegationGateLine', () => {
  it('matches the issue #10 verbatim, in Slack mrkdwn', () => {
    expect(delegationGateLine('webapp', 'claude')).toBe(
      "→ I'm delegating on *webapp* with *claude*. Go? (or name another repo/agent)",
    );
  });
});

describe('zeroMatchLine', () => {
  it('matches the UX mock verbatim (docs/prototypes/slack-ux, "Zero match")', () => {
    expect(zeroMatchLine(['webapp', 'orca', 'sandbox', 'orchestrator'])).toBe(
      'No repo I drive matches. I know: `webapp`, `orca`, `sandbox`, ' +
        '`orchestrator`. Rephrase targeting one of them.',
    );
  });
});

describe('delegationCard — scenario A (issue #19)', () => {
  it('renders the ⚙️ card with a rich GitHub issue link and code-formatted worktree', () => {
    expect(
      delegationCard({
        repo: 'webapp',
        issueNumber: 84,
        title: 'CSV export of send metrics',
        worktreeName: 'webapp-84-csv-export',
        agent: 'claude',
        issueUrl: 'https://github.com/acme/webapp/issues/84',
        milestones: [
          '• 14:04 — issue linked, worktree ready',
          '• 14:05 — brief handed off (task `t-3f81`)',
        ],
      }),
    ).toBe(
      '⚙️ *webapp#84 — CSV export of send metrics*\n' +
        '`webapp-84-csv-export` · claude · issue ' +
        '<https://github.com/acme/webapp/issues/84|webapp#84>\n' +
        '• 14:04 — issue linked, worktree ready\n' +
        '• 14:05 — brief handed off (task `t-3f81`)',
    );
  });

  it('degrades to plain repo#n when the repo has no GitHub issue URL', () => {
    const card = delegationCard({
      repo: 'sandbox',
      issueNumber: 21,
      title: 'bench',
      worktreeName: 'sandbox-21-bench',
      agent: 'claude',
      milestones: ['• 16:20 — issue linked, worktree ready'],
    });

    expect(card).toContain('issue sandbox#21');
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
    repo: 'webapp',
    issueNumber: 84,
    title: 'CSV export of send metrics',
    worktreePath: '/home/op/orca/workspaces/webapp/webapp-84-csv-export',
    durationMs: 27 * 60_000,
    issueUrl: 'https://github.com/acme/webapp/issues/84',
    prLinks: [{ url: 'https://github.com/acme/webapp/pull/87', label: 'webapp#87' }],
  };

  it('renders the mock’s delivered card: header, PR, issue, worktree', () => {
    expect(completedCard(base)).toBe(
      [
        '✅ *webapp#84 — CSV export of send metrics — delivered in 27 min*',
        '• PR: <https://github.com/acme/webapp/pull/87|webapp#87>',
        '• issue: <https://github.com/acme/webapp/issues/84|webapp#84>',
        '• worktree: `/home/op/orca/workspaces/webapp/webapp-84-csv-export`',
      ].join('\n'),
    );
  });

  it('renders a failure with the reason first, verbatim', () => {
    const card = completedCard({ ...base, failureReason: 'Failed: e2e tests break on main' });
    expect(card).toContain('❌ *webapp#84 — CSV export of send metrics — failed after 27 min*');
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
        '✅ *webapp#84 — CSV export of send metrics — delivered in 27 min*',
        '• issue: webapp#84',
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

describe('gateRelayMessage — scenario C, the relayed worker gate', () => {
  it('renders the mock exactly: who asks, verbatim blockquote, numbered options, tail', () => {
    const message = gateRelayMessage({
      kind: 'decision_gate',
      worktreeName: 'orca-53-lint-ci',
      repo: 'orca',
      issueNumber: 53,
      issueUrl: 'https://github.com/acme/tooling/issues/53',
      question:
        'Two lint configs coexist (`.eslintrc.cjs` at the root, `eslint.config.mjs` in\n' +
        '`app/`). Which one is authoritative for CI?',
      options: ['`.eslintrc.cjs` (root)', '`eslint.config.mjs` (app/)', 'Merge both into flat config'],
    });
    expect(message).toBe(
      [
        '❓ *`orca-53-lint-ci`* (<https://github.com/acme/tooling/issues/53|orca#53>) asks:',
        '',
        '> Two lint configs coexist (`.eslintrc.cjs` at the root, `eslint.config.mjs` in',
        '> `app/`). Which one is authoritative for CI?',
        '> *1.* `.eslintrc.cjs` (root)',
        '> *2.* `eslint.config.mjs` (app/)',
        '> *3.* Merge both into flat config',
        '',
        'Reply in this thread — a number or free text.',
      ].join('\n'),
    );
  });

  it('marks an escalation 🚨, drops the number tail without options', () => {
    const message = gateRelayMessage({
      kind: 'escalation',
      worktreeName: 'webapp-84-csv-export',
      repo: 'webapp',
      issueNumber: 84,
      issueUrl: 'https://github.com/acme/webapp/issues/84',
      question:
        'The e2e tests break on `main` even without my changes — I’m pausing until further notice.',
      options: [],
    });
    expect(message).toBe(
      [
        '🚨 *`webapp-84-csv-export`* (<https://github.com/acme/webapp/issues/84|webapp#84>) escalates:',
        '',
        '> The e2e tests break on `main` even without my changes — I’m pausing until further notice.',
        '',
        'Reply in this thread.',
      ].join('\n'),
    );
  });

  it('degrades to a plain ref without a GitHub remote, to "A worker" without a row', () => {
    const linked = gateRelayMessage({
      kind: 'decision_gate',
      worktreeName: 'sandbox-21-bench',
      repo: 'sandbox',
      issueNumber: 21,
      question: 'Overwrite bench.json?',
      options: [],
    });
    expect(linked).toContain('❓ *`sandbox-21-bench`* (sandbox#21) asks:');

    const unmatched = gateRelayMessage({
      kind: 'decision_gate',
      worktreeName: null,
      repo: null,
      issueNumber: null,
      question: 'Anyone there?',
      options: [],
    });
    expect(unmatched).toContain('❓ *A worker* asks:');
    expect(unmatched).toContain('> Anyone there?');
  });
});

describe('stalledWorkerAlert — the watchdog ⚠️ (issue #22)', () => {
  it('renders the mock exactly: who, silence span, quoted last output, reply instruction', () => {
    const message = stalledWorkerAlert({
      worktreeName: 'sandbox-21-bench',
      repo: 'sandbox',
      issueNumber: 21,
      issueUrl: 'https://github.com/acme/sandbox/issues/21',
      stalledForMs: 25 * 60_000,
      lastOutput: '? Overwrite existing bench.json? (y/N)',
    });
    expect(message).toBe(
      [
        '⚠️ *`sandbox-21-bench`* (<https://github.com/acme/sandbox/issues/21|sandbox#21>) seems stalled —',
        'no sign for 25 min, without having asked a question. Last output:',
        '',
        '> `? Overwrite existing bench.json? (y/N)`',
        '',
        "Tell me what to answer, I'll relay it to its terminal.",
      ].join('\n'),
    );
  });

  it('quotes a multi-line tail line by line, keeping blank lines quoted', () => {
    const message = stalledWorkerAlert({
      worktreeName: 'sandbox-21-bench',
      repo: 'sandbox',
      issueNumber: 21,
      stalledForMs: 12 * 60_000,
      lastOutput: 'running bench…\n\n? Overwrite existing bench.json? (y/N)',
    });
    expect(message).toContain('> `running bench…`\n>\n> `? Overwrite existing bench.json? (y/N)`');
  });

  it('keeps the code quoting stable when the output itself carries backticks', () => {
    const message = stalledWorkerAlert({
      worktreeName: 'sandbox-21-bench',
      repo: 'sandbox',
      issueNumber: 21,
      stalledForMs: 12 * 60_000,
      lastOutput: 'delete `bench.json`? (y/N)',
    });
    expect(message).toContain("> `delete 'bench.json'? (y/N)`");
  });

  it('degrades: plain ref without a remote, "A worker" without a row, no readable output', () => {
    const message = stalledWorkerAlert({
      worktreeName: null,
      repo: null,
      issueNumber: null,
      stalledForMs: 130 * 60_000,
      lastOutput: '  ',
    });
    expect(message).toContain('⚠️ *A worker* seems stalled —');
    expect(message).toContain('no sign for 2 h 10 min');
    expect(message).toContain('> (no recent output could be read)');
  });
});

describe('inflightWorkerAlert — the watchdog’s second signal ⚠️ (issue #48)', () => {
  it('renders who, the mute-bus span, agent state, quoted last assistant message, reply instruction', () => {
    const message = inflightWorkerAlert({
      worktreeName: 'sandbox-2-report',
      repo: 'sandbox',
      issueNumber: 2,
      issueUrl: 'https://github.com/acme/sandbox/issues/2',
      inFlightForMs: 32 * 60_000,
      agentState: 'working',
      lastAssistantMessage: 'Exit code 1 / Orca is not running.',
    });
    expect(message).toBe(
      [
        '⚠️ *`sandbox-2-report`* (<https://github.com/acme/sandbox/issues/2|sandbox#2>) needs attention —',
        'in flight for 32 min without a word on the bus (agent state: `working`). Last assistant message:',
        '',
        '> `Exit code 1 / Orca is not running.`',
        '',
        "Tell me what to answer, I'll relay it to its terminal.",
      ].join('\n'),
    );
  });

  it('quotes a multi-line message line by line, stabilizing backticks', () => {
    const message = inflightWorkerAlert({
      worktreeName: 'sandbox-2-report',
      repo: 'sandbox',
      issueNumber: 2,
      inFlightForMs: 45 * 60_000,
      agentState: 'working',
      lastAssistantMessage: 'retrying `orca open`…\n\nstill failing',
    });
    expect(message).toContain("> `retrying 'orca open'…`\n>\n> `still failing`");
  });

  it('degrades: plain ref, "A worker", unknown agent state, no readable message', () => {
    const message = inflightWorkerAlert({
      worktreeName: null,
      repo: null,
      issueNumber: null,
      inFlightForMs: 90 * 60_000,
      agentState: null,
      lastAssistantMessage: '  ',
    });
    expect(message).toContain('⚠️ *A worker* needs attention —');
    expect(message).toContain('in flight for 1 h 30 min without a word on the bus');
    expect(message).toContain('(agent state: `unknown`)');
    expect(message).toContain('> (no assistant message could be read)');
  });
});

describe('gateAnswerAck — scenario C, the relayed-answer acknowledgment', () => {
  it('renders the mock verbatim', () => {
    expect(gateAnswerAck('orca#53', 'Merge both into flat config')).toBe(
      '✅ Relayed to `orca#53` — "Merge both into flat config"',
    );
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
      'Opened https://github.com/acme/webapp/pull/87 (see ' +
      'https://github.com/acme/webapp/pull/87) and ' +
      'https://github.com/acme/sandbox/pull/3.';
    expect(extractPullRequestLinks(text)).toEqual([
      { url: 'https://github.com/acme/webapp/pull/87', label: 'webapp#87' },
      { url: 'https://github.com/acme/sandbox/pull/3', label: 'sandbox#3' },
    ]);
  });

  it('returns nothing when the report names no PR', () => {
    expect(extractPullRequestLinks('all done, nothing to link')).toEqual([]);
  });
});

describe('restartNotice (issue #25)', () => {
  it('renders the mock reboot verbatim for a single in-flight delegation', () => {
    expect(
      restartNotice([{ ref: 'webapp#84', state: 'still in progress (last sign 4 min ago)' }]),
    ).toBe(
      '⚠️ Restarted — `webapp#84` was in flight: still in progress (last sign 4 min ago). ' +
        'Reply to resume supervision.',
    );
  });

  it('groups several delegations into one bulleted ⚠️ message', () => {
    expect(
      restartNotice([
        { ref: 'webapp#84', state: 'still in progress (last sign 4 min ago)' },
        { ref: 'sandbox#21', state: '✅ completed during the outage (details in the card ⤴)' },
      ]),
    ).toBe(
      [
        '⚠️ Restarted — 2 delegations were in flight:',
        '• `webapp#84` — still in progress (last sign 4 min ago)',
        '• `sandbox#21` — ✅ completed during the outage (details in the card ⤴)',
        'Reply to resume supervision.',
      ].join('\n'),
    );
  });
});

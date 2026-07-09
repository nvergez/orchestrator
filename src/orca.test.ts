import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import {
  listOrchestrationTasks,
  listRegistryRepos,
  listWorktreeActivity,
  listWorktreeProcesses,
  readTerminalTail,
  registryIssueUrl,
  safeRegistryIssueUrls,
  type CommandRunner,
} from './orca.ts';

/** Canned `orca repo list --json` payload (real CLI envelope shape). */
const registryJson = (repos: unknown[]): string =>
  JSON.stringify({ id: 'call-1', ok: true, result: { repos } });

const succeedWith =
  (stdout: string): CommandRunner =>
  () =>
    Promise.resolve({ stdout });

describe('listRegistryRepos', () => {
  it('maps the envelope to id/name pairs', async () => {
    const repos = await listRegistryRepos(
      succeedWith(registryJson([{ id: 'u1', displayName: 'forwardly', path: '/p' }])),
    );
    expect(repos).toEqual([{ id: 'u1', name: 'forwardly' }]);
  });

  it('throws on an ok:false or shapeless envelope', async () => {
    await expect(listRegistryRepos(succeedWith(JSON.stringify({ ok: false })))).rejects.toThrow(
      /unexpected `orca repo list` response shape/,
    );
  });

  it('drops entries missing id or displayName — narrowing is the safe direction', async () => {
    const repos = await listRegistryRepos(
      succeedWith(registryJson([{ id: 'u1' }, { id: 'u2', displayName: 'orca' }])),
    );
    expect(repos).toEqual([{ id: 'u2', name: 'orca' }]);
  });
});

describe('listOrchestrationTasks', () => {
  const taskListJson = (tasks: unknown[]): string =>
    JSON.stringify({ id: 'call-2', ok: true, result: { tasks } });

  it('maps the envelope to id/status pairs', async () => {
    const tasks = await listOrchestrationTasks(
      succeedWith(
        taskListJson([
          { id: 'task_a1', status: 'completed', task_title: 'bench' },
          { id: 'task_b2', status: 'dispatched' },
        ]),
      ),
    );
    expect(tasks).toEqual([
      { id: 'task_a1', status: 'completed' },
      { id: 'task_b2', status: 'dispatched' },
    ]);
  });

  it('throws on a shapeless envelope and drops unreadable entries', async () => {
    await expect(
      listOrchestrationTasks(succeedWith(JSON.stringify({ ok: false }))),
    ).rejects.toThrow(/unexpected `orca orchestration task-list` response shape/);

    const tasks = await listOrchestrationTasks(
      succeedWith(taskListJson([{ id: 'task_a1' }, { status: 'pending' }])),
    );
    expect(tasks).toEqual([]);
  });
});

describe('listWorktreeProcesses', () => {
  const psJson = (worktrees: unknown[]): string =>
    JSON.stringify({ id: 'call-3', ok: true, result: { worktrees } });

  it('maps the envelope to the reconciliation-relevant fields', async () => {
    const worktrees = await listWorktreeProcesses(
      succeedWith(
        psJson([
          {
            worktreeId: 'repo-1::/home/dev/w/scratch-21-bench',
            path: '/home/dev/w/scratch-21-bench',
            isArchived: false,
            liveTerminalCount: 2,
            lastOutputAt: 1783531809953,
          },
        ]),
      ),
    );
    expect(worktrees).toEqual([
      {
        worktreeId: 'repo-1::/home/dev/w/scratch-21-bench',
        path: '/home/dev/w/scratch-21-bench',
        isArchived: false,
        liveTerminalCount: 2,
        lastOutputAt: 1783531809953,
      },
    ]);
  });

  it('degrades absent liveness fields instead of guessing activity', async () => {
    const worktrees = await listWorktreeProcesses(
      succeedWith(psJson([{ worktreeId: 'repo-1::/p', path: '/p' }])),
    );
    expect(worktrees).toEqual([
      {
        worktreeId: 'repo-1::/p',
        path: '/p',
        isArchived: false,
        liveTerminalCount: 0,
        lastOutputAt: null,
      },
    ]);
  });

  it('throws on a shapeless envelope', async () => {
    await expect(listWorktreeProcesses(succeedWith('not json'))).rejects.toThrow(
      /unexpected `orca worktree ps` response shape/,
    );
  });
});

describe('registryIssueUrl', () => {
  const registry = registryJson([
    {
      id: 'u1',
      displayName: 'forwardly',
      gitRemoteIdentity: { canonicalKey: 'github.com/lemlist/forwardly' },
    },
    { id: 'u2', displayName: 'scratch' },
  ]);

  it('builds the issue link off the canonical key', async () => {
    await expect(registryIssueUrl(succeedWith(registry), 'forwardly', 84)).resolves.toBe(
      'https://github.com/lemlist/forwardly/issues/84',
    );
  });

  it('is undefined for a folder repo without a remote, or an unknown repo', async () => {
    await expect(registryIssueUrl(succeedWith(registry), 'scratch', 21)).resolves.toBeUndefined();
    await expect(registryIssueUrl(succeedWith(registry), 'ghost', 1)).resolves.toBeUndefined();
  });
});

describe('safeRegistryIssueUrls (issue #51)', () => {
  const logger = createLogger('silent');
  const registry = registryJson([
    {
      id: 'u1',
      displayName: 'forwardly',
      gitRemoteIdentity: { canonicalKey: 'github.com/lemlist/forwardly' },
    },
    { id: 'u2', displayName: 'scratch' },
  ]);

  const countingRunner = (stdout: string): { run: CommandRunner; calls: () => number } => {
    let calls = 0;
    return {
      run: () => {
        calls += 1;
        return Promise.resolve({ stdout });
      },
      calls: () => calls,
    };
  };

  it('links every row off one registry read; folder repos stay plain', async () => {
    const { run, calls } = countingRunner(registry);

    const rows = await safeRegistryIssueUrls(run, logger, [
      { repo: 'forwardly', issueNumber: 84 },
      { repo: 'forwardly', issueNumber: 91 },
      { repo: 'scratch', issueNumber: 21 },
    ]);

    expect(rows).toEqual([
      {
        repo: 'forwardly',
        issueNumber: 84,
        issueUrl: 'https://github.com/lemlist/forwardly/issues/84',
      },
      {
        repo: 'forwardly',
        issueNumber: 91,
        issueUrl: 'https://github.com/lemlist/forwardly/issues/91',
      },
      { repo: 'scratch', issueNumber: 21 },
    ]);
    expect(calls()).toBe(1);
  });

  it('leaves rows without a linkable repo untouched — and skips the CLI entirely', async () => {
    const { run, calls } = countingRunner(registry);

    const rows = await safeRegistryIssueUrls(run, logger, [
      { repo: null, issueNumber: 84 },
      { repo: 'forwardly', issueNumber: null },
    ]);

    expect(rows).toEqual([
      { repo: null, issueNumber: 84 },
      { repo: 'forwardly', issueNumber: null },
    ]);
    expect(calls()).toBe(0);
    await expect(safeRegistryIssueUrls(run, logger, [])).resolves.toEqual([]);
    expect(calls()).toBe(0);
  });

  it('degrades every link at once when Orca is unreachable — never a throw', async () => {
    const down: CommandRunner = () => Promise.reject(new Error('orca down'));

    await expect(
      safeRegistryIssueUrls(down, logger, [{ repo: 'forwardly', issueNumber: 84 }]),
    ).resolves.toEqual([{ repo: 'forwardly', issueNumber: 84 }]);
  });
});

describe('listWorktreeActivity (issue #22)', () => {
  const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

  it('maps worktrees to their liveness signals, tolerating absent fields', async () => {
    const activity = await listWorktreeActivity(
      succeedWith(
        envelope({
          worktrees: [
            {
              worktreeId: 'r1::/p1',
              lastOutputAt: 1783528800000,
              agents: [
                {
                  state: 'working',
                  stateStartedAt: 1783528000000,
                  updatedAt: 1783528700000,
                  lastAssistantMessage: 'Exit code 1 — Orca is not running.',
                },
                { state: 'done' },
                { notAnAgent: true },
              ],
            },
            { worktreeId: 'r2::/p2', lastOutputAt: null },
            { lastOutputAt: 123 },
          ],
        }),
      ),
    );

    expect(activity.get('r1::/p1')).toEqual({
      lastOutputAt: 1783528800000,
      agents: [
        {
          state: 'working',
          stateStartedAt: 1783528000000,
          updatedAt: 1783528700000,
          lastAssistantMessage: 'Exit code 1 — Orca is not running.',
        },
        { state: 'done', stateStartedAt: null, updatedAt: null, lastAssistantMessage: null },
      ],
    });
    expect(activity.get('r2::/p2')).toEqual({ lastOutputAt: null, agents: [] });
    expect(activity.size).toBe(2);
  });

  it('asks for an explicit --limit and throws on a shapeless envelope', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_command, args) => {
      calls.push(args);
      return Promise.resolve({ stdout: envelope({ worktrees: [] }) });
    };
    await listWorktreeActivity(run);
    expect(calls).toEqual([['worktree', 'ps', '--limit', '1000', '--json']]);

    await expect(listWorktreeActivity(succeedWith(JSON.stringify({ ok: false })))).rejects.toThrow(
      /unexpected `orca worktree ps` response shape/,
    );
  });
});

describe('readTerminalTail (issue #22)', () => {
  const envelope = (result: object): string => JSON.stringify({ id: 'x', ok: true, result });

  it('returns the tail lines, dropping non-strings', async () => {
    await expect(
      readTerminalTail(
        succeedWith(envelope({ terminal: { handle: 'term_1', tail: ['a', 2, 'b'] } })),
        'term_1',
        40,
      ),
    ).resolves.toEqual(['a', 'b']);
  });

  it('throws on a shapeless envelope', async () => {
    await expect(
      readTerminalTail(succeedWith(envelope({ terminal: {} })), 'term_1', 40),
    ).rejects.toThrow(/unexpected `orca terminal read` response shape/);
  });
});

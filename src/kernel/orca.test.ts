import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import {
  bindRun,
  createRun,
  isOrcaWorktree,
  listOrchestrationTasks,
  listRegistryRepos,
  listWorktreeActivity,
  listWorktreeProcesses,
  readCheckMessages,
  readTerminalTail,
  registryIssueUrl,
  safeRegistryIssueUrls,
  type CommandRunner,
} from './orca.ts';

/** A runner that records its argv and answers every call the same way. */
const recording = (stdout: string) => {
  const calls: string[][] = [];
  const run: CommandRunner = (_command, args) => {
    calls.push(args);
    return Promise.resolve({ stdout });
  };
  return { run, calls };
};

/** Canned `orca repo list --json` payload (real CLI envelope shape). */
const registryJson = (repos: unknown[]): string =>
  JSON.stringify({ id: 'call-1', ok: true, result: { repos } });

const succeedWith =
  (stdout: string): CommandRunner =>
  () =>
    Promise.resolve({ stdout });

describe('listRegistryRepos', () => {
  it('maps the envelope to id/name pairs, with the checkout path when present', async () => {
    const repos = await listRegistryRepos(
      succeedWith(registryJson([{ id: 'u1', displayName: 'webapp', path: '/p' }, { id: 'u2', displayName: 'bare' }])),
    );
    expect(repos).toEqual([{ id: 'u1', name: 'webapp', path: '/p' }, { id: 'u2', name: 'bare' }]);
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
            worktreeId: 'repo-1::/home/op/w/sandbox-21-bench',
            path: '/home/op/w/sandbox-21-bench',
            isArchived: false,
            liveTerminalCount: 2,
            lastOutputAt: 1783531809953,
          },
        ]),
      ),
    );
    expect(worktrees).toEqual([
      {
        worktreeId: 'repo-1::/home/op/w/sandbox-21-bench',
        path: '/home/op/w/sandbox-21-bench',
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
      displayName: 'webapp',
      gitRemoteIdentity: { canonicalKey: 'github.com/acme/webapp' },
    },
    { id: 'u2', displayName: 'sandbox' },
  ]);

  it('builds the issue link off the canonical key', async () => {
    await expect(registryIssueUrl(succeedWith(registry), 'webapp', 84)).resolves.toBe(
      'https://github.com/acme/webapp/issues/84',
    );
  });

  it('is undefined for a folder repo without a remote, or an unknown repo', async () => {
    await expect(registryIssueUrl(succeedWith(registry), 'sandbox', 21)).resolves.toBeUndefined();
    await expect(registryIssueUrl(succeedWith(registry), 'ghost', 1)).resolves.toBeUndefined();
  });
});

describe('safeRegistryIssueUrls (issue #51)', () => {
  const logger = createLogger('silent');
  const registry = registryJson([
    {
      id: 'u1',
      displayName: 'webapp',
      gitRemoteIdentity: { canonicalKey: 'github.com/acme/webapp' },
    },
    { id: 'u2', displayName: 'sandbox' },
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
      { repo: 'webapp', issueNumber: 84 },
      { repo: 'webapp', issueNumber: 91 },
      { repo: 'sandbox', issueNumber: 21 },
    ]);

    expect(rows).toEqual([
      {
        repo: 'webapp',
        issueNumber: 84,
        issueUrl: 'https://github.com/acme/webapp/issues/84',
      },
      {
        repo: 'webapp',
        issueNumber: 91,
        issueUrl: 'https://github.com/acme/webapp/issues/91',
      },
      { repo: 'sandbox', issueNumber: 21 },
    ]);
    expect(calls()).toBe(1);
  });

  it('leaves rows without a linkable repo untouched — and skips the CLI entirely', async () => {
    const { run, calls } = countingRunner(registry);

    const rows = await safeRegistryIssueUrls(run, logger, [
      { repo: null, issueNumber: 84 },
      { repo: 'webapp', issueNumber: null },
    ]);

    expect(rows).toEqual([
      { repo: null, issueNumber: 84 },
      { repo: 'webapp', issueNumber: null },
    ]);
    expect(calls()).toBe(0);
    await expect(safeRegistryIssueUrls(run, logger, [])).resolves.toEqual([]);
    expect(calls()).toBe(0);
  });

  it('degrades every link at once when Orca is unreachable — never a throw', async () => {
    const down: CommandRunner = () => Promise.reject(new Error('orca down'));

    await expect(
      safeRegistryIssueUrls(down, logger, [{ repo: 'webapp', issueNumber: 84 }]),
    ).resolves.toEqual([{ repo: 'webapp', issueNumber: 84 }]);
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

describe('listOrchestrationTasks --from (ADR 0006)', () => {
  it('asks from the given mailbox — the Run bound to it scopes the list', async () => {
    const { run, calls } = recording(JSON.stringify({ id: 'c', ok: true, result: { tasks: [] } }));
    await listOrchestrationTasks(run, 'term_mb1');
    expect(calls).toEqual([['orchestration', 'task-list', '--from', 'term_mb1', '--json']]);
  });
});

describe('readCheckMessages (ADR 0006)', () => {
  const checkJson = (result: object): string => JSON.stringify({ id: 'c', ok: true, result });
  const message = (over: Record<string, unknown> = {}): object => ({
    id: 'msg_e4f1',
    run_id: 'run_eda2',
    from_handle: 'term_w1',
    to_handle: 'run:run_eda2',
    subject: 'done',
    body: 'one. two. three.',
    type: 'worker_done',
    payload: JSON.stringify({ taskId: 'task_8393', dispatchId: 'ctx_1', outcome: 'failed' }),
    read: 0,
    ...over,
  });

  it('reads the Delivery id beside the messages, and the worker outcome off the payload', () => {
    const read = readCheckMessages(
      checkJson({ runId: 'run_eda2', deliveryId: 'delivery_2f2f', messages: [message()], count: 1, acknowledged: null }),
    );
    expect(read.deliveryId).toBe('delivery_2f2f');
    expect(read.messages).toEqual([
      {
        id: 'msg_e4f1',
        type: 'worker_done',
        subject: 'done',
        body: 'one. two. three.',
        fromHandle: 'term_w1',
        payload: { taskId: 'task_8393', dispatchId: 'ctx_1', outcome: 'failed' },
      },
    ]);
  });

  it('carries no Delivery id on a timeout, a peek or an older runtime — and no outcome for an unknown verdict', () => {
    expect(readCheckMessages(checkJson({ deliveryId: null, messages: [], count: 0, timedOut: true })).deliveryId).toBeUndefined();
    expect(readCheckMessages(checkJson({ messages: [], count: 0 })).deliveryId).toBeUndefined();
    const read = readCheckMessages(
      checkJson({ messages: [message({ payload: JSON.stringify({ taskId: 'task_8393', outcome: 'maybe' }) })], count: 1 }),
    );
    expect(read.messages[0]?.payload).toEqual({ taskId: 'task_8393' });
  });

  it('throws on a shapeless envelope and drops unreadable entries, keeping the raw count', () => {
    expect(() => readCheckMessages(JSON.stringify({ ok: false }))).toThrow(
      /unexpected `orca orchestration check` response shape/,
    );
    const read = readCheckMessages(checkJson({ messages: [{ subject: 'no id' }, message()], count: 2 }));
    expect(read.messages).toHaveLength(1);
    expect(read.raw).toHaveLength(2);
  });
});

describe('createRun / bindRun (ADR 0006)', () => {
  it('run-create binds a fresh Run to the mailbox and resolves with its id', async () => {
    const { run, calls } = recording(
      JSON.stringify({ id: 'c', ok: true, result: { run: { id: 'run_d86a', coordinator_handle: 'term_mb1' } } }),
    );
    await expect(createRun(run, { from: 'term_mb1', objective: 'slack-C1-1.2' })).resolves.toBe('run_d86a');
    expect(calls).toEqual([
      ['orchestration', 'run-create', '--objective', 'slack-C1-1.2', '--from', 'term_mb1', '--json'],
    ]);
  });

  it('run-use re-binds an existing Run to a fresh mailbox', async () => {
    const { run, calls } = recording(JSON.stringify({ id: 'c', ok: true, result: { run: { id: 'run_d86a' } } }));
    await expect(bindRun(run, { from: 'term_mb2', runId: 'run_d86a' })).resolves.toBeUndefined();
    expect(calls).toEqual([['orchestration', 'run-use', '--id', 'run_d86a', '--from', 'term_mb2', '--json']]);
  });

  it('both throw on a refusal — the caller turns it into the ⚠️ line', async () => {
    const refused = succeedWith(JSON.stringify({ id: 'c', ok: false, error: { code: 'run_required' } }));
    await expect(createRun(refused, { from: 'term_mb1', objective: 'x' })).rejects.toThrow(/run-create/);
    await expect(bindRun(refused, { from: 'term_mb1', runId: 'run_x' })).rejects.toThrow(/run-use/);
  });
});

describe('isOrcaWorktree (ADR 0007)', () => {
  it('asks `worktree show` by path and reads a hit', async () => {
    const { run, calls } = recording(
      JSON.stringify({ id: 'w', ok: true, result: { worktree: { id: 'u::/home/op/projects/webapp', path: '/home/op/projects/webapp' } } }),
    );
    await expect(isOrcaWorktree(run, '/home/op/projects/webapp')).resolves.toBe(true);
    expect(calls).toEqual([['worktree', 'show', '--worktree', 'path:/home/op/projects/webapp', '--json']]);
  });

  it("reads the runtime's selector_not_found refusal as false, and lets any other failure throw", async () => {
    const refused: CommandRunner = () =>
      Promise.reject(
        Object.assign(new Error('Command failed'), {
          stdout: JSON.stringify({ id: 'w', ok: false, error: { code: 'selector_not_found', message: 'selector_not_found' } }),
        }),
      );
    await expect(isOrcaWorktree(refused, '/home/op')).resolves.toBe(false);
    const down: CommandRunner = () => Promise.reject(new Error('connect ECONNREFUSED'));
    await expect(isOrcaWorktree(down, '/home/op')).rejects.toThrow(/ECONNREFUSED/);
    // A success envelope without a worktree is not a hit either.
    await expect(isOrcaWorktree(succeedWith(JSON.stringify({ ok: true, result: {} })), '/x')).resolves.toBe(false);
  });
});

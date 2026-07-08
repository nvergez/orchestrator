import { describe, expect, it } from 'vitest';
import {
  listOrchestrationTasks,
  listRegistryRepos,
  listWorktreeProcesses,
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

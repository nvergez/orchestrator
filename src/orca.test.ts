import { describe, expect, it } from 'vitest';
import { listRegistryRepos, type CommandRunner } from './orca.ts';

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

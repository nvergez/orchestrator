import { describe, expect, it, vi } from 'vitest';
import { probeOrca, reportOrcaHealth, type CommandRunner } from './orca-health.ts';

/** Canned `orca repo list --json` success payload (real CLI envelope shape). */
const repoListJson = JSON.stringify({
  id: '82605d31-2782-404a-92b4-53aae089274a',
  ok: true,
  result: {
    repos: [{ displayName: 'forwardly' }, { displayName: 'orchestrator' }],
  },
});

const succeedWith =
  (stdout: string): CommandRunner =>
  () =>
    Promise.resolve({ stdout });

const failWith =
  (error: Error): CommandRunner =>
  () =>
    Promise.reject(error);

const enoent = (): Error =>
  Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' });

describe('probeOrca', () => {
  it('reports Orca reachable, with the repo count, when the CLI answers', async () => {
    const report = await probeOrca(succeedWith(repoListJson));

    expect(report).toEqual({ status: 'reachable', repoCount: 2 });
  });

  it('reports unreachable, pointing at PATH, when the orca CLI is not installed', async () => {
    const report = await probeOrca(failWith(enoent()));

    expect(report).toEqual({
      status: 'unreachable',
      reason: 'orca CLI not found on PATH',
    });
  });

  it('reports unreachable with the failure message when the CLI errors out', async () => {
    const report = await probeOrca(failWith(new Error('Command failed: orca repo list --json')));

    expect(report).toEqual({
      status: 'unreachable',
      reason: 'Command failed: orca repo list --json',
    });
  });

  it('reports unreachable instead of crashing when the CLI prints garbage', async () => {
    const report = await probeOrca(succeedWith('not json at all'));

    expect(report.status).toBe('unreachable');
  });

  it('does not call an ok:false envelope reachable', async () => {
    const report = await probeOrca(succeedWith(JSON.stringify({ ok: false, error: 'boom' })));

    expect(report).toEqual({
      status: 'unreachable',
      reason: 'unexpected `orca repo list` response shape',
    });
  });

  it('reports a clear reason when the envelope has no repo list', async () => {
    const report = await probeOrca(succeedWith(JSON.stringify({ ok: true, result: {} })));

    expect(report).toEqual({
      status: 'unreachable',
      reason: 'unexpected `orca repo list` response shape',
    });
  });
});

describe('reportOrcaHealth', () => {
  const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn() });

  it('logs at info, with the repo count, when Orca is reachable', async () => {
    const logger = fakeLogger();

    await reportOrcaHealth(logger, succeedWith(repoListJson));

    expect(logger.info).toHaveBeenCalledWith(
      { repoCount: 2 },
      'boot healthcheck: Orca runtime reachable',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs at warn, with the reason, when Orca is unreachable', async () => {
    const logger = fakeLogger();

    await reportOrcaHealth(logger, failWith(enoent()));

    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'orca CLI not found on PATH' },
      'boot healthcheck: Orca runtime unavailable',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});

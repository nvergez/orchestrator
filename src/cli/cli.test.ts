import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliDeps } from './cli.ts';

const makeDeps = (): { deps: CliDeps; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    version: vi.fn(() => '1.2.3'),
    daemon: vi.fn(() => Promise.resolve()),
    init: vi.fn(() => 0),
    doctor: vi.fn(() => Promise.resolve(0)),
    update: vi.fn(() => Promise.resolve(0)),
    serviceInstall: vi.fn(() => Promise.resolve(0)),
    serviceUninstall: vi.fn(() => Promise.resolve(0)),
    dashboard: vi.fn(() => Promise.resolve()),
  };
  return { deps, out, err };
};

describe('runCli', () => {
  it('runs the daemon on bare `orc`', async () => {
    const { deps } = makeDeps();
    await expect(runCli([], deps)).resolves.toBe(0);
    expect(deps.daemon).toHaveBeenCalledOnce();
  });

  it('prints the version and exits 0 on --version — no config needed (issue #69)', async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(['--version'], deps)).resolves.toBe(0);
    expect(out).toEqual(['1.2.3']);
    expect(deps.daemon).not.toHaveBeenCalled();
  });

  it('accepts -v as the short form', async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(['-v'], deps)).resolves.toBe(0);
    expect(out).toEqual(['1.2.3']);
  });

  it('dispatches init and doctor', async () => {
    const { deps } = makeDeps();
    await expect(runCli(['init'], deps)).resolves.toBe(0);
    expect(deps.init).toHaveBeenCalledOnce();
    await expect(runCli(['doctor'], deps)).resolves.toBe(0);
    expect(deps.doctor).toHaveBeenCalledOnce();
  });

  it('propagates doctor’s non-zero exit code', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.doctor).mockResolvedValue(1);
    await expect(runCli(['doctor'], deps)).resolves.toBe(1);
  });

  it('dispatches update, passing --yes through as the major-jump consent', async () => {
    const { deps } = makeDeps();
    await expect(runCli(['update'], deps)).resolves.toBe(0);
    expect(deps.update).toHaveBeenCalledWith(false);
    await expect(runCli(['update', '--yes'], deps)).resolves.toBe(0);
    expect(deps.update).toHaveBeenCalledWith(true);
  });

  it('propagates update’s non-zero exit code', async () => {
    const { deps } = makeDeps();
    vi.mocked(deps.update).mockResolvedValue(1);
    await expect(runCli(['update'], deps)).resolves.toBe(1);
  });

  it('dispatches service install / service uninstall', async () => {
    const { deps } = makeDeps();
    await expect(runCli(['service', 'install'], deps)).resolves.toBe(0);
    expect(deps.serviceInstall).toHaveBeenCalledOnce();
    await expect(runCli(['service', 'uninstall'], deps)).resolves.toBe(0);
    expect(deps.serviceUninstall).toHaveBeenCalledOnce();
  });

  it('runs the dashboard sidecar on `orc dashboard` — never as part of the daemon (ADR 0002)', async () => {
    const { deps } = makeDeps();
    await expect(runCli(['dashboard'], deps)).resolves.toBe(0);
    expect(deps.dashboard).toHaveBeenCalledOnce();
    expect(deps.daemon).not.toHaveBeenCalled();
  });

  it('prints usage on --help without touching any handler', async () => {
    const { deps, out } = makeDeps();
    await expect(runCli(['--help'], deps)).resolves.toBe(0);
    expect(out.join('\n')).toContain('Usage: orc');
    expect(deps.daemon).not.toHaveBeenCalled();
    expect(deps.doctor).not.toHaveBeenCalled();
  });

  it.each([
    [['frobnicate']],
    [['service']],
    [['service', 'restart']],
    [['init', 'extra']],
    [['doctor', '--fix']],
    [['service', 'install', '--force']],
    [['update', 'now']],
    [['update', '--yes', 'extra']],
    [['dashboard', 'extra']],
  ])('rejects %j with exit 1 and usage on stderr', async (argv) => {
    const { deps, err } = makeDeps();
    await expect(runCli(argv, deps)).resolves.toBe(1);
    expect(err[0]).toContain('unknown command');
    expect(err.join('\n')).toContain('Usage: orc');
    expect(deps.daemon).not.toHaveBeenCalled();
    expect(deps.init).not.toHaveBeenCalled();
    expect(deps.doctor).not.toHaveBeenCalled();
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.serviceInstall).not.toHaveBeenCalled();
    expect(deps.serviceUninstall).not.toHaveBeenCalled();
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from './init.ts';
import { ENV_TEMPLATE, ROUTING_HINTS_TEMPLATE } from './templates.ts';

describe('runInit', () => {
  const tempDirs: string[] = [];

  const freshXdgHome = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-init-'));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const runInto = (xdgHome: string): string[] => {
    const lines: string[] = [];
    expect(runInit({ XDG_CONFIG_HOME: xdgHome }, { out: (line) => lines.push(line) })).toBe(0);
    return lines;
  };

  it('scaffolds the config dir with both files from the embedded templates', () => {
    const xdgHome = freshXdgHome();
    const lines = runInto(xdgHome);

    const dir = join(xdgHome, 'orchestrator');
    expect(readFileSync(join(dir, 'routing-hints.json'), 'utf8')).toBe(ROUTING_HINTS_TEMPLATE);
    expect(readFileSync(join(dir, 'env'), 'utf8')).toBe(ENV_TEMPLATE);
    expect(lines.some((line) => line.includes('Next steps'))).toBe(true);
  });

  it('chmods the env file to 600 — it will hold live tokens', () => {
    const xdgHome = freshXdgHome();
    runInto(xdgHome);

    const mode = statSync(join(xdgHome, 'orchestrator', 'env')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('never overwrites an existing file — re-running init is safe', () => {
    const xdgHome = freshXdgHome();
    runInto(xdgHome);
    const dir = join(xdgHome, 'orchestrator');
    writeFileSync(join(dir, 'env'), 'SLACK_BOT_TOKEN=xoxb-real\n');
    writeFileSync(join(dir, 'routing-hints.json'), '{"repos":[]}');

    const lines = runInto(xdgHome);

    expect(readFileSync(join(dir, 'env'), 'utf8')).toBe('SLACK_BOT_TOKEN=xoxb-real\n');
    expect(readFileSync(join(dir, 'routing-hints.json'), 'utf8')).toBe('{"repos":[]}');
    expect(lines.filter((line) => line.includes('left untouched'))).toHaveLength(2);
  });

  it('creates the whole directory chain when nothing exists yet', () => {
    const xdgHome = join(freshXdgHome(), 'deeper', 'still');
    runInto(xdgHome);

    expect(existsSync(join(xdgHome, 'orchestrator', 'env'))).toBe(true);
  });
});

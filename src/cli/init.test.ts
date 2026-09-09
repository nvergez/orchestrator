import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInit } from './init.ts';
import { loadPersona } from '../kernel/persona.ts';
import { ENV_TEMPLATE, PERSONA_TEMPLATE, ROUTING_HINTS_TEMPLATE } from './templates.ts';

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

  it('scaffolds the config dir with the three files from the embedded templates', () => {
    const xdgHome = freshXdgHome();
    const lines = runInto(xdgHome);

    const dir = join(xdgHome, 'orchestrator');
    expect(readFileSync(join(dir, 'routing-hints.json'), 'utf8')).toBe(ROUTING_HINTS_TEMPLATE);
    expect(readFileSync(join(dir, 'env'), 'utf8')).toBe(ENV_TEMPLATE);
    expect(readFileSync(join(dir, 'persona.md'), 'utf8')).toBe(PERSONA_TEMPLATE);
    expect(lines.some((line) => line.includes('Next steps'))).toBe(true);
  });

  it('scaffolds a persona that reads as no persona until the operator writes one', () => {
    const xdgHome = freshXdgHome();
    runInto(xdgHome);

    expect(loadPersona(join(xdgHome, 'orchestrator', 'persona.md'))).toBeUndefined();
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
    writeFileSync(join(dir, 'persona.md'), 'Write like me.');

    const lines = runInto(xdgHome);

    expect(readFileSync(join(dir, 'env'), 'utf8')).toBe('SLACK_BOT_TOKEN=xoxb-real\n');
    expect(readFileSync(join(dir, 'routing-hints.json'), 'utf8')).toBe('{"repos":[]}');
    expect(readFileSync(join(dir, 'persona.md'), 'utf8')).toBe('Write like me.');
    expect(lines.filter((line) => line.includes('left untouched'))).toHaveLength(3);
  });

  it('creates the whole directory chain when nothing exists yet', () => {
    const xdgHome = join(freshXdgHome(), 'deeper', 'still');
    runInto(xdgHome);

    expect(existsSync(join(xdgHome, 'orchestrator', 'env'))).toBe(true);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPersona, personaInstructions, PersonaError, PERSONA_MAX_CHARS } from './persona.ts';

describe('loadPersona', () => {
  const dirs: string[] = [];

  const write = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-persona-'));
    dirs.push(dir);
    const path = join(dir, 'persona.md');
    writeFileSync(path, content);
    return path;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is optional — a missing file is the stock voice, not an error', () => {
    expect(loadPersona(join(tmpdir(), 'orc-persona-absent', 'persona.md'))).toBeUndefined();
  });

  it('returns the prose, trimmed', () => {
    expect(loadPersona(write('\n\nLower-case, no filler.\n\n'))).toBe('Lower-case, no filler.');
  });

  it('reads an untouched scaffold as no persona — HTML comments are commentary', () => {
    expect(loadPersona(write('<!-- Write your\nvoice here.\n-->\n'))).toBeUndefined();
  });

  it('keeps the prose around the commentary once the operator writes some', () => {
    expect(loadPersona(write('<!-- how-to -->\nWrite like me.\n<!-- example -->\n'))).toBe(
      'Write like me.',
    );
  });

  it('fails the boot over the size cap — the persona rides in every turn', () => {
    const path = write('x'.repeat(PERSONA_MAX_CHARS + 1));
    expect(() => loadPersona(path)).toThrow(PersonaError);
    expect(() => loadPersona(path)).toThrow(new RegExp(`${PERSONA_MAX_CHARS + 1} characters`));
  });

  it('fails the boot when the path exists but cannot be read as a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-persona-'));
    dirs.push(dir);
    expect(() => loadPersona(dir)).toThrow(PersonaError);
    expect(() => loadPersona(dir)).toThrow(/cannot read the persona at/);
  });
});

describe('personaInstructions', () => {
  const block = personaInstructions('Write like a senior engineer in a hurry.');

  it('carries the operator prose under a Voice heading', () => {
    expect(block).toContain('## Voice');
    expect(block).toContain('Write like a senior engineer in a hurry.');
  });

  it('fences the voice off the protocol — fixed lines, relay fidelity, Slack shape', () => {
    expect(block).toContain('Fixed lines stay fixed');
    expect(block).toContain('verbatim (spec §6)');
    expect(block).toContain('Slack mrkdwn');
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRoutingHints } from '../kernel/routing.ts';
import { loadPersona, WORKER_PERSONA_MAX_CHARS } from '../kernel/persona.ts';
import {
  ENV_TEMPLATE,
  PERSONA_TEMPLATE,
  ROUTING_HINTS_TEMPLATE,
  WORKER_PERSONA_TEMPLATE,
} from './templates.ts';

describe('ROUTING_HINTS_TEMPLATE', () => {
  it('parses under the strict hints schema — init must scaffold a bootable file', () => {
    const hints = parseRoutingHints(ROUTING_HINTS_TEMPLATE);
    expect(hints.map((h) => h.name)).toEqual(['webapp', 'sandbox']);
  });

  it('uses only fictional repo names', () => {
    expect(ROUTING_HINTS_TEMPLATE).not.toMatch(/forwardly|lemlist|nvergez|nikolai/);
  });

  it('is byte-identical to the shipped routing-hints.example.json browsing aid', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../routing-hints.example.json', import.meta.url)),
      'utf8',
    );
    expect(example).toBe(ROUTING_HINTS_TEMPLATE);
  });
});

describe('ENV_TEMPLATE', () => {
  it('scaffolds exactly the five required variables, empty', () => {
    for (const key of [
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_CHANNEL_IDS',
      'SLACK_ALLOWED_USER_IDS',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]) {
      expect(ENV_TEMPLATE).toMatch(new RegExp(`^${key}=$`, 'm'));
    }
  });

  it('keeps LOG_LEVEL present but commented', () => {
    expect(ENV_TEMPLATE).toMatch(/^#LOG_LEVEL=info$/m);
  });

  it('documents the dashboard address, commented at its localhost defaults (issue #87)', () => {
    expect(ENV_TEMPLATE).toMatch(/^#DASHBOARD_PORT=8787$/m);
    expect(ENV_TEMPLATE).toMatch(/^#DASHBOARD_BIND=127\.0\.0\.1$/m);
  });

  it('contains no live token material', () => {
    expect(ENV_TEMPLATE).not.toMatch(/=(xoxb|xapp|sk-ant)-/);
  });
});

describe('PERSONA_TEMPLATE', () => {
  it('is entirely commentary — an untouched scaffold must leave the stock voice', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orc-persona-tpl-')), 'persona.md');
    writeFileSync(path, PERSONA_TEMPLATE);
    expect(loadPersona(path)).toBeUndefined();
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it('tells the operator what the voice cannot restyle, and that a restart applies it', () => {
    expect(PERSONA_TEMPLATE).toMatch(/verbatim/);
    expect(PERSONA_TEMPLATE).toMatch(/systemctl --user restart orchestrator/);
  });

  it('is byte-identical to the shipped persona.example.md browsing aid', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../persona.example.md', import.meta.url)),
      'utf8',
    );
    expect(example).toBe(PERSONA_TEMPLATE);
  });
});

describe('WORKER_PERSONA_TEMPLATE', () => {
  it('is entirely commentary, and fits the worker cap once written', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orc-worker-tpl-')), 'persona-workers.md');
    writeFileSync(path, WORKER_PERSONA_TEMPLATE);
    expect(loadPersona(path, WORKER_PERSONA_MAX_CHARS)).toBeUndefined();
    expect(WORKER_PERSONA_TEMPLATE.length).toBeLessThan(WORKER_PERSONA_MAX_CHARS);
    rmSync(dirname(path), { recursive: true, force: true });
  });

  it('says why the second file exists and what it must not cost the answer', () => {
    expect(WORKER_PERSONA_TEMPLATE).toMatch(/verbatim/);
    expect(WORKER_PERSONA_TEMPLATE).toMatch(/could not verify/);
  });

  it('is byte-identical to the shipped persona-workers.example.md browsing aid', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../persona-workers.example.md', import.meta.url)),
      'utf8',
    );
    expect(example).toBe(WORKER_PERSONA_TEMPLATE);
  });
});


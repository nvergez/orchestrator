import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRoutingHints } from '../kernel/routing.ts';
import { ENV_TEMPLATE, ROUTING_HINTS_TEMPLATE } from './templates.ts';

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
      'SLACK_CHANNEL_ID',
      'SLACK_ALLOWED_USER_ID',
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

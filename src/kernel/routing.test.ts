import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.ts';
import type { CommandRunner } from './orca.ts';
import {
  GLOBAL_DEFAULT_AGENT,
  loadRoutingHints,
  parseRoutingHints,
  RepoAllowList,
  RoutingHintsError,
  routingInstructions,
  type RepoHint,
} from './routing.ts';

const hint = (name: string, overrides: Partial<RepoHint> = {}): RepoHint => ({
  name,
  description: `${name} description.`,
  aliases: [`${name}-alias`],
  keywords: [`${name}-keyword`],
  ...overrides,
});

const hintsJson = (repos: unknown[]): string => JSON.stringify({ repos });

/** Canned `orca repo list --json` payload (real CLI envelope shape). */
const registryJson = (repos: unknown[]): string =>
  JSON.stringify({ id: 'call-1', ok: true, result: { repos } });

const succeedWith =
  (stdout: string): CommandRunner =>
  () =>
    Promise.resolve({ stdout });

const failWith =
  (error: Error): CommandRunner =>
  () =>
    Promise.reject(error);

describe('parseRoutingHints', () => {
  it('requires one default, with an implicit default for a single repo', () => {
    expect(parseRoutingHints(hintsJson([hint('webapp')]))[0]?.default).toBe(true);
    expect(parseRoutingHints(hintsJson([hint('webapp', { default: true }), hint('sandbox')]))[0]?.default).toBe(true);
    expect(() => parseRoutingHints(hintsJson([hint('webapp'), hint('sandbox')]))).toThrow(/exactly one.*default/);
    expect(() => parseRoutingHints(hintsJson([hint('webapp', { default: true }), hint('sandbox', { default: true })]))).toThrow(/exactly one.*default/);
    expect(() => parseRoutingHints(hintsJson([{ ...hint('webapp'), default: 'yes' }]))).toThrow(/default must be a boolean/);
  });
  it('parses a valid document, preserving entry order', () => {
    const hints = parseRoutingHints(
      hintsJson([
        { name: 'webapp', default: true, description: 'The product.', aliases: ['fwd'], keywords: ['export'] },
        {
          name: 'sandbox',
          description: 'Sandbox.',
          aliases: [],
          keywords: ['one-shot'],
          defaultAgent: 'codex',
        },
      ]),
    );
    expect(hints.map((h) => h.name)).toEqual(['webapp', 'sandbox']);
    expect(hints[0]?.defaultAgent).toBeUndefined();
    expect(hints[1]?.defaultAgent).toBe('codex');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseRoutingHints('{ nope')).toThrow(RoutingHintsError);
  });

  it('rejects a missing or empty repos array', () => {
    expect(() => parseRoutingHints('{}')).toThrow(/non-empty "repos" array/);
    expect(() => parseRoutingHints(hintsJson([]))).toThrow(/non-empty "repos" array/);
  });

  it('collects every problem in one error, config-style', () => {
    expect(() =>
      parseRoutingHints(hintsJson([{ name: '', aliases: 'fwd', keywords: ['x'] }])),
    ).toThrow(/name must be a non-empty string.*description must be.*aliases must be an array/s);
  });

  it('rejects duplicate repo names', () => {
    expect(() => parseRoutingHints(hintsJson([hint('orca'), hint('orca')]))).toThrow(
      /duplicate repo "orca"/,
    );
  });

  it('rejects an unknown key — a typo must not silently drop a field', () => {
    expect(() =>
      parseRoutingHints(hintsJson([{ ...hint('orca'), defaultagent: 'codex' }])),
    ).toThrow(/unknown key "defaultagent"/);
  });

  it('rejects an agent outside claude/codex', () => {
    expect(() =>
      parseRoutingHints(hintsJson([{ ...hint('orca'), defaultAgent: 'gpt' }])),
    ).toThrow(/defaultAgent must be one of claude, codex/);
  });
});

describe('loadRoutingHints', () => {
  it('loads the shipped routing-hints.example.json — the example must stay valid', () => {
    const hints = loadRoutingHints(
      fileURLToPath(new URL('../../routing-hints.example.json', import.meta.url)),
    );
    expect(hints.map((h) => h.name)).toEqual(['webapp', 'sandbox']);
    // Issue #10: all-claude at the start — no per-repo default set.
    expect(hints.every((h) => h.defaultAgent === undefined)).toBe(true);
  });

  it('points a missing file at `orc init`, with the resolved path (issue #70)', () => {
    expect(() => loadRoutingHints('/nonexistent/routing-hints.json')).toThrow(RoutingHintsError);
    expect(() => loadRoutingHints('/nonexistent/routing-hints.json')).toThrow(
      /not found at \/nonexistent\/routing-hints\.json — run `orc init`/,
    );
  });

  it('prefixes a malformed file with its path — boot-fatal stays diagnosable', () => {
    const notJson = fileURLToPath(new URL('./routing.test.ts', import.meta.url));
    expect(() => loadRoutingHints(notJson)).toThrow(RoutingHintsError);
    expect(() => loadRoutingHints(notJson)).toThrow(/routing\.test\.ts: routing hints are not valid JSON/);
  });
});

describe('RepoAllowList', () => {
  const registry = registryJson([
    { id: 'uuid-webapp', displayName: 'webapp' },
    { id: 'uuid-legacy', displayName: 'legacy-app' },
  ]);
  const makeAllowList = (run: CommandRunner) =>
    new RepoAllowList({ hints: [hint('webapp')], logger: createLogger('silent'), run });

  it('allows a hinted, registered repo — by id, id: ref, or name', async () => {
    const allowList = makeAllowList(succeedWith(registry));
    await expect(allowList.check('uuid-webapp')).resolves.toEqual({ allowed: true });
    await expect(allowList.check('id:uuid-webapp')).resolves.toEqual({ allowed: true });
    await expect(allowList.check('webapp')).resolves.toEqual({ allowed: true });
  });

  it('denies a registered repo that has no hints entry (spec §7: hints = allow-list)', async () => {
    const verdict = await makeAllowList(succeedWith(registry)).check('id:uuid-legacy');
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { reason: string }).reason).toContain('routing-hints.json');
  });

  it('denies a ref that matches nothing in the registry', async () => {
    const verdict = await makeAllowList(succeedWith(registry)).check('id:uuid-invented');
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { reason: string }).reason).toContain('not a registered Orca repo');
  });

  it('never lets a typed ref match the other field — id:<name> is not a repo', async () => {
    const allowList = makeAllowList(succeedWith(registry));
    await expect(allowList.check('id:webapp')).resolves.toMatchObject({ allowed: false });
    await expect(allowList.check('name:uuid-webapp')).resolves.toMatchObject({
      allowed: false,
    });
  });

  it('denies a hinted repo that is not registered — hints alone do not delegate', async () => {
    const emptyRegistry = registryJson([]);
    const verdict = await makeAllowList(succeedWith(emptyRegistry)).check('webapp');
    expect(verdict).toMatchObject({ allowed: false });
  });

  it('denies a missing --repo ref, fail closed', async () => {
    const verdict = await makeAllowList(succeedWith(registry)).check(null);
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { reason: string }).reason).toContain('no --repo');
  });

  it('denies, fail closed, when Orca is unreachable', async () => {
    const verdict = await makeAllowList(failWith(new Error('spawn orca ENOENT'))).check(
      'id:uuid-webapp',
    );
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { reason: string }).reason).toContain('Orca runtime unavailable');
  });
});

describe('routingInstructions', () => {
  const hints = [
    hint('webapp', { default: true, aliases: ['fwd', 'the product'], keywords: ['export', 'metrics'] }),
    hint('sandbox', { defaultAgent: 'codex' }),
  ];
  const prompt = routingInstructions(hints);

  it('enumerates every hinted repo with description, aliases and keywords', () => {
    expect(prompt).toContain('*webapp* — webapp description.');
    expect(prompt).toContain('Aliases: fwd, the product.');
    expect(prompt).toContain('Keywords: export, metrics.');
    expect(prompt).toContain('*sandbox* — sandbox description.');
  });

  it('anchors on the living registry and the closed candidate set', () => {
    expect(prompt).toContain('orca repo list --json');
    expect(prompt).toContain('closed candidate set only');
    expect(prompt).toContain('allow-list');
  });

  it('shows the per-repo default agent, or the global default when unset', () => {
    expect(prompt).toContain(`Default agent: ${GLOBAL_DEFAULT_AGENT} (global default).`);
    expect(prompt).toContain('Default agent: codex.');
  });

  it('routes to the configured default without the old routing round trip', () => {
    expect(prompt).toContain('Route to *webapp* unless');
    expect(prompt).toContain('canonical name, alias or keyword');
    expect(prompt).toContain('one delegation per repo');
    expect(prompt).not.toContain('No repo I drive matches');
    expect(prompt).not.toContain('Go? (or name another repo/agent)');
    expect(prompt).not.toContain('Two repos could match:');
  });

  it('defines Question and Change with fixed briefs and continuity', () => {
    expect(prompt).toContain('in doubt, Question');
    expect(prompt).toContain('Question brief');
    expect(prompt).toContain('no file edits, commits, pushes or PRs');
    expect(prompt).toContain('Change brief');
    expect(prompt).toContain('/tdd');
    expect(prompt).toContain('/code-review before committing');
    expect(prompt).toContain('ready-for-review PR (not a draft)');
    expect(prompt).toContain('starts with the PR URL');
    expect(prompt).toContain('Question answer VERBATIM');
    expect(prompt).toContain('Never merge');
    expect(prompt).not.toContain('gh issue create');
  });

  it('states the agent precedence with claude as the global default', () => {
    expect(prompt).toMatch(/explicitly named[\s\S]*default agent from the hints[\s\S]*\*claude\*/);
  });

  it('spells out the dispatch sequence in order, with the #4 invariants', () => {
    expect(prompt).toMatch(
      /worktree create[\s\S]*terminal list[\s\S]*terminal wait[\s\S]*task-create[\s\S]*dispatch/,
    );
    expect(prompt).toContain('NEVER pass `--prompt`');
    expect(prompt).toContain('--inject');
    expect(prompt).toContain('NEVER pass `--from`');
    expect(prompt).toContain('--no-parent');
    // Step 4 renders from the protocol table too (ADR 0006), and the rule
    // is stated once for every orchestration command, not just the dispatch.
    expect(prompt).toContain(
      'orca orchestration task-create --spec "<fixed brief, filled in>" --task-title "<short>" --display-name "<worktree-name>" --json',
    );
    expect(prompt).toContain('NEVER pass `--from` yourself, on any of them');
  });

  it('tells the session the daemon owns the card and to end its turn after dispatch', () => {
    expect(prompt).toContain('never repeat the card');
    expect(prompt).toContain('end your turn');
  });

  it('pins option fidelity on the reply AND the terminal-send fallback (issue #50)', () => {
    expect(prompt).toContain("the daemon substitutes that option's exact text itself");
    expect(prompt).toContain('on the fallback send too');
    expect(prompt).toContain('the same option substitution applies to its --text');
  });
});

describe('routingInstructions announce line', () => {
  const hints: RepoHint[] = [
    { name: 'webapp', description: 'The web app.', aliases: [], keywords: [], default: true },
  ];

  it('asks for the kind and the repo without dictating the wording — the voice owns it', () => {
    const prompt = routingInstructions(hints);
    expect(prompt).toContain('Announce the kind and repo in one line before dispatch, in your own words');
    // A quoted template would beat any persona: the model copies it.
    expect(prompt).not.toContain('🔎 Question on');
    expect(prompt).not.toContain('🔧 Change on');
  });
});

describe('routingInstructions worker register', () => {
  const hints: RepoHint[] = [
    { name: 'webapp', description: 'The web app.', aliases: [], keywords: [], default: true },
  ];

  it('inlines the register in BOTH briefs — only the matching one is copied into --spec', () => {
    const prompt = routingInstructions(hints, 'REGISTER BLOCK');
    expect(prompt.match(/REGISTER BLOCK/g)).toHaveLength(2);
    const question = prompt.indexOf('### Question brief');
    const change = prompt.indexOf('### Change brief');
    expect(prompt.indexOf('REGISTER BLOCK')).toBeGreaterThan(question);
    expect(prompt.lastIndexOf('REGISTER BLOCK')).toBeGreaterThan(change);
  });

  it('leaves the briefs untouched when no register is configured', () => {
    expect(routingInstructions(hints)).toBe(routingInstructions(hints, undefined));
    expect(routingInstructions(hints)).not.toContain('Register for everything you send to Slack');
  });
});


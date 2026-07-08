import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.ts';
import type { CommandRunner } from './orca-health.ts';
import {
  GLOBAL_DEFAULT_AGENT,
  listRegistryRepos,
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
  it('parses a valid document, preserving entry order', () => {
    const hints = parseRoutingHints(
      hintsJson([
        { name: 'forwardly', description: 'The product.', aliases: ['fwd'], keywords: ['export'] },
        {
          name: 'scratch',
          description: 'Sandbox.',
          aliases: [],
          keywords: ['one-shot'],
          defaultAgent: 'codex',
        },
      ]),
    );
    expect(hints.map((h) => h.name)).toEqual(['forwardly', 'scratch']);
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
  it('loads the versioned routing-hints.json with the four initial repos (issue #18)', () => {
    const hints = loadRoutingHints(
      fileURLToPath(new URL('../routing-hints.json', import.meta.url)),
    );
    expect(hints.map((h) => h.name)).toEqual(['forwardly', 'orca', 'scratch', 'orchestrator']);
    // Issue #10: all-claude at the start — no per-repo default set.
    expect(hints.every((h) => h.defaultAgent === undefined)).toBe(true);
  });

  it('wraps an unreadable file in a RoutingHintsError', () => {
    expect(() => loadRoutingHints('/nonexistent/routing-hints.json')).toThrow(RoutingHintsError);
  });
});

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

describe('RepoAllowList', () => {
  const registry = registryJson([
    { id: 'uuid-forwardly', displayName: 'forwardly' },
    { id: 'uuid-legacy', displayName: 'legacy-app' },
  ]);
  const makeAllowList = (run: CommandRunner) =>
    new RepoAllowList({ hints: [hint('forwardly')], logger: createLogger('silent'), run });

  it('allows a hinted, registered repo — by id, id: ref, or name', async () => {
    const allowList = makeAllowList(succeedWith(registry));
    await expect(allowList.check('uuid-forwardly')).resolves.toEqual({ allowed: true });
    await expect(allowList.check('id:uuid-forwardly')).resolves.toEqual({ allowed: true });
    await expect(allowList.check('forwardly')).resolves.toEqual({ allowed: true });
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

  it('denies a hinted repo that is not registered — hints alone do not delegate', async () => {
    const emptyRegistry = registryJson([]);
    const verdict = await makeAllowList(succeedWith(emptyRegistry)).check('forwardly');
    expect(verdict).toMatchObject({ allowed: false });
  });

  it('denies a missing --repo ref, fail closed', async () => {
    const verdict = await makeAllowList(succeedWith(registry)).check(null);
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { reason: string }).reason).toContain('no --repo');
  });

  it('denies, fail closed, when Orca is unreachable', async () => {
    const verdict = await makeAllowList(failWith(new Error('spawn orca ENOENT'))).check(
      'id:uuid-forwardly',
    );
    expect(verdict).toMatchObject({ allowed: false });
    expect((verdict as { reason: string }).reason).toContain('Orca runtime unavailable');
  });
});

describe('routingInstructions', () => {
  const hints = [
    hint('forwardly', { aliases: ['fwd', 'the product'], keywords: ['export', 'metrics'] }),
    hint('scratch', { defaultAgent: 'codex' }),
  ];
  const prompt = routingInstructions(hints);

  it('enumerates every hinted repo with description, aliases and keywords', () => {
    expect(prompt).toContain('*forwardly* — forwardly description.');
    expect(prompt).toContain('Aliases: fwd, the product.');
    expect(prompt).toContain('Keywords: export, metrics.');
    expect(prompt).toContain('*scratch* — scratch description.');
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

  it('fixes the zero-match verbatim over the hinted names', () => {
    expect(prompt).toContain(
      'No repo I drive matches. I know: `forwardly`, `scratch`. Rephrase targeting one of them.',
    );
  });

  it('fixes the one-line conditional confirmation verbatim (issue #10 §4)', () => {
    expect(prompt).toContain(
      "→ I'm delegating on *<repo>* with *<agent>*. Go? (or name another repo/agent)",
    );
    expect(prompt).toContain('never two round trips');
  });

  it('states the agent precedence with claude as the global default', () => {
    expect(prompt).toMatch(/explicitly named[\s\S]*default agent from the hints[\s\S]*\*claude\*/);
  });

  it('stops at the routing decision — dispatch is the next slice', () => {
    expect(prompt).toContain('Do not run `orca worktree create` yet.');
  });
});

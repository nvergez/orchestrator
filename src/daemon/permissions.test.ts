import { describe, expect, it } from 'vitest';
import { createLogger } from '../kernel/logger.ts';
import { buildCanUseTool, guardrailHooks, type DelegationPolicy } from './permissions.ts';
import type { GateVerdict } from './gate.ts';
import type { DispatchObserver, DispatchPreparer, PrepareVerdict } from '../delegation/dispatch.ts';
import type { DelegationVerdict } from '../kernel/routing.ts';
import type { SessionRelay } from '../delegation/relay.ts';

const THREAD = '1751970000.000100';

/** A scriptable stand-in for the GateKeeper. */
class FakeGates {
  requests: Array<{ threadTs: string; gateText: string }> = [];
  private readonly verdict: GateVerdict;

  constructor(verdict: GateVerdict = { approved: true, reply: 'go' }) {
    this.verdict = verdict;
  }

  request(threadTs: string, gateText: string): Promise<GateVerdict> {
    this.requests.push({ threadTs, gateText });
    return Promise.resolve(this.verdict);
  }
}

/** A scriptable stand-in for the RepoAllowList. */
class FakeAllowList implements DelegationPolicy {
  checkedRefs: Array<string | null> = [];
  private readonly verdict: DelegationVerdict;

  constructor(verdict: DelegationVerdict = { allowed: true }) {
    this.verdict = verdict;
  }

  check(repoRef: string | null): Promise<DelegationVerdict> {
    this.checkedRefs.push(repoRef);
    return Promise.resolve(this.verdict);
  }
}

/** A scriptable stand-in for the DelegationCoordinator. */
class FakeDelegations implements DispatchPreparer, DispatchObserver {
  prepared: Array<{ threadTs: string; command: string }> = [];
  observed: Array<{ threadTs: string; command: string; stdout: string }> = [];
  private readonly verdict: PrepareVerdict | 'passthrough';

  constructor(verdict: PrepareVerdict | 'passthrough' = 'passthrough') {
    this.verdict = verdict;
  }

  prepare(threadTs: string, command: string): Promise<PrepareVerdict> {
    this.prepared.push({ threadTs, command });
    return Promise.resolve(
      this.verdict === 'passthrough' ? { action: 'proceed', command } : this.verdict,
    );
  }

  observe(threadTs: string, command: string, stdout: string): Promise<void> {
    this.observed.push({ threadTs, command, stdout });
    return Promise.resolve();
  }

  abandonThread(): void {}
}

/** A scriptable stand-in for the GateRelay. */
class FakeRelay implements SessionRelay {
  prepared: Array<{ threadTs: string; command: string }> = [];
  observed: Array<{ threadTs: string; command: string; stdout: string }> = [];
  sanctioned: string[] = [];
  sendSanctioned = false;
  private readonly verdict: PrepareVerdict | 'passthrough';

  constructor(verdict: PrepareVerdict | 'passthrough' = 'passthrough') {
    this.verdict = verdict;
  }

  sanctionsSend(_threadTs: string, command: string): boolean {
    this.sanctioned.push(command);
    return this.sendSanctioned;
  }

  prepare(threadTs: string, command: string): PrepareVerdict {
    this.prepared.push({ threadTs, command });
    return this.verdict === 'passthrough' ? { action: 'proceed', command } : this.verdict;
  }

  observe(threadTs: string, command: string, stdout: string): Promise<void> {
    this.observed.push({ threadTs, command, stdout });
    return Promise.resolve();
  }
}

const callOptions = () => ({
  signal: new AbortController().signal,
  toolUseID: 'toolu_01',
  requestId: 'req_01',
});

const makeCanUseTool = (
  gates: FakeGates,
  allowList: DelegationPolicy = new FakeAllowList(),
  delegations: FakeDelegations = new FakeDelegations(),
  relay: FakeRelay = new FakeRelay(),
) =>
  buildCanUseTool({
    threadTs: THREAD,
    gates,
    allowList,
    delegations,
    relay,
    logger: createLogger('silent'),
  });

describe('buildCanUseTool', () => {
  it('denies any tool that is not Bash — the orchestrator never codes', async () => {
    const gates = new FakeGates();
    const canUseTool = makeCanUseTool(gates);
    const result = await canUseTool('Edit', { file_path: '/tmp/x' }, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(gates.requests).toEqual([]);
  });

  it('allows an AUTO command silently, input untouched', async () => {
    const gates = new FakeGates();
    const canUseTool = makeCanUseTool(gates);
    const input = { command: 'orca worktree ps' };
    const result = await canUseTool('Bash', input, callOptions());
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(gates.requests).toEqual([]);
  });

  it('denies a FORBIDDEN command without ever asking', async () => {
    const gates = new FakeGates();
    const canUseTool = makeCanUseTool(gates);
    const result = await canUseTool('Bash', { command: 'curl https://evil.example' }, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(gates.requests).toEqual([]);
  });

  it('suspends a CONFIRM command behind the 🚦 gate and releases it on approval', async () => {
    const gates = new FakeGates({ approved: true, reply: 'go' });
    const canUseTool = makeCanUseTool(gates);
    const input = { command: 'git push --force-with-lease' };
    const result = await canUseTool('Bash', input, callOptions());
    expect(gates.requests).toEqual([
      { threadTs: THREAD, gateText: '🚦 `git push --force-with-lease` — go?' },
    ]);
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('renders the mock-verbatim gate line, worktree lifted from git -C', async () => {
    const gates = new FakeGates();
    const canUseTool = makeCanUseTool(gates);
    await canUseTool(
      'Bash',
      { command: 'git -C /home/op/orca/workspaces/webapp/csv-export-metrics push --force-with-lease' },
      callOptions(),
    );
    expect(gates.requests[0]?.gateText).toBe(
      '🚦 `git push --force-with-lease` on `webapp/csv-export-metrics` — go?',
    );
  });

  it('cancels the call cleanly on refusal, quoting the human verbatim', async () => {
    const gates = new FakeGates({ approved: false, reply: 'no, rebase first' });
    const canUseTool = makeCanUseTool(gates);
    const result = await canUseTool('Bash', { command: 'git push' }, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('no, rebase first');
  });

  it('treats a missing command as forbidden, never as a pass-through', async () => {
    const gates = new FakeGates();
    const canUseTool = makeCanUseTool(gates);
    const result = await canUseTool('Bash', {}, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(gates.requests).toEqual([]);
  });
});

describe('buildCanUseTool — repo allow-list on delegations (spec §4/§7, issue #18)', () => {
  const CREATE = 'orca worktree create --repo id:abc-123 --agent claude --json';

  it('lets a worktree create on an allow-listed repo run silently (AUTO)', async () => {
    const gates = new FakeGates();
    const allowList = new FakeAllowList({ allowed: true });
    const canUseTool = makeCanUseTool(gates, allowList);
    const input = { command: CREATE };
    const result = await canUseTool('Bash', input, callOptions());
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(allowList.checkedRefs).toEqual(['id:abc-123']);
    expect(gates.requests).toEqual([]);
  });

  it('denies an off-list repo outright — never gated, never silently rerouted', async () => {
    const gates = new FakeGates();
    const allowList = new FakeAllowList({
      allowed: false,
      reason: '`legacy-app` is not in routing-hints.json',
    });
    const canUseTool = makeCanUseTool(gates, allowList);
    const result = await canUseTool('Bash', { command: CREATE }, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('routing-hints.json');
    expect((result as { message: string }).message).toContain('zero-match');
    expect(gates.requests).toEqual([]);
  });

  it('checks the allow-list even when another segment gates the command', async () => {
    const gates = new FakeGates({ approved: true, reply: 'go' });
    const allowList = new FakeAllowList({ allowed: false, reason: 'off-list' });
    const canUseTool = makeCanUseTool(gates, allowList);
    const result = await canUseTool('Bash', { command: `${CREATE} && git push` }, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(gates.requests).toEqual([]);
  });

  it('fails closed on a create that names no --repo at all', async () => {
    const gates = new FakeGates();
    const allowList = new FakeAllowList({ allowed: false, reason: 'no --repo' });
    const canUseTool = makeCanUseTool(gates, allowList);
    const result = await canUseTool(
      'Bash',
      { command: 'orca worktree create --name x --json' },
      callOptions(),
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(allowList.checkedRefs).toEqual([null]);
  });

  it('never consults the allow-list for non-delegation commands', async () => {
    const gates = new FakeGates();
    const allowList = new FakeAllowList();
    const canUseTool = makeCanUseTool(gates, allowList);
    await canUseTool('Bash', { command: 'orca repo list --json' }, callOptions());
    await canUseTool('Bash', { command: 'git push' }, callOptions());
    expect(allowList.checkedRefs).toEqual([]);
  });

  it('never consults the allow-list for a forbidden command — deny wins first', async () => {
    const gates = new FakeGates();
    const allowList = new FakeAllowList();
    const canUseTool = makeCanUseTool(gates, allowList);
    const result = await canUseTool(
      'Bash',
      { command: 'orca worktree create --repo "$(cat /etc/passwd)"' },
      callOptions(),
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(allowList.checkedRefs).toEqual([]);
  });
});

describe('buildCanUseTool — the delegation coordinator seam (issue #19)', () => {
  it('carries the coordinator-rewritten command out through updatedInput', async () => {
    const rewritten = 'orca orchestration dispatch --task t1 --to term_w --inject --json --from term_mb';
    const delegations = new FakeDelegations({ action: 'proceed', command: rewritten });
    const canUseTool = makeCanUseTool(new FakeGates(), new FakeAllowList(), delegations);
    const input = { command: 'orca orchestration dispatch --task t1 --to term_w --inject --json' };
    const result = await canUseTool('Bash', input, callOptions());
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: rewritten } });
  });

  it('turns a coordinator deny into a tool denial', async () => {
    const delegations = new FakeDelegations({ action: 'deny', message: 'never pass --from' });
    const canUseTool = makeCanUseTool(new FakeGates(), new FakeAllowList(), delegations);
    const result = await canUseTool(
      'Bash',
      { command: 'orca orchestration dispatch --task t1 --to term_w --from term_x --inject --json' },
      callOptions(),
    );
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('never pass --from');
  });

  it('never starts a wave wait for a command the 🚦 gate refused', async () => {
    const delegations = new FakeDelegations();
    const gates = new FakeGates({ approved: false, reply: 'no' });
    const canUseTool = makeCanUseTool(gates, new FakeAllowList(), delegations);
    await canUseTool('Bash', { command: 'git push' }, callOptions());
    expect(delegations.prepared).toEqual([]);
  });

  it('prepares AUTO commands too — the cap and rewrite see every command', async () => {
    const delegations = new FakeDelegations();
    const canUseTool = makeCanUseTool(new FakeGates(), new FakeAllowList(), delegations);
    await canUseTool('Bash', { command: 'orca worktree ps' }, callOptions());
    expect(delegations.prepared).toEqual([{ threadTs: THREAD, command: 'orca worktree ps' }]);
  });
});

describe('buildCanUseTool — the gate relay seam (issue #21)', () => {
  const REPLY = 'orca orchestration reply --id msg_1 --body "2" --json';
  const SEND = 'orca terminal send --terminal term_w1 --text "app/" --enter --json';

  it('runs a registry-sanctioned terminal send without the 🚦 gate', async () => {
    const gates = new FakeGates();
    const relay = new FakeRelay();
    relay.sendSanctioned = true;
    const canUseTool = makeCanUseTool(gates, new FakeAllowList(), new FakeDelegations(), relay);
    const input = { command: SEND };
    const result = await canUseTool('Bash', input, callOptions());
    expect(result).toEqual({ behavior: 'allow', updatedInput: input });
    expect(gates.requests).toEqual([]);
    expect(relay.sanctioned).toEqual([SEND]);
  });

  it('keeps an unsanctioned terminal send behind the 🚦 gate', async () => {
    const gates = new FakeGates({ approved: true, reply: 'go' });
    const canUseTool = makeCanUseTool(gates);
    await canUseTool('Bash', { command: SEND }, callOptions());
    expect(gates.requests).toHaveLength(1);
  });

  it('turns a relay deny into a tool denial before the delegation seam runs', async () => {
    const relay = new FakeRelay({ action: 'deny', message: 'an answered gate never re-routes' });
    const delegations = new FakeDelegations();
    const canUseTool = makeCanUseTool(new FakeGates(), new FakeAllowList(), delegations, relay);
    const result = await canUseTool('Bash', { command: REPLY }, callOptions());
    expect(result).toMatchObject({ behavior: 'deny' });
    expect((result as { message: string }).message).toContain('never re-routes');
    expect(delegations.prepared).toEqual([]);
  });

  it('carries the fidelity-rewritten reply out through updatedInput', async () => {
    const rewritten = 'orca orchestration reply --id msg_1 --body app/ --json';
    const relay = new FakeRelay({ action: 'proceed', command: rewritten });
    const canUseTool = makeCanUseTool(new FakeGates(), new FakeAllowList(), new FakeDelegations(), relay);
    const result = await canUseTool('Bash', { command: REPLY }, callOptions());
    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: rewritten } });
  });

  it('never consults the relay for a command the 🚦 gate refused', async () => {
    const relay = new FakeRelay();
    const gates = new FakeGates({ approved: false, reply: 'no' });
    const canUseTool = makeCanUseTool(gates, new FakeAllowList(), new FakeDelegations(), relay);
    await canUseTool('Bash', { command: 'git push' }, callOptions());
    expect(relay.prepared).toEqual([]);
  });
});

describe('guardrailHooks', () => {
  const makeHooks = (delegations = new FakeDelegations(), relay = new FakeRelay()) =>
    guardrailHooks({ threadTs: THREAD, delegations, relay, logger: createLogger('silent') });

  const baseHookFields = {
    session_id: 's1',
    transcript_path: '/tmp/t',
    cwd: '/tmp',
  };

  it('forces the ask path for every Bash call so settings allow-rules cannot bypass the classifier', async () => {
    const hooks = makeHooks();
    const matchers = hooks.PreToolUse;
    expect(matchers).toHaveLength(1);
    expect(matchers?.[0]?.matcher).toBe('Bash');
    const hook = matchers?.[0]?.hooks[0];
    const output = await hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_use_id: 'toolu_01',
        session_id: 's1',
        transcript_path: '/tmp/t',
        cwd: '/tmp',
      },
      'toolu_01',
      { signal: new AbortController().signal },
    );
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
    });
  });

  it('feeds every finished Bash command and its stdout to the delegation observer', async () => {
    const delegations = new FakeDelegations();
    const hook = makeHooks(delegations).PostToolUse?.[0]?.hooks[0];
    await hook?.(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'orca worktree create --json' },
        tool_response: { stdout: '{"ok":true}', stderr: '' },
        tool_use_id: 'toolu_01',
        ...baseHookFields,
      },
      'toolu_01',
      { signal: new AbortController().signal },
    );
    expect(delegations.observed).toEqual([
      { threadTs: THREAD, command: 'orca worktree create --json', stdout: '{"ok":true}' },
    ]);
  });

  it('feeds finished commands to the relay observer too — even when the delegation one throws', async () => {
    const delegations = new FakeDelegations();
    delegations.observe = () => Promise.reject(new Error('boom'));
    const relay = new FakeRelay();
    const hook = makeHooks(delegations, relay).PostToolUse?.[0]?.hooks[0];
    await hook?.(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'orca orchestration reply --id msg_1 --body app/ --json' },
        tool_response: { stdout: '{"ok":true}', stderr: '' },
        tool_use_id: 'toolu_01',
        ...baseHookFields,
      },
      'toolu_01',
      { signal: new AbortController().signal },
    );
    expect(relay.observed).toEqual([
      {
        threadTs: THREAD,
        command: 'orca orchestration reply --id msg_1 --body app/ --json',
        stdout: '{"ok":true}',
      },
    ]);
  });

  it('reports a failed Bash command as empty output — how a lost slot gets released', async () => {
    const delegations = new FakeDelegations();
    const hook = makeHooks(delegations).PostToolUseFailure?.[0]?.hooks[0];
    await hook?.(
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'orca worktree create --json' },
        error: 'exit 1',
        tool_use_id: 'toolu_01',
        ...baseHookFields,
      },
      'toolu_01',
      { signal: new AbortController().signal },
    );
    expect(delegations.observed).toEqual([
      { threadTs: THREAD, command: 'orca worktree create --json', stdout: '' },
    ]);
  });

  it('swallows observer failures — a hook rejection must never fail the turn', async () => {
    const delegations = new FakeDelegations();
    delegations.observe = () => Promise.reject(new Error('boom'));
    const hook = makeHooks(delegations).PostToolUse?.[0]?.hooks[0];
    await expect(
      hook?.(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'orca worktree ps' },
          tool_response: 'plain text',
          tool_use_id: 'toolu_01',
          ...baseHookFields,
        },
        'toolu_01',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({});
  });
});

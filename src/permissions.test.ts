import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';
import { buildCanUseTool, guardrailHooks } from './permissions.ts';
import type { GateVerdict } from './gate.ts';

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

const callOptions = () => ({
  signal: new AbortController().signal,
  toolUseID: 'toolu_01',
  requestId: 'req_01',
});

const makeCanUseTool = (gates: FakeGates) =>
  buildCanUseTool({ threadTs: THREAD, gates, logger: createLogger('silent') });

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
      { command: 'git -C /home/dev/orca/workspaces/forwardly/csv-export-metrics push --force-with-lease' },
      callOptions(),
    );
    expect(gates.requests[0]?.gateText).toBe(
      '🚦 `git push --force-with-lease` on `forwardly/csv-export-metrics` — go?',
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

describe('guardrailHooks', () => {
  it('forces the ask path for every Bash call so settings allow-rules cannot bypass the classifier', async () => {
    const hooks = guardrailHooks();
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
});

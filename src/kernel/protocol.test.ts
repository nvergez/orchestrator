import { describe, expect, it } from 'vitest';
import {
  CREATE_STEP,
  DISPATCH_STEP,
  MAILBOX_FROM_RULE,
  TASK_CREATE_STEP,
  flagViolation,
  stepCommandTemplate,
  stepWarnings,
} from './protocol.ts';

const TASK_CREATE_TOKENS = [
  'orca', 'orchestration', 'task-create',
  '--spec', 'Request: add retries',
  '--task-title', 'Retry timeout',
  '--display-name', 'webapp-retry-timeout',
  '--json',
];

const CREATE_TOKENS = [
  'orca', 'worktree', 'create',
  '--repo', 'id:uuid-webapp',
  '--name', 'webapp-84-csv-export',
  '--agent', 'claude',
  '--comment', 'change',
  '--no-parent', '--json',
];

const DISPATCH_TOKENS = [
  'orca', 'orchestration', 'dispatch',
  '--task', 'task_3f81',
  '--to', 'term_w1',
  '--inject', '--json',
];

describe('stepCommandTemplate', () => {
  it('renders the create step — fixed args, then the required flags with placeholders', () => {
    expect(stepCommandTemplate(CREATE_STEP)).toBe(
      'orca worktree create --repo id:<repoId> --name <repo>-<slug> ' +
        '--agent <agent> --comment <question|change> --no-parent --json',
    );
  });

  it('renders the dispatch step with --inject and --json', () => {
    expect(stepCommandTemplate(DISPATCH_STEP)).toBe(
      'orca orchestration dispatch --task <taskId> --to <handle> --inject --json',
    );
  });

  it('renders the task-create step — the brief flags fixed, then --json', () => {
    expect(stepCommandTemplate(TASK_CREATE_STEP)).toBe(
      'orca orchestration task-create --spec "<fixed brief, filled in>" ' +
        '--task-title "<short>" --display-name "<worktree-name>" --json',
    );
  });
});

describe('stepWarnings', () => {
  it('warns off every forbidden flag with its reason', () => {
    expect(stepWarnings(CREATE_STEP)).toContain('NEVER pass `--prompt`');
    expect(stepWarnings(CREATE_STEP)).toContain('dispatch --inject');
    expect(stepWarnings(DISPATCH_STEP)).toContain('NEVER pass `--from`');
    expect(stepWarnings(DISPATCH_STEP)).toContain('thread mailbox');
    // The one rule every orchestration command shares (ADR 0006).
    expect(stepWarnings(TASK_CREATE_STEP)).toBe(stepWarnings(DISPATCH_STEP));
  });
});

describe('flagViolation', () => {
  it('holds on a command carrying exactly the protocol flags', () => {
    expect(flagViolation(CREATE_STEP, CREATE_TOKENS)).toBeUndefined();
    expect(flagViolation(DISPATCH_STEP, DISPATCH_TOKENS)).toBeUndefined();
    expect(flagViolation(TASK_CREATE_STEP, TASK_CREATE_TOKENS)).toBeUndefined();
  });

  it('denies a task-create naming its own sender, or missing --json (ADR 0006)', () => {
    expect(flagViolation(TASK_CREATE_STEP, [...TASK_CREATE_TOKENS, '--from', 'term_rogue'])).toContain(
      MAILBOX_FROM_RULE.why,
    );
    expect(
      flagViolation(TASK_CREATE_STEP, TASK_CREATE_TOKENS.filter((token) => token !== '--json')),
    ).toContain('`orca orchestration task-create` must carry --json');
  });

  it('denies a forbidden flag with the table reason', () => {
    const message = flagViolation(CREATE_STEP, [...CREATE_TOKENS, '--prompt', 'do it']);
    expect(message).toContain('never pass --prompt');
    expect(message).toContain('--inject');
  });

  it('denies a missing required flag, naming the step and the flag', () => {
    const message = flagViolation(
      DISPATCH_STEP,
      DISPATCH_TOKENS.filter((token) => token !== '--inject'),
    );
    expect(message).toContain('`orca orchestration dispatch` must carry --inject');
    expect(message).toContain('worker_done');
  });

  it('recognizes the --flag=value spelling of a required flag', () => {
    const tokens = CREATE_TOKENS.filter((token, i) => token !== '--issue' && CREATE_TOKENS[i - 1] !== '--issue');
    expect(flagViolation(CREATE_STEP, [...tokens, '--issue=84'])).toBeUndefined();
  });
});

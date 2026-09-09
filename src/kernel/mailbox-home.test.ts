import { describe, expect, it } from 'vitest';
import { describeMailboxHome, mailboxHomeResolver, MailboxHomeError, resolveMailboxHome } from './mailbox-home.ts';
import type { CommandRunner } from './orca.ts';

const CHECKOUT = '/home/op/projects/webapp';

/** An Orca that lists two checkouts; `worktree show` on anything else is `selector_not_found`. */
const orca = (worktrees: string[] = [CHECKOUT, '/home/op/projects/sandbox']) => {
  const calls: string[][] = [];
  const run: CommandRunner = (_command, args) => {
    calls.push(args);
    if (args[0] === 'repo' && args[1] === 'list') {
      return Promise.resolve({
        stdout: JSON.stringify({
          id: 'r',
          ok: true,
          result: {
            repos: [
              { id: 'u1', displayName: 'webapp', path: CHECKOUT },
              { id: 'u2', displayName: 'scratch', kind: 'folder', path: '/home/op/scratch' },
            ],
          },
        }),
      });
    }
    const path = (args[args.indexOf('--worktree') + 1] ?? '').replace(/^path:/, '');
    if (worktrees.includes(path)) {
      return Promise.resolve({ stdout: JSON.stringify({ id: 'w', ok: true, result: { worktree: { id: `u::${path}`, path } } }) });
    }
    return Promise.reject(
      Object.assign(new Error('Command failed: orca worktree show'), {
        stdout: JSON.stringify({ id: 'w', ok: false, error: { code: 'selector_not_found', message: 'selector_not_found' } }),
      }),
    );
  };
  return { run, calls };
};

describe('resolveMailboxHome (ADR 0007)', () => {
  it('honors an explicit ORCHESTRATOR_MAILBOX_WORKTREE that Orca lists — and refuses one it does not', async () => {
    await expect(
      resolveMailboxHome(orca().run, { configured: '/home/op/projects/sandbox', cwd: '/home/op', defaultRepo: 'webapp' }),
    ).resolves.toEqual({ path: '/home/op/projects/sandbox', source: 'configured' });

    await expect(
      resolveMailboxHome(orca().run, { configured: '/srv/nowhere', cwd: CHECKOUT, defaultRepo: 'webapp' }),
    ).rejects.toThrow(MailboxHomeError);
    await expect(
      resolveMailboxHome(orca().run, { configured: '/srv/nowhere', cwd: CHECKOUT, defaultRepo: 'webapp' }),
    ).rejects.toThrow(/ORCHESTRATOR_MAILBOX_WORKTREE=\/srv\/nowhere is not a worktree Orca lists/);
  });

  it('takes a checkout cwd — the dev instance run from its own worktree', async () => {
    await expect(resolveMailboxHome(orca().run, { cwd: CHECKOUT, defaultRepo: 'webapp' })).resolves.toEqual({
      path: CHECKOUT,
      source: 'cwd',
    });
  });

  it('falls back to the default repo checkout when the cwd is no worktree — the packaged daemon', async () => {
    const { run, calls } = orca();
    await expect(resolveMailboxHome(run, { cwd: '/home/op', defaultRepo: 'webapp' })).resolves.toEqual({
      path: CHECKOUT,
      source: 'default-repo',
      repo: 'webapp',
    });
    expect(calls.map((args) => args.slice(0, 2).join(' '))).toEqual(['worktree show', 'repo list', 'worktree show']);
  });

  it('names what failed when nothing hosts the mailboxes, with the fix', async () => {
    await expect(resolveMailboxHome(orca([]).run, { cwd: '/home/op', defaultRepo: 'webapp' })).rejects.toThrow(
      /\/home\/op is not one, and the default repo "webapp" has no registered checkout — set ORCHESTRATOR_MAILBOX_WORKTREE/,
    );
    await expect(resolveMailboxHome(orca().run, { cwd: '/home/op' })).rejects.toThrow(/no default repo is configured/);
    await expect(resolveMailboxHome(orca().run, { cwd: '/home/op', defaultRepo: 'unknown' })).rejects.toThrow(
      /"unknown" has no registered checkout/,
    );
  });

  it('lets an unreachable runtime throw as itself — not a configuration error', async () => {
    const down: CommandRunner = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const failure = resolveMailboxHome(down, { cwd: '/home/op', defaultRepo: 'webapp' });
    await expect(failure).rejects.toThrow(/ECONNREFUSED/);
    await expect(failure).rejects.not.toBeInstanceOf(MailboxHomeError);
  });
});

describe('describeMailboxHome', () => {
  it('says where and why, per source', () => {
    expect(describeMailboxHome({ path: '/a', source: 'configured' })).toBe('/a (ORCHESTRATOR_MAILBOX_WORKTREE)');
    expect(describeMailboxHome({ path: '/b', source: 'cwd' })).toBe("/b (the daemon's working directory)");
    expect(describeMailboxHome({ path: '/c', source: 'default-repo', repo: 'webapp' })).toBe('/c (default repo "webapp" checkout)');
  });
});

describe('mailboxHomeResolver', () => {
  it('resolves once, logs the home, remembers a success and retries after a failure', async () => {
    const logs: string[] = [];
    const logger = { info: (_fields: object, message: string) => { logs.push(message); } };
    let orcaUp = false;
    const { run, calls } = orca();
    const flaky: CommandRunner = (command, args) =>
      orcaUp ? run(command, args) : Promise.reject(new Error('connect ECONNREFUSED'));
    const resolve = mailboxHomeResolver(flaky, { cwd: '/home/op', defaultRepo: 'webapp' }, logger);

    await expect(resolve()).rejects.toThrow(/ECONNREFUSED/);
    expect(logs).toEqual([]);

    orcaUp = true;
    await expect(resolve()).resolves.toBe(CHECKOUT);
    await expect(resolve()).resolves.toBe(CHECKOUT);
    expect(logs).toEqual([`thread mailboxes live in ${CHECKOUT} (default repo "webapp" checkout)`]);
    expect(calls.filter((args) => args[0] === 'repo')).toHaveLength(1);
  });
});

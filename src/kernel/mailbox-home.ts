import { isOrcaWorktree, listRegistryRepos, type CommandRunner } from './orca.ts';

/**
 * Where the thread mailbox terminals live (ADR 0007). A mailbox is an Orca
 * terminal, so it needs an Orca worktree to be created in — and the
 * packaged daemon runs from no checkout at all (its systemd unit sets no
 * WorkingDirectory, so `process.cwd()` is the home dir, which Orca refuses
 * with `selector_not_found`). Resolution, strongest first:
 *
 * 1. `ORCHESTRATOR_MAILBOX_WORKTREE` — the operator's explicit choice; a
 *    value Orca does not list is a configuration error, never silently
 *    replaced;
 * 2. the daemon's working directory when it IS an Orca worktree — the
 *    checkout-run daemon of ADR 0003's dev instance;
 * 3. the default repo's registered checkout — the one worktree every
 *    install has, since routing hints must mark a default (spec §4).
 *
 * Resolved lazily at the first mailbox and remembered on success: Orca
 * may be down at boot (spec §10), and a failed resolution must retry, not
 * pin a bad path for the daemon's lifetime.
 */

export interface MailboxHomeCandidates {
  /** `ORCHESTRATOR_MAILBOX_WORKTREE`, when set. */
  configured?: string;
  cwd: string;
  /** The routing hints' default repo name, when the hints loaded. */
  defaultRepo?: string;
}

export interface MailboxHome {
  path: string;
  source: 'configured' | 'cwd' | 'default-repo';
  /** The default repo the path came from, for the `default-repo` source. */
  repo?: string;
}

/** No candidate is an Orca worktree — the message says which and the fix. */
export class MailboxHomeError extends Error {}

export async function resolveMailboxHome(
  run: CommandRunner,
  candidates: MailboxHomeCandidates,
): Promise<MailboxHome> {
  const { configured, cwd, defaultRepo } = candidates;
  if (configured !== undefined) {
    if (await isOrcaWorktree(run, configured)) return { path: configured, source: 'configured' };
    throw new MailboxHomeError(
      `ORCHESTRATOR_MAILBOX_WORKTREE=${configured} is not a worktree Orca lists — point it at ` +
        'a registered worktree path (`orca worktree list --json`), or unset it to fall back to ' +
        "the default repo's checkout",
    );
  }
  if (await isOrcaWorktree(run, cwd)) return { path: cwd, source: 'cwd' };
  if (defaultRepo !== undefined) {
    const repo = (await listRegistryRepos(run)).find((candidate) => candidate.name === defaultRepo);
    if (repo?.path !== undefined && (await isOrcaWorktree(run, repo.path))) {
      return { path: repo.path, source: 'default-repo', repo: repo.name };
    }
  }
  throw new MailboxHomeError(
    `no Orca worktree to host the thread mailboxes: ${cwd} is not one, and ` +
      (defaultRepo === undefined
        ? 'no default repo is configured'
        : `the default repo "${defaultRepo}" has no registered checkout`) +
      ' — set ORCHESTRATOR_MAILBOX_WORKTREE to a registered Orca worktree path',
  );
}

/** The resolved home as one human line — the boot log and `orc doctor`. */
export function describeMailboxHome(home: MailboxHome): string {
  switch (home.source) {
    case 'configured':
      return `${home.path} (ORCHESTRATOR_MAILBOX_WORKTREE)`;
    case 'cwd':
      return `${home.path} (the daemon's working directory)`;
    case 'default-repo':
      return `${home.path} (default repo "${home.repo}" checkout)`;
  }
}

/** What the resolver needs from a pino logger. */
export interface MailboxHomeLogger {
  info(fields: object, message: string): void;
}

/**
 * The delegation coordinator's seam: resolves on first use, remembers a
 * success for the daemon's lifetime (the home never moves under a running
 * daemon), and lets a failure throw — the coordinator turns it into the
 * ⚠️ line — so the next mailbox asks again.
 */
export function mailboxHomeResolver(
  run: CommandRunner,
  candidates: MailboxHomeCandidates,
  logger: MailboxHomeLogger,
): () => Promise<string> {
  let resolved: string | undefined;
  return async () => {
    if (resolved !== undefined) return resolved;
    const home = await resolveMailboxHome(run, candidates);
    resolved = home.path;
    logger.info({ path: home.path, source: home.source }, `thread mailboxes live in ${describeMailboxHome(home)}`);
    return resolved;
  };
}

import type { DelegationView } from '../api';
import { ago, durationSince } from '../lib/time';
import { Badge } from './ui/badge';
import { listRow } from './ui/row';

/** Worktree identity, with the delivered PRs first and a cited issue if any. */
export function DelegationRef({ delegation }: { delegation: DelegationView }) {
  const links = [
    ...delegation.prLinks.map((pr) => ({ url: pr.url, label: `PR ${pr.label}` })),
    ...(delegation.issueUrl === undefined ? [] : [{ url: delegation.issueUrl, label: 'Issue' }]),
  ];
  return (
    <>
      <span className="font-medium">{delegation.reference}</span>
      <Badge>{delegation.kind === 'question' ? '🔎 Question' : 'Change'}</Badge>
      {links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-xs font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          {link.label}
        </a>
      ))}
    </>
  );
}

/**
 * One in-flight delegation inside a session card. Scans left to right:
 * identity, then status, then liveness metadata pinned to the right edge.
 */
export function DelegationRow({ delegation, asOf }: { delegation: DelegationView; asOf: string }) {
  return (
    <li className={listRow}>
      <DelegationRef delegation={delegation} />
      {delegation.agent !== null && <Badge variant="accent">{delegation.agent}</Badge>}
      {delegation.title !== null && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={delegation.title}>
          {delegation.title}
        </span>
      )}
      <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
        in flight {durationSince(delegation.dispatchedAt, asOf)}
        {' · '}
        {delegation.lastBusAt === null
          ? 'no bus signal yet'
          : `last bus ${ago(delegation.lastBusAt, asOf)}`}
      </span>
    </li>
  );
}

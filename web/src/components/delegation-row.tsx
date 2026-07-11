import type { DelegationView } from '../api';
import { ago, durationSince } from '../lib/time';
import { Badge } from './ui/badge';
import { listRow } from './ui/row';

/** `repo#84` as a GitHub link when the registry could derive one, plain text otherwise. */
export function IssueRef({ delegation }: { delegation: DelegationView }) {
  const label =
    delegation.repo !== null && delegation.issueNumber !== null
      ? `${delegation.repo}#${delegation.issueNumber}`
      : (delegation.worktreeName ?? delegation.dispatchId);
  if (delegation.issueUrl === undefined) {
    return <span className="font-medium">{label}</span>;
  }
  return (
    <a
      href={delegation.issueUrl}
      target="_blank"
      rel="noreferrer"
      className="rounded-xs font-medium text-accent underline-offset-2 hover:underline"
    >
      {label}
    </a>
  );
}

/**
 * One in-flight delegation inside a session card. Scans left to right:
 * identity, then status, then liveness metadata pinned to the right edge.
 */
export function DelegationRow({ delegation, asOf }: { delegation: DelegationView; asOf: string }) {
  return (
    <li className={listRow}>
      <IssueRef delegation={delegation} />
      {delegation.agent !== null && <Badge variant="accent">{delegation.agent}</Badge>}
      {delegation.worktreeName !== null && (
        <span className="font-mono text-2xs text-muted-foreground">{delegation.worktreeName}</span>
      )}
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

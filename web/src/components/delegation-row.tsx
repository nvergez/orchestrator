import type { DelegationView } from '../api';
import { ago, durationSince } from '../lib/time';
import { Badge } from './ui/badge';

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
      className="font-medium text-accent underline-offset-2 hover:underline"
    >
      {label}
    </a>
  );
}

/** One in-flight delegation inside a session card. */
export function DelegationRow({ delegation, asOf }: { delegation: DelegationView; asOf: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border py-2 text-sm first:border-t-0">
      <IssueRef delegation={delegation} />
      {delegation.agent !== null && <Badge variant="accent">{delegation.agent}</Badge>}
      {delegation.worktreeName !== null && (
        <span className="font-mono text-xs text-muted-foreground">{delegation.worktreeName}</span>
      )}
      {delegation.title !== null && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={delegation.title}>
          {delegation.title}
        </span>
      )}
      <span className="ml-auto text-xs text-muted-foreground">
        in flight {durationSince(delegation.dispatchedAt, asOf)}
        {' · '}
        {delegation.lastBusAt === null
          ? 'no bus signal yet'
          : `last bus ${ago(delegation.lastBusAt, asOf)}`}
      </span>
    </li>
  );
}

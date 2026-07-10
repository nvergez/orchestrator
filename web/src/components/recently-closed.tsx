import type { ClosedSessionView, DelegationView } from '../api';
import { ago } from '../lib/time';
import { IssueRef } from './delegation-row';
import { Badge } from './ui/badge';

/**
 * The muted history strip: the page is never meaninglessly blank, and a
 * just-failed delegation stays in sight. Failed rows keep their critical
 * badge — muting the section must never mute a failure.
 */
export function RecentlyClosed({
  delegations,
  sessions,
  asOf,
}: {
  delegations: DelegationView[];
  sessions: ClosedSessionView[];
  asOf: string;
}) {
  if (delegations.length === 0 && sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing closed in the last 48 h.</p>;
  }
  return (
    <div className="space-y-1 text-muted-foreground">
      <ul>
        {delegations.map((delegation) => (
          <li
            key={delegation.dispatchId}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border py-2 text-sm first:border-t-0"
          >
            {delegation.status === 'failed' ? (
              <Badge variant="critical">✗ failed</Badge>
            ) : (
              <Badge variant="good">✓ completed</Badge>
            )}
            <IssueRef delegation={delegation} />
            {delegation.title !== null && (
              <span className="min-w-0 flex-1 truncate" title={delegation.title}>
                {delegation.title}
              </span>
            )}
            {delegation.closedAt !== null && (
              <span className="ml-auto text-xs">closed {ago(delegation.closedAt, asOf)}</span>
            )}
          </li>
        ))}
        {sessions.map((session) => (
          <li
            key={session.threadTs}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border py-2 text-sm first:border-t-0"
          >
            <Badge>session closed</Badge>
            <span className="font-mono text-xs">thread {session.threadTs}</span>
            <span className="ml-auto text-xs">
              {session.turnCount} turn{session.turnCount === 1 ? '' : 's'}
              {' · '}${session.costUsdTotal.toFixed(2)}
              {' · '}closed {ago(session.closedAt, asOf)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

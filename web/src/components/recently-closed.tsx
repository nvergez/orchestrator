import type { ClosedSessionView, DelegationView } from '../api';
import { ago } from '../lib/time';
import { IssueRef } from './delegation-row';
import { Badge } from './ui/badge';
import { listRow } from './ui/row';

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
    return (
      <p className="text-sm text-muted-foreground">
        Nothing closed in the last 48 h — quiet on the wire.
      </p>
    );
  }
  return (
    <div className="text-muted-foreground">
      <ul>
        {delegations.map((delegation) => (
          <li key={delegation.dispatchId} className={`animate-enter ${listRow}`}>
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
              <span className="ml-auto text-2xs tabular-nums">
                closed {ago(delegation.closedAt, asOf)}
              </span>
            )}
          </li>
        ))}
        {sessions.map((session) => (
          <li key={`${session.channelId}:${session.threadTs}`} className={`animate-enter ${listRow}`}>
            <Badge>◌ session closed</Badge>
            <span className="font-mono text-2xs">thread {session.threadTs}</span>
            <span className="ml-auto text-2xs tabular-nums">
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

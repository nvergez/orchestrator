import type { SessionCardView } from '../api';
import { ago } from '../lib/time';
import { DelegationRow } from './delegation-row';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

const STATUS_BADGE = {
  open: { variant: 'good', label: '● open' },
  closed: { variant: 'warning', label: '◌ closed, work in flight' },
  unknown: { variant: 'warning', label: '? no session row' },
} as const;

export function SessionCard({ session, asOf }: { session: SessionCardView; asOf: string }) {
  const status = STATUS_BADGE[session.status];
  return (
    <Card className="animate-enter">
      <CardHeader className="flex-row flex-wrap items-baseline gap-x-3">
        <CardTitle className="font-mono font-medium">
          <span className="text-muted-foreground">channel</span> {session.channelId ?? 'unknown'}
          <span className="text-muted-foreground"> · thread</span> {session.threadTs}
        </CardTitle>
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="ml-auto text-2xs text-muted-foreground tabular-nums">
          {session.turnCount} turn{session.turnCount === 1 ? '' : 's'}
          {' · '}${session.costUsdTotal.toFixed(2)}
          {session.lastActivityAt !== null && ` · active ${ago(session.lastActivityAt, asOf)}`}
          {session.rootUser !== null && ` · opened by ${session.rootUser}`}
        </span>
      </CardHeader>
      <CardContent>
        {session.delegations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No delegations in flight.</p>
        ) : (
          <ul>
            {session.delegations.map((delegation) => (
              <DelegationRow key={delegation.dispatchId} delegation={delegation} asOf={asOf} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

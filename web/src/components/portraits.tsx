import type { MemoryState } from '../api';
import { ago } from '../lib/time';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';

/**
 * What the bot believes about the team (issue #120), read-only: the page
 * never writes anything (ADR 0002), so there is no delete control here and
 * there never will be — `forget <id>` in the thread is the way out, and the
 * id shown beside each memory is the one to use.
 *
 * Dates are absolute-in-storage and relative here for the same reason the
 * injected block renders them relative: "3 days ago" is how a person holds a
 * memory. The pass's spend sits in its own line, never in a session's cost.
 */
export function Portraits({ memory, asOf }: { memory: MemoryState; asOf: string }) {
  if (!memory.present) {
    return (
      <p className="text-sm text-muted-foreground">
        This database predates per-person memory — nothing to show until the daemon writes its
        first portrait.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <PassActivity memory={memory} asOf={asOf} />
      {memory.portraits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {memory.recentPasses.length === 0
            ? 'No portraits yet — no memory pass has run against this database.'
            : 'No portraits yet. Most threads are work and leave nothing behind — that is the ordinary outcome, not a fault.'}
        </p>
      ) : (
        memory.portraits.map((portrait) => (
          <Card key={portrait.userId} className="animate-enter">
            <CardHeader>
              <CardTitle className="font-mono">{portrait.userId}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {portrait.memories.map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                  <code className="font-mono text-2xs text-muted-foreground">{entry.id}</code>
                  <Badge variant={entry.nature === 'durable' ? 'accent' : 'neutral'}>
                    {entry.nature === 'durable' ? 'durable fact' : 'moment'}
                  </Badge>
                  <span className="min-w-0 flex-1">{entry.text}</span>
                  <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                    {ago(entry.createdAt, asOf)}
                    {entry.recurrenceCount > 1 && ` · seen ×${entry.recurrenceCount}`}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

/** The pass's own ledger: what it did lately, and what it has cost so far. */
function PassActivity({ memory, asOf }: { memory: MemoryState; asOf: string }) {
  const last = memory.recentPasses[0];
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      <span>
        Memory passes cost{' '}
        <span className="font-mono tabular-nums">${memory.passCostUsdTotal.toFixed(2)}</span> in
        total — billed apart from every session.
      </span>
      {last !== undefined && (
        <span>
          Last pass {ago(last.ranAt, asOf)}: {PASS_OUTCOMES[last.outcome]}
          {last.dropped > 0 && `, ${last.dropped} record${last.dropped === 1 ? '' : 's'} dropped`}.
        </span>
      )}
    </p>
  );
}

const PASS_OUTCOMES: Record<MemoryState['recentPasses'][number]['outcome'], string> = {
  wrote: 'wrote something',
  empty: 'nothing worth keeping',
  failed: 'failed, will retry',
  abandoned: 'given up on after repeated failures',
};

import type { OverviewStats } from '../lib/stats';
import { cn } from '../lib/utils';

/**
 * Four glanceable tiles under the header, derived purely from the snapshot
 * the sections below already render — the strip may summarize, never
 * disagree. The attention tile is the only one allowed a status color,
 * and only when it has something to say.
 */
export function OverviewStrip({ stats }: { stats: OverviewStats }) {
  const closedSub = `${stats.closedSessions} session${stats.closedSessions === 1 ? '' : 's'} · $${stats.closedCostUsd.toFixed(2)}`;
  return (
    <section aria-label="Overview" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Open sessions" value={stats.openSessions} />
      <StatTile label="Delegations in flight" value={stats.delegationsInFlight} />
      <StatTile
        label="Needs attention"
        value={stats.needsAttention}
        tone={stats.needsAttention > 0 ? 'warning' : 'default'}
        sub={stats.needsAttention > 0 ? '⚠ waiting on you' : 'all quiet'}
      />
      <StatTile
        label="Closed · last 48 h"
        value={stats.closedDelegations + stats.closedSessions}
        sub={closedSub}
      />
    </section>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-card px-4 py-3 shadow-lift',
        tone === 'warning' ? 'border-status-warning/45' : 'border-border/80',
      )}
    >
      <div className="text-2xs font-medium tracking-[0.08em] uppercase text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold leading-none tabular-nums',
          tone === 'warning' && 'text-status-warning',
        )}
      >
        {value}
      </div>
      {sub !== undefined && (
        <div
          className={cn(
            'mt-1.5 text-2xs text-muted-foreground tabular-nums',
            tone === 'warning' && 'font-medium text-status-warning',
          )}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

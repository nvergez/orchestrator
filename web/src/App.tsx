import { useQuery } from '@tanstack/react-query';
import { fetchState } from './api';
import { GateCallout, StallCallout } from './components/callouts';
import { DaemonStatus } from './components/daemon-status';
import { OverviewStrip } from './components/overview-strip';
import { RecentlyClosed } from './components/recently-closed';
import { SessionCard } from './components/session-card';
import { deriveOverviewStats } from './lib/stats';
import { clockTime } from './lib/time';
import { cn } from './lib/utils';

/**
 * One page answering "what is the orchestrator doing right now?" — polls
 * /api/state every ~3s. A failed poll keeps the last snapshot on screen
 * under an unmissable banner: stale data must never masquerade as live.
 */
export default function App() {
  const { data, isError, isPending, dataUpdatedAt } = useQuery({
    queryKey: ['state'],
    queryFn: fetchState,
    refetchInterval: 3_000,
    retry: false,
  });

  if (isPending) {
    return <p className="p-8 text-sm text-muted-foreground">Reaching the sidecar…</p>;
  }
  if (data === undefined) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <UnreachableBanner />
      </main>
    );
  }

  const stats = deriveOverviewStats(data);
  return (
    <div className="min-h-dvh">
      {/*
       * The header is the one thing scrolling can't take away, so it — not just
       * the banner below it — has to say when the data is dead: glyph, the word
       * "stale", and a color, never color alone. The banner rides along inside
       * the sticky region for the same reason.
       */}
      <header className="sticky top-0 z-10 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2.5">
          <h1 className="text-sm font-semibold tracking-tight">
            orc{' '}
            <span className="ml-1 font-normal text-muted-foreground">orchestrator</span>
          </h1>
          <DaemonStatus unitState={data.daemon.unitState} />
          <span className="ml-auto flex items-center gap-2">
            <span className="hidden text-2xs text-muted-foreground sm:inline">
              refreshes every 3 s
            </span>
            <span
              className={cn(
                'flex items-center gap-2 font-mono text-2xs tabular-nums',
                isError ? 'font-medium text-status-critical' : 'text-muted-foreground',
              )}
            >
              <span
                key={dataUpdatedAt}
                aria-hidden="true"
                className={cn(
                  'size-2 rounded-full',
                  isError ? 'bg-status-critical' : 'animate-tick bg-accent',
                )}
              />
              {isError ? '✗ stale · as of' : 'as of'} {clockTime(data.asOf)}
            </span>
          </span>
        </div>

        {isError && (
          <div className="mx-auto max-w-5xl px-6 pb-3">
            <UnreachableBanner asOf={data.asOf} />
          </div>
        )}
      </header>

      <main className="mx-auto max-w-5xl space-y-10 px-6 py-6">
        {data.noStateYet ? (
          <p className="rounded-xl border border-border/80 bg-card p-5 text-sm text-muted-foreground shadow-lift">
            No state yet — the daemon has never run on this machine. Once it handles its first
            thread, sessions and delegations appear here.
          </p>
        ) : (
          <>
            <OverviewStrip stats={stats} />

            {stats.needsAttention > 0 && (
              <section className="animate-enter space-y-3 rounded-xl border border-status-warning/40 bg-status-warning/5 p-4 shadow-lift">
                <SectionHeader
                  title="⚠ Needs attention"
                  count={stats.needsAttention}
                  className="text-status-warning"
                  ruleClassName="bg-status-warning/30"
                />
                {data.pendingGates.map((gate) => (
                  <GateCallout key={gate.msgId} gate={gate} asOf={data.asOf} />
                ))}
                {data.pendingStalls.map((stall) => (
                  <StallCallout key={stall.dispatchId} stall={stall} asOf={data.asOf} />
                ))}
              </section>
            )}

            <section className="space-y-3">
              <SectionHeader title="Open sessions" count={data.sessions.length} />
              {data.sessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open sessions — the orchestrator is idle.
                </p>
              ) : (
                data.sessions.map((session) => (
                  <SessionCard key={session.threadTs} session={session} asOf={data.asOf} />
                ))
              )}
            </section>

            <section className="space-y-3">
              <SectionHeader title="Recently closed" count={stats.closedTotal} hint="last 48 h" />
              <RecentlyClosed
                delegations={data.recentlyClosed.delegations}
                sessions={data.recentlyClosed.sessions}
                asOf={data.asOf}
              />
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/** Overline label + count + hairline rule: the page's section rhythm. */
function SectionHeader({
  title,
  count,
  hint,
  className,
  ruleClassName,
}: {
  title: string;
  count?: number;
  hint?: string;
  className?: string;
  ruleClassName?: string;
}) {
  return (
    <h2
      className={cn(
        'flex items-center gap-3 text-2xs font-semibold tracking-[0.14em] uppercase text-muted-foreground',
        className,
      )}
    >
      <span className="flex items-baseline gap-2">
        {title}
        {count !== undefined && (
          <span className="font-mono font-normal tabular-nums opacity-80">{count}</span>
        )}
        {hint !== undefined && (
          <span className="font-normal tracking-normal normal-case opacity-80">· {hint}</span>
        )}
      </span>
      <span aria-hidden="true" className={cn('h-px flex-1 bg-border/70', ruleClassName)} />
    </h2>
  );
}

function UnreachableBanner({ asOf }: { asOf?: string }) {
  return (
    <div
      role="alert"
      className="animate-enter rounded-lg border-l-4 border-status-critical bg-card p-3 text-sm shadow-lift"
    >
      <strong className="text-status-critical">✗ State unknown</strong> — the dashboard sidecar is
      not answering.
      {asOf !== undefined && ` Showing the last snapshot, taken at ${clockTime(asOf)}.`}{' '}
      Check <code className="font-mono text-xs">journalctl --user -u orchestrator-dashboard -e</code>.
    </div>
  );
}

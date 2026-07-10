import { useQuery } from '@tanstack/react-query';
import { fetchState } from './api';
import { GateCallout, StallCallout } from './components/callouts';
import { DaemonStatus } from './components/daemon-status';
import { RecentlyClosed } from './components/recently-closed';
import { SessionCard } from './components/session-card';
import { clockTime } from './lib/time';

/**
 * One page answering "what is the orchestrator doing right now?" — polls
 * /api/state every ~3s. A failed poll keeps the last snapshot on screen
 * under an unmissable banner: stale data must never masquerade as live.
 */
export default function App() {
  const { data, isError, isPending } = useQuery({
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

  const attention = data.pendingGates.length + data.pendingStalls.length;
  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      {isError && <UnreachableBanner asOf={data.asOf} />}

      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-lg font-semibold">Orchestrator</h1>
        <DaemonStatus unitState={data.daemon.unitState} />
        <span className="ml-auto text-xs text-muted-foreground">
          as of {clockTime(data.asOf)} · refreshes every 3 s
        </span>
      </header>

      {data.noStateYet ? (
        <p className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          No state yet — the daemon has never run on this machine. Once it handles its first
          thread, sessions and delegations appear here.
        </p>
      ) : (
        <>
          {attention > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Needs attention</h2>
              {data.pendingGates.map((gate) => (
                <GateCallout key={gate.msgId} gate={gate} asOf={data.asOf} />
              ))}
              {data.pendingStalls.map((stall) => (
                <StallCallout key={stall.dispatchId} stall={stall} asOf={data.asOf} />
              ))}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Open sessions</h2>
            {data.sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No open sessions — nothing is in flight.
              </p>
            ) : (
              data.sessions.map((session) => (
                <SessionCard key={session.threadTs} session={session} asOf={data.asOf} />
              ))
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Recently closed (last 48 h)
            </h2>
            <RecentlyClosed
              delegations={data.recentlyClosed.delegations}
              sessions={data.recentlyClosed.sessions}
              asOf={data.asOf}
            />
          </section>
        </>
      )}
    </main>
  );
}

function UnreachableBanner({ asOf }: { asOf?: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border-l-4 border-status-critical bg-card p-3 text-sm"
    >
      <strong className="text-status-critical">✗ State unknown</strong> — the dashboard sidecar is
      not answering.
      {asOf !== undefined && ` Showing the last snapshot, taken at ${clockTime(asOf)}.`}{' '}
      Check <code className="font-mono text-xs">journalctl --user -u orchestrator-dashboard -e</code>.
    </div>
  );
}

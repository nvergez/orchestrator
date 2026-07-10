/**
 * The `/api/state` contract, mirrored from the sidecar's wire types
 * (src/dashboard/snapshot.ts) and pinned there by the HTTP-seam suite
 * (src/dashboard/server.test.ts) — change it there first.
 */

export interface DelegationView {
  dispatchId: string;
  threadTs: string;
  repo: string | null;
  issueNumber: number | null;
  agent: string | null;
  worktreeName: string | null;
  title: string | null;
  status: 'dispatched' | 'completed' | 'failed';
  dispatchedAt: string;
  lastBusAt: string | null;
  closedAt: string | null;
  issueUrl?: string;
}

export interface SessionCardView {
  threadTs: string;
  channelId: string | null;
  status: 'open' | 'closed' | 'unknown';
  createdAt: string | null;
  lastActivityAt: string | null;
  turnCount: number;
  costUsdTotal: number;
  delegations: DelegationView[];
}

export interface GateView {
  msgId: string;
  threadTs: string;
  kind: 'decision_gate' | 'escalation';
  question: string;
  options: string[];
  worktreeName: string | null;
  relayedAt: string;
}

export interface StallView {
  dispatchId: string;
  threadTs: string;
  worktreeName: string | null;
  lastOutput: string;
  alertedAt: string;
}

export interface ClosedSessionView {
  threadTs: string;
  channelId: string;
  createdAt: string;
  lastActivityAt: string;
  closedAt: string;
  turnCount: number;
  costUsdTotal: number;
}

export interface StateSnapshot {
  asOf: string;
  noStateYet: boolean;
  daemon: { unitState: string };
  sessions: SessionCardView[];
  pendingGates: GateView[];
  pendingStalls: StallView[];
  recentlyClosed: { delegations: DelegationView[]; sessions: ClosedSessionView[] };
}

export async function fetchState(): Promise<StateSnapshot> {
  const response = await fetch('/api/state', { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`/api/state answered HTTP ${response.status}`);
  }
  return (await response.json()) as StateSnapshot;
}

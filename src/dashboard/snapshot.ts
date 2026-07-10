import { DatabaseSync } from 'node:sqlite';

/**
 * The dashboard read model (issue #87, ADR 0002): one snapshot of live
 * orchestrator state, read straight off the SQLite file the session store
 * and delegation ledger already maintain. The connection is read-only by
 * construction — observing the system can never degrade it — and a missing
 * database is a fact ("no state yet"), never an error: the sidecar must
 * keep answering on a fresh install and while the daemon is down.
 */

/** A delegation as the page shows it — in flight or recently closed. */
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
  /** Registry-derived GitHub link; absent when the repo has no remote. */
  issueUrl?: string;
}

/**
 * One session card: the session row plus its in-flight delegations. Status
 * `closed`/`unknown` appear only on the anomaly a card must not hide — a
 * thread with work still in flight whose session row is closed or missing.
 */
export interface SessionCard {
  threadTs: string;
  channelId: string | null;
  status: 'open' | 'closed' | 'unknown';
  createdAt: string | null;
  lastActivityAt: string | null;
  turnCount: number;
  costUsdTotal: number;
  delegations: DelegationView[];
}

/** A pending gate, the worker's question verbatim (the relay fidelity rule). */
export interface GateView {
  msgId: string;
  threadTs: string;
  kind: 'decision_gate' | 'escalation';
  question: string;
  options: string[];
  worktreeName: string | null;
  relayedAt: string;
}

/** A pending stall alert with the worker's last output, verbatim. */
export interface StallView {
  dispatchId: string;
  threadTs: string;
  worktreeName: string | null;
  lastOutput: string;
  alertedAt: string;
}

/** A closed session in the recently-closed section. */
export interface ClosedSessionView {
  threadTs: string;
  channelId: string;
  createdAt: string;
  lastActivityAt: string;
  /** What the ~48h window keys on — a sweep-closed dormant session closed
   * NOW, its last activity was ~7 days ago. */
  closedAt: string;
  turnCount: number;
  costUsdTotal: number;
}

/** The `/api/state` response — the one contract the frontend consumes. */
export interface StateSnapshot {
  /** When this snapshot was taken — the page's "as of" stamp. */
  asOf: string;
  /** True when the database file does not exist (fresh install). */
  noStateYet: boolean;
  /** systemd ActiveState of the daemon unit: active/inactive/failed/unknown. */
  daemon: { unitState: string };
  /** Open sessions (most recent activity first) with in-flight delegations. */
  sessions: SessionCard[];
  pendingGates: GateView[];
  pendingStalls: StallView[];
  /** Closed within the ~48h window, so a quiet page still tells a story. */
  recentlyClosed: { delegations: DelegationView[]; sessions: ClosedSessionView[] };
}

export interface SnapshotDeps {
  dbPath: string;
  now: () => string;
  /** systemd ActiveState of the daemon unit — via `systemctl --user is-active`. */
  daemonUnitState: () => Promise<string>;
  /** Registry-derived GitHub issue links, batch-wide, degrading to unlinked rows. */
  linkIssues: <Row extends { repo: string | null; issueNumber: number | null }>(
    rows: Row[],
  ) => Promise<Array<Row & { issueUrl?: string }>>;
}

/** How far back the recently-closed section reaches. */
export const RECENTLY_CLOSED_WINDOW_MS = 48 * 60 * 60_000;

export async function readSnapshot(deps: SnapshotDeps): Promise<StateSnapshot> {
  const asOf = deps.now();
  const unitState = await deps.daemonUnitState();

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(deps.dbPath, { readOnly: true });
  } catch {
    // Read-only open never creates a file: a missing database means the
    // daemon has never run here — a valid "no state yet" snapshot.
    return {
      asOf,
      noStateYet: true,
      daemon: { unitState },
      sessions: [],
      pendingGates: [],
      pendingStalls: [],
      recentlyClosed: { delegations: [], sessions: [] },
    };
  }
  try {
    const cutoff = new Date(Date.parse(asOf) - RECENTLY_CLOSED_WINDOW_MS).toISOString();
    const delegations = readDelegations(db, cutoff);
    const linked = await deps.linkIssues([...delegations.inFlight, ...delegations.recentlyClosed]);
    const inFlight = linked.slice(0, delegations.inFlight.length);
    const recentlyClosedDelegations = linked.slice(delegations.inFlight.length);
    return {
      asOf,
      noStateYet: false,
      daemon: { unitState },
      sessions: sessionCards(db, inFlight),
      pendingGates: readPendingGates(db),
      pendingStalls: readPendingStalls(db),
      recentlyClosed: {
        delegations: recentlyClosedDelegations,
        sessions: readRecentlyClosedSessions(db, cutoff),
      },
    };
  } finally {
    db.close();
  }
}

/**
 * The daemon creates each table with its store; a database mid-birth (or
 * hand-pruned) simply has nothing to say for the missing half — the reader
 * never errors a page over it.
 */
function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

interface RawSessionRow {
  thread_ts: string;
  channel_id: string;
  status: string;
  created_at: string;
  last_activity_at: string;
  turn_count: number;
  cost_usd_total: number;
}

function readDelegations(
  db: DatabaseSync,
  cutoff: string,
): { inFlight: DelegationView[]; recentlyClosed: DelegationView[] } {
  if (!hasTable(db, 'delegations')) return { inFlight: [], recentlyClosed: [] };
  const inFlight = db
    .prepare(`SELECT * FROM delegations WHERE status = 'dispatched' ORDER BY dispatched_at`)
    .all() as Array<Record<string, unknown>>;
  const recentlyClosed = db
    .prepare(
      `SELECT * FROM delegations
        WHERE status IN ('completed', 'failed') AND closed_at >= ?
        ORDER BY closed_at DESC, dispatch_id`,
    )
    .all(cutoff) as Array<Record<string, unknown>>;
  return {
    inFlight: inFlight.map(toDelegationView),
    recentlyClosed: recentlyClosed.map(toDelegationView),
  };
}

function toDelegationView(row: Record<string, unknown>): DelegationView {
  return {
    dispatchId: row.dispatch_id as string,
    threadTs: row.thread_ts as string,
    repo: row.repo as string | null,
    issueNumber: row.issue_number === null ? null : Number(row.issue_number),
    agent: row.agent as string | null,
    worktreeName: row.worktree_name as string | null,
    title: row.title as string | null,
    status: row.status as DelegationView['status'],
    dispatchedAt: row.dispatched_at as string,
    lastBusAt: (row.last_bus_at ?? null) as string | null,
    closedAt: row.closed_at as string | null,
  };
}

/**
 * Open sessions become cards carrying their in-flight delegations; a thread
 * with in-flight work but no open session row still gets a card (status
 * `closed` or `unknown`) — live work must never hide behind session state.
 */
function sessionCards(db: DatabaseSync, inFlight: DelegationView[]): SessionCard[] {
  const byThread = new Map<string, DelegationView[]>();
  for (const delegation of inFlight) {
    const rows = byThread.get(delegation.threadTs) ?? [];
    rows.push(delegation);
    byThread.set(delegation.threadTs, rows);
  }

  const cards: SessionCard[] = [];
  if (hasTable(db, 'sessions')) {
    const open = db
      .prepare(`SELECT * FROM sessions WHERE status = 'open' ORDER BY last_activity_at DESC`)
      .all() as unknown as RawSessionRow[];
    for (const row of open) {
      cards.push({
        threadTs: row.thread_ts,
        channelId: row.channel_id,
        status: 'open',
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        turnCount: Number(row.turn_count),
        costUsdTotal: Number(row.cost_usd_total),
        delegations: byThread.get(row.thread_ts) ?? [],
      });
      byThread.delete(row.thread_ts);
    }
  }
  for (const threadTs of [...byThread.keys()].sort()) {
    const delegations = byThread.get(threadTs) ?? [];
    const first = delegations[0];
    const session = hasTable(db, 'sessions')
      ? ((db
          .prepare('SELECT * FROM sessions WHERE thread_ts = ?')
          .get(threadTs) as unknown as RawSessionRow | undefined) ?? null)
      : null;
    cards.push({
      threadTs,
      channelId:
        session?.channel_id ?? (first === undefined ? null : channelIdOf(db, first.dispatchId)),
      status: session === null ? 'unknown' : 'closed',
      createdAt: session?.created_at ?? null,
      lastActivityAt: session?.last_activity_at ?? null,
      turnCount: session === null ? 0 : Number(session.turn_count),
      costUsdTotal: session === null ? 0 : Number(session.cost_usd_total),
      delegations,
    });
  }
  return cards;
}

/** The ledger row's own channel id — the orphan card's only channel source. */
function channelIdOf(db: DatabaseSync, dispatchId: string): string | null {
  const row = db
    .prepare('SELECT channel_id FROM delegations WHERE dispatch_id = ?')
    .get(dispatchId) as { channel_id?: string } | undefined;
  return row?.channel_id ?? null;
}

function readPendingGates(db: DatabaseSync): GateView[] {
  if (!hasTable(db, 'pending_gates')) return [];
  const rows = db
    .prepare(
      `SELECT * FROM pending_gates WHERE status = 'pending' ORDER BY relayed_at, msg_id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    msgId: row.msg_id as string,
    threadTs: row.thread_ts as string,
    kind: row.kind as GateView['kind'],
    question: row.question as string,
    options: readOptions(row.options),
    worktreeName: row.worktree_name as string | null,
    relayedAt: row.relayed_at as string,
  }));
}

/** The options column is JSON the daemon wrote; anything else reads empty. */
function readOptions(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function readPendingStalls(db: DatabaseSync): StallView[] {
  if (!hasTable(db, 'stall_alerts')) return [];
  const rows = db
    .prepare(
      `SELECT * FROM stall_alerts WHERE status = 'pending' ORDER BY alerted_at, dispatch_id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    dispatchId: row.dispatch_id as string,
    threadTs: row.thread_ts as string,
    worktreeName: row.worktree_name as string | null,
    lastOutput: row.last_output as string,
    alertedAt: row.alerted_at as string,
  }));
}

function readRecentlyClosedSessions(db: DatabaseSync, cutoff: string): ClosedSessionView[] {
  if (!hasTable(db, 'sessions') || !hasColumn(db, 'sessions', 'closed_at')) return [];
  const rows = db
    .prepare(
      `SELECT * FROM sessions
        WHERE status = 'closed' AND closed_at >= ?
        ORDER BY closed_at DESC, thread_ts`,
    )
    .all(cutoff) as unknown as Array<RawSessionRow & { closed_at: string }>;
  return rows.map((row) => ({
    threadTs: row.thread_ts,
    channelId: row.channel_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    closedAt: row.closed_at,
    turnCount: Number(row.turn_count),
    costUsdTotal: Number(row.cost_usd_total),
  }));
}

/** A pre-#87 database the migration hasn't touched yet reads as empty here. */
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
    name: string;
  }>;
  return columns.some((row) => row.name === column);
}

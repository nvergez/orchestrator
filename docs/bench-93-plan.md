# Plan — issue #93: multi-channel and multi-user Slack support

Issue #93 lifts the two singletons of the Slack surface: the daemon serves a
*list* of channels instead of the single pinned `SLACK_CHANNEL_ID`, and a
*list* of authorized humans instead of the single `SLACK_ALLOWED_USER_ID`.
The issue deliberately left several design decisions open; this document
records the decisions taken for this implementation and why.

## Decisions

### 1. Ship both halves together

Multi-channel and multi-user are separable in principle, but multi-channel
forces the one deep change — a thread's identity daemon-wide becomes the
`(channel_id, thread_ts)` pair instead of `thread_ts` alone — and multi-user
is a thin generalization (an allow-list membership check instead of an
equality check) riding the same config revision, the same filter rewrite and
the same spec §2 revision. Splitting them would mean touching the same event
filter, config loader, `.env` template and spec section twice, for no
sequencing benefit. They ship together.

### 2. Config shape: CSV env vars, singular forms still accepted

- `SLACK_CHANNEL_IDS` — comma-separated `C…` ids.
- `SLACK_ALLOWED_USER_IDS` — comma-separated `U…` ids.

CSV-in-env follows the existing `COST_WARN_THRESHOLDS_USD` precedent: these
are flat lists of opaque ids, not structured objects, so promoting them into
a file (like the routing hints, which are objects with descriptions and
aliases) would be ceremony. Each entry is prefix-validated exactly as the
singular var was; duplicates are rejected (a duplicated id is a typo, not an
intent); empty lists are rejected.

**Backward compatibility is a hard requirement** — an existing install must
boot unchanged after `orc update`. The singular `SLACK_CHANNEL_ID` /
`SLACK_ALLOWED_USER_ID` remain accepted as a fallback when the plural var is
absent; when both are set the plural wins (documented in the template). The
`orc init` env template and doctor's env check move to the plural forms
(doctor validates through `loadConfig`, so either spelling passes).

### 3. Re-key the ledger to `(thread_ts, channel_id)` — forward migrations

`thread_ts` values are only unique within a channel, so every thread-scoped
table and query grows the channel dimension. Existing databases migrate
forward on open, per repo rules; each migration has test coverage. Table by
table:

- **`sessions`** — already keyed `(thread_ts, channel_id)`. No change.
- **`delegations`** — already carries `channel_id NOT NULL`; the primary key
  (`dispatch_id`, runtime-unique) stays. Thread-scoped *queries* gain
  `AND channel_id = ?`. No schema change.
- **`mailboxes`** — primary key `thread_ts` → `(thread_ts, channel_id)`.
  SQLite cannot alter a primary key, so this is the copy-and-rename rebuild
  the codebase already uses for `pending_gates`; rows carry `channel_id`
  already and ride across unchanged.
- **`reconciliations`** — gains `channel_id NOT NULL` and the composite
  primary key, via rebuild. Legacy rows are backfilled from the thread's
  `delegations` rows (a fingerprint only ever exists for a thread that
  dispatched); a row the backfill cannot attribute is dropped — the cost is
  at most one repeated ⚠️ restart notice, which is self-healing.
- **`pending_gates`** / **`stall_alerts`** — gain a *nullable* `channel_id`
  column (plain `ALTER TABLE ADD COLUMN`, like the #48 `last_bus_at`
  migration). New rows always record their channel. Legacy rows keep
  `NULL`, and every thread-scoped gate/stall query matches
  `(channel_id = ? OR channel_id IS NULL)`: a pre-#93 row necessarily comes
  from the single-channel era, so channel-unscoped matching is exactly
  correct for it — the gate stays routable and closable after the upgrade
  instead of wedging a ❓ forever. Only rows written by a multi-channel
  daemon can collide across channels, and those always carry their channel.
  (No backfill: `NULL` is honest — "channel unknown, single-channel era" —
  and the tolerant predicate makes it fully functional.)

WAL mode is untouched, and the dashboard reader stays tolerant of both a
missing database and a pre-#93 one (it already reads via `hasTable` /
`hasColumn` probes).

### 4. Authorization semantics: any allowed user, everywhere

The model is a **shared ops channel**, not per-thread ownership: any
allow-listed user may open sessions, reply in any registered thread, answer
🚦 confirm gates, answer relayed worker gates/escalations and stall alerts,
and close any session.

Rationale: spec §7's allow-list is a *trust boundary* against third-party
prompt injection, not an ownership model between operators. Per-thread
ownership (keying on the stored `root_user`) would block the main
multi-user use case — a teammate answering a decision gate while the thread
opener is offline — and buys no security: everyone on the allow-list is
already trusted to open threads and delegate work, so restricting replies
protects nothing. `root_user` stays recorded per session for attribution
(and now surfaces on the dashboard). Behavior toward non-allowed users is
unchanged: polite one-line refusal on a root mention, silence inside
threads.

### 5. Caps stay global; cost stays per-session

`WORKER_CAP` and `SESSION_LIVE_CAP` bound machine resources — concurrent
worker agents and live Claude subprocesses on the one VPS — and those are
shared whatever channel or user the work came from. Splitting them per user
would under-utilize the machine and complicate the FIFO fairness that
already exists (queued messages and delegation waves run in arrival order
across all threads). Cost warnings are already per-thread and stay so;
per-user cost attribution remains v2 territory (the ledger keeps
`root_user`, so the data to build it is durable).

### 6. Dashboard: cards name the channel and the opener

`SessionCard` in the `/api/state` snapshot gains `rootUser`; the frontend
session card shows the channel id and the root user chip. In-flight
delegations group under their session by `(channel_id, thread_ts)` instead
of `thread_ts` alone. Additive contract change; snapshot and frontend move
together per repo rules.

### 7. Mailbox terminals key on the pair

The per-thread mailbox terminal is remembered under `(thread_ts,
channel_id)`; newly created mailboxes are titled
`slack-<channelId>-<threadTs>` so two same-`ts` threads in different
channels can never share a title. Existing stored handles keep working.

### 8. Out of scope (per the issue)

Multi-workspace (several bot tokens), per-channel routing-hint scoping, and
permission tiers beyond allowed/not-allowed. Also out: per-user caps and
per-user cost ledgers (see 5).

## Mechanical consequences

The single pinned channel is currently baked into two places the rest of the
system leans on:

1. **The raw Slack `Surface`** (`daemon.ts`) is closed over
   `config.slackChannelId`. It becomes channel-addressed:
   `post(channelId, threadTs, text)`, `update(channelId, ts, text)`,
   `react/unreact(channelId, ts, name)` — mirroring the Slack API's
   `(channel, ts)` addressing. `ThreadSurface` and every coordinator
   (dispatch, watcher, watchdog, relay, reconciler) pass the channel from
   the ledger row (rows are self-describing already) or from the event
   context.
2. **The event filter** guard becomes `channelIds` / `allowedUserIds`
   lists; every non-ignore `Decision` now carries the event's `channelId`
   (and `open` carries the opener), so `app.ts` stops reaching back into
   the guard for them.

Everything downstream follows the existing `SessionStore` precedent of
explicit `(threadTs, channelId)` string pairs, with in-memory maps keyed
`` `${channelId}:${threadTs}` `` (the key shape `SessionManager` already
uses). The per-session seams (`ProcessFactory`, `canUseTool`, hooks, voice,
notifier, gates) close over both ids.

Spec §2 (Slack surface), §7 (user allow-list), §9 (data model) and §11
(config table) are revised in the same PR; `docs/setup-slack.md` note on
`channels:read` stays true (membership checks still unneeded — the filter
works from the configured id list).

## Test plan

- `config.test.ts`: CSV parsing, singular fallback, precedence, prefix and
  duplicate validation.
- `filter.test.ts`: acceptance across several channels, rejection outside
  the list, several allowed users, decisions carrying `channelId`.
- `delegations.test.ts`: migration coverage — a database built with the
  pre-#93 schemas opens, gains the columns/keys, legacy NULL-channel gate
  and stall rows still match thread-scoped queries; cross-channel isolation
  — two threads with the same `thread_ts` in different channels never see
  each other's delegations, gates, stalls, mailboxes or fingerprints.
- Coordinator suites updated for the new seams, plus targeted cross-channel
  cases (watcher wake and gate relay land on the row's channel).
- `runtime.test.ts` (real composition) and `app.test.ts` updated: events
  from two channels drive two independent sessions.
- Dashboard: snapshot exposes `rootUser`, groups by the pair; server suite
  pins the extended contract; web typecheck covers the mirrored types.

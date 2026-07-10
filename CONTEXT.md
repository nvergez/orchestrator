# Orchestrator

A Slack-driven orchestrator-dispatcher daemon: one Claude Code session per
Slack thread, delegating work to Orca worktree agents. Published to npm as
`@nvergez/orchestrator`, installing the `orc` CLI.

## Language

### Architecture

**Thread surface**:
The module that owns what a Slack thread's root message shows — the
coarse-state root reactions and the delegation cards — for the thread's whole
lifecycle (`src/delegation/thread-surface.ts`). Every emoji and final-card
decision goes through it; nothing else touches root reactions.
_Avoid_: reaction helpers, watcher utils

**Delegation ledger**:
The persistent record of every delegation's lifecycle and the single source
of truth for what is in flight (`src/delegation/delegations.ts`). The worker
cap, boot reconciliation and the watchers all count on it, and it owns the
identity questions over its own records — which delegation a bus event
belongs to, which gate owns a re-asked question now — so callers ask
questions instead of re-deriving answers from raw rows.
_Avoid_: store, DB layer

**Dashboard**:
The read-only web view of live orchestrator state — open sessions, in-flight
delegations, pending gates, stall alerts. Served by a sidecar process, never
by the daemon; it renders what the session store and delegation ledger
already know and writes nothing. How an operator exposes it beyond the
machine (Tailscale, SSH tunnel) is their business, not the project's.
_Avoid_: visualizer, viz, status page, UI

### Releasing

**Release**:
A published version of the package — git tag, npm publish, and GitHub Release
cut together. A release contains every pending change merged since the
previous release.
_Avoid_: Deploy, publish (alone)

**Release label**:
The `release` label on a pull request. Merging a PR that carries it triggers a
release. It is a trigger, not a selector: it decides *when* a release happens,
never *which* changes it contains.

**Pending changes**:
The releasable (`fix:`/`feat:`/breaking) merges accumulated on main since the
last release, waiting for the next release to ship them. A release trigger with
no pending changes releases nothing.

**Update**:
Bringing a local install up to the latest release — fetching the new version,
regenerating the service unit, and restarting the daemon are one indivisible
ritual, never separate steps.
_Avoid_: Upgrade

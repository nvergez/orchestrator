# AGENTS.md

## What this repository is

`orc` is a Node/TypeScript daemon that turns one Slack thread into one persistent
Claude session and delegates implementation to Orca worktree agents. The daemon
coordinates, supervises, and relays; it must not perform delegated work itself.
State is durable SQLite state, so restart and migration behavior are product
behavior, not implementation detail.

Use [CONTEXT.md](CONTEXT.md) for domain vocabulary and [docs/spec.md](docs/spec.md)
for behavior. For a changed architectural decision, read the relevant file in
`docs/adr/`.

## Code map and boundaries

- `src/kernel/`: dependency leaf for config, protocol, guardrails, Orca access,
  logging, and system integration.
- `src/cli/`: small CLI surface. It statically depends only on `kernel`; keep
  daemon/dashboard loading lazy so `orc --help` and `--version` need no runtime
  configuration or Slack dependencies.
- `src/daemon/`: Slack/session lifecycle and persistence.
- `src/delegation/`: dispatch, ledger, relay, reconciliation, and watchdog.
- `src/daemon/runtime.ts`: the composition root and the only normal location for
  value-level wiring between `daemon` and `delegation`.
- `src/dashboard/`: read-only SQLite snapshot and localhost sidecar. It must not
  become a daemon endpoint or write through daemon/delegation stores.
- `web/`: separate React/Vite workspace consuming the `/api/state` contract from
  `src/dashboard/snapshot.ts`.

ESLint enforces the import graph. Preserve the boundaries instead of bypassing
them with new dynamic imports.

## Implementation rules

- Require Node `>=22.18`; use npm and commit `package-lock.json` changes.
- Source runs directly under Node type stripping. Keep ESM imports explicit with
  `.ts` extensions and use erasable TypeScript syntax only.
- Put tests beside source as `*.test.ts`. Prefer injected seams and small fakes;
  preserve real composition tests in `src/daemon/runtime.test.ts`.
- Treat SQLite schema changes as forward migrations of existing databases. Add
  migration coverage, preserve WAL mode, and keep dashboard reads tolerant of a
  missing or older database.
- Keep the dashboard read-only and localhost-bound by default. Update the
  snapshot and frontend together when `/api/state` changes.
- External Slack, Orca, and systemd failures should degrade explicitly without
  crashing the long-lived daemon unless startup configuration is invalid.
- Never use service credentials or the production database for development.
  `npm run dev:all` needs an isolated Slack app/database; use
  `npm run dev:dashboard:demo` for UI-only work.

## Verification

Run a focused test while iterating:

```bash
npm test -- src/path/file.test.ts
```

Before handing off a change, run the applicable CI gates (all of them for
cross-cutting changes):

```bash
npm test
npm run typecheck
npm run typecheck:web
npm run lint
npm run prepack
```

PR titles are Conventional Commits because squash-merge titles determine release
versioning (`fix:`, `feat:`, or a breaking change).

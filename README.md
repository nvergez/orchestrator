# orchestrator

[![npm version](https://img.shields.io/npm/v/%40nvergez%2Forchestrator)](https://www.npmjs.com/package/@nvergez/orchestrator)
[![CI](https://github.com/nvergez/orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/nvergez/orchestrator/actions/workflows/ci.yml)

A Slack-driven **orchestrator-dispatcher** daemon: one Claude Code session per
Slack thread, delegating work to Orca worktree agents.
Mention the bot in a channel, describe what you want, and it routes the request
to the right repo, dispatches a worker agent in its own worktree, supervises it
(questions and escalations relayed back into the thread), and reports the
result. Single-operator by design: one workspace, one channel, one authorized
user.

## How it works

The daemon is a single long-lived Node process. It connects to Slack over
Socket Mode (no inbound URL) and gives a Claude Code agent a Slack presence —
each thread gets its own persistent session, resumable across restarts. The
orchestrator never writes code itself: it interprets requests, delegates to
Orca worktree agents on an allow-listed set of repos, watches their structured
messages (done / blocked / question), and relays anything that needs a human
back into the thread. State (sessions, delegations, pending gates) lives in a
local SQLite database, so a restart loses nothing.

The full architecture deep-dive is in [`docs/spec.md`](docs/spec.md).

## Prerequisites

- **Linux with systemd user services.** On other platforms (or without
  systemd) run `orc` in the foreground under your own supervisor — see
  [`docs/operations.md`](docs/operations.md).
- **Node.js ≥ 22.18.**
- **Orca** — the `orca` CLI installed and the runtime running on the same
  machine. Hard prerequisite: the daemon delegates all
  work to Orca worktree agents.
- **A Claude subscription with the [Claude Code](https://claude.com/claude-code)
  CLI.** Run `claude setup-token` to mint the long-lived `sk-ant-…` OAuth
  token the daemon authenticates with. The daemon is **subscription-billed**
  — API-key billing is not supported (`CLAUDE_CODE_OAUTH_TOKEN` is
  hard-required). The token **acts as your account**: treat it like a
  password, and expect daemon usage to share your subscription's rate limits.
- **A Slack workspace where you can create an app.** Walkthrough with a
  ready-to-paste manifest: [`docs/setup-slack.md`](docs/setup-slack.md).

## Install

```bash
npm install -g @nvergez/orchestrator   # 1
orc init                               # 2
$EDITOR ~/.config/orchestrator/env ~/.config/orchestrator/routing-hints.json  # 3
orc doctor                             # 4
orc service install                    # 5
sudo loginctl enable-linger $USER      # 6 — once
```

1. Installs the daemon and the `orc` CLI.
2. Creates `~/.config/orchestrator/` and scaffolds the two config files
   (never overwrites existing ones).
3. Fill in your tokens and Slack IDs in `env` (see
   [`docs/setup-slack.md`](docs/setup-slack.md)) and your delegable repos in
   `routing-hints.json`.
4. Checks the whole setup read-only — env vars, hints file, state dir, node
   version, `orca` reachability. A non-zero exit means fix before continuing.
5. Generates and starts the systemd user unit `orchestrator.service`.
6. One-time, and the only step needing sudo: without linger, systemd stops
   your user services at logout and does not start them at boot — **required**
   for reboot survival.

## CLI

| Command | What it does |
|---|---|
| `orc` | Run the daemon in the foreground (reads config from the environment) |
| `orc --version` | Print the version and exit |
| `orc init` | Scaffold `~/.config/orchestrator/{env,routing-hints.json}` |
| `orc doctor` | Read-only diagnosis of the whole setup; non-zero exit on any failure |
| `orc service install` | Generate, enable and start the systemd user unit (re-run after node upgrades) |
| `orc service uninstall` | Stop, disable and remove the systemd user unit |

## Upgrading

One ritual for every upgrade:

```bash
npm update -g @nvergez/orchestrator && orc service install && systemctl --user restart orchestrator
```

The explicit restart matters: `orc service install` ends in `enable --now`,
which does **not** restart an already-running unit — without it the old code
keeps running. Re-running `service install` every time also covers node/nvm
upgrades, since the generated unit pins absolute paths. Optionally finish with
`orc doctor`.

> **Pre-1.0 caveat:** while the package is on 0.x, read the GitHub Release
> notes before upgrading; the first breaking release graduates to 1.0.0.

Changelog = [GitHub Releases](https://github.com/nvergez/orchestrator/releases)
only. To get notified: **Watch → Custom → Releases** on the repo.

## Operating

```bash
systemctl --user status orchestrator     # running?
journalctl --user -u orchestrator -f     # follow the logs
```

Runbook — service management, `orc doctor` triage, non-systemd operation,
config/state reference, uninstall: [`docs/operations.md`](docs/operations.md).

## Development

```bash
git clone https://github.com/nvergez/orchestrator && cd orchestrator
npm ci
npm test && npm run typecheck && npm run lint
```

PRs are squash-merged and the PR title must follow
[Conventional Commits](https://www.conventionalcommits.org/) — merged titles
drive automated releases (`fix:` → patch, `feat:` → minor, breaking → major;
anything else releases nothing).

## License

[MIT](LICENSE)

# Operations

Post-install runbook for a daemon set up per the [README](../README.md#install)
golden path. `orc service install` generates **two** systemd user units —
`orchestrator.service` (the daemon) and `orchestrator-dashboard.service`
(the [dashboard](#dashboard) sidecar) — both restarting on crash
(`Restart=always`, 5 s backoff) and, with linger enabled, coming back after
a reboot.

## Service management

```bash
systemctl --user status orchestrator    # running? main PID? enabled?
systemctl --user restart orchestrator
systemctl --user stop orchestrator      # until next restart/reboot
journalctl --user -u orchestrator -f    # follow the logs
```

> **SSH and Orca shells:** `systemctl --user` / `journalctl --user` need the
> session's user bus. If you see `Failed to connect to user scope bus`, run
> `export XDG_RUNTIME_DIR=/run/user/$(id -u)` first.

The unit files at `~/.config/systemd/user/orchestrator.service` and
`…/orchestrator-dashboard.service` are **generated artifacts** — don't
hand-edit them; re-running `orc service install` overwrites both. Persistent
overrides belong in drop-ins under `~/.config/systemd/user/<unit>.service.d/`,
which survive regeneration.

### Logs

Structured JSON (pino) on stdout, kept by journald:

```bash
journalctl --user -u orchestrator -f          # follow
journalctl --user -u orchestrator -b          # since boot
journalctl --user -u orchestrator -o cat | jq # pretty-print the JSON
```

Verbosity is the `LOG_LEVEL` env var (pino levels; default `info`). Change it
in `~/.config/orchestrator/env`, then `systemctl --user restart orchestrator`.

At startup the daemon fires one read-only Orca probe — non-blocking, never
fatal (Orca may legitimately still be down at boot; the daemon connects to
Slack regardless and every later `orca` call is individually guarded). Look
for one of:

- `boot healthcheck: Orca runtime reachable` (info, with repo count)
- `boot healthcheck: Orca runtime unavailable` (warn, with reason)

## Dashboard

The **Dashboard** is the read-only web view of live orchestrator state —
daemon health, open sessions with their in-flight delegations, pending gates
(worker questions verbatim), stall alerts, and a recently-closed section
(~48 h). It is served by the `orchestrator-dashboard` **sidecar**, never by
the daemon (see `docs/adr/0002`): the daemon keeps its no-inbound-listener
guarantee, and the page keeps working while the daemon is down or crashed —
exactly when you need it. The sidecar opens the SQLite state read-only;
observing the system cannot degrade it.

```bash
systemctl --user status orchestrator-dashboard
journalctl --user -u orchestrator-dashboard -f
curl -s 127.0.0.1:8787/api/state | jq     # the page's JSON snapshot
```

It binds to `127.0.0.1:8787` by default — nothing is exposed beyond the
machine, and the project ships no auth story on purpose. To reach it from
elsewhere, use your own transport (Tailscale, `ssh -L 8787:127.0.0.1:8787 vps`),
or change `DASHBOARD_BIND`/`DASHBOARD_PORT` in `~/.config/orchestrator/env`
on your own authority, then `systemctl --user restart orchestrator-dashboard`.

A fresh install with no database renders "no state yet" — that page is a
fact, not a crash. If `/` says the frontend was never built you are on a dev
checkout: run `npm run build:web`.

## `orc doctor` triage

`orc doctor` is a read-only diagnosis of the whole setup; any failure makes
it exit non-zero. What each check means:

| Check | Failure means |
|---|---|
| Required env vars present, correct prefixes (`xoxb-`, `xapp-`, `C…`, `U…`, `sk-ant-`) | Neither `process.env` nor `~/.config/orchestrator/env` provides valid values — the env file is incomplete or a value was pasted into the wrong slot |
| Routing hints file parses (+ repo count) | `routing-hints.json` is missing or malformed — both are boot-fatal; the error prints the path it tried |
| State dir writable | The SQLite database's directory can't be created or written |
| Node version vs `engines` | Running Node is older than the required ≥ 22.18 |
| `orca` CLI on PATH + runtime reachable | Orca isn't installed, or the runtime isn't running — the daemon can boot but every delegation will fail |
| Unit file present + enabled | *(only once the unit is installed)* the service was removed or disabled behind systemd's back — re-run `orc service install` |
| Dashboard unit active | *(only once its unit is installed)* the sidecar is not running — `journalctl --user -u orchestrator-dashboard -e` |
| Dashboard port answering | *(only once its unit is installed)* nothing answers on the configured `DASHBOARD_BIND:DASHBOARD_PORT` — the sidecar is up but not listening where the env file says, or the port is malformed |
| Linger on | *(only once a unit is installed)* the daemon dies at logout and won't start at boot — run `sudo loginctl enable-linger $USER` |

The unit-dependent checks stay silent before `orc service install`, so
`doctor` is green mid-way through the golden path.

Two of those checks adapt to *where* you run doctor:

- **env** validates `process.env` first (what a systemd-launched daemon
  sees) and, when the variables aren't exported there — the normal case in
  a bare shell — falls back to the canonical env file
  (`$XDG_CONFIG_HOME/orchestrator/env`, default `~/.config/orchestrator/env`),
  applying the same prefix rules. The ✔ line names which source validated;
  the ✖ line lists what's wrong and every source consulted. Doctor is the
  only reader — the daemon itself still gets its environment exclusively
  from `process.env` ([running without systemd](#running-without-systemd)).
- **service**, in a shell without the session's user bus (SSH, Orca — see
  [Service management](#service-management)), reports `cannot reach the user
  service manager — export XDG_RUNTIME_DIR=/run/user/<uid> (or run from a
  login shell)`. That's still a failed check, but it makes no claim about
  the unit being disabled: unit-file *presence* is read from the filesystem
  and stays accurate; enablement simply couldn't be asked of systemd.

## Updating

```bash
orc update
```

What it does, in order:

1. Refuses unless it *is* the global npm install — a dev checkout or an
   `npm link` is updated with git, never by this command.
2. Checks the registry. Already at the latest version is a pure no-op:
   exit 0, service untouched.
3. Refuses a **breaking release** (major version jump) with a pointer to the
   [release notes](https://github.com/nvergez/orchestrator/releases); re-run
   as `orc update --yes` once you have read them. Same-major updates apply
   without ceremony.
4. Preflights the systemd user bus **before touching npm**, whenever a unit is
   installed. A shell that cannot reach the bus (SSH, Orca — no
   `XDG_RUNTIME_DIR`) can regenerate no unit and restart no service, so the
   update refuses while the install is still untouched, and tells you to
   `export XDG_RUNTIME_DIR=/run/user/<uid>` and re-run. The ritual is
   indivisible: it either happens whole or not at all.
5. Installs the new version, regenerates both units **via the freshly
   installed binary** (see `docs/adr/0001`), and restarts both services —
   daemon and dashboard never skew versions. The restart is the step that
   actually swaps the running code — `service install` alone ends in
   `enable --now`, which does *not* restart a running unit.

Without a systemd unit (mid-setup, or [running without
systemd](#running-without-systemd)) only the package is updated, and update
says so — restart your daemon by hand.

Optionally finish with `orc doctor`. A restart is safe by design: sessions
come back dormant and resume on the next message; in-flight delegations are
reconciled and reported in their threads.

After a **node/nvm upgrade** (no new release involved), the unit's pinned
absolute paths go stale — `orc doctor` flags this as a failed `unit paths`
check; fix with `orc service install && systemctl --user restart orchestrator`.

### Rolling back

`orc update` only moves forward. To pin or roll back, run the ritual by hand:

```bash
npm install -g @nvergez/orchestrator@0.1.0 && orc service install && systemctl --user restart orchestrator
```

The explicit restart matters for the same reason as above — without it the
old code keeps running.

## Running without systemd

The daemon itself is supervisor-agnostic: bare `orc` runs it in the
foreground, and it reads configuration from **`process.env` only** — it never
loads an env file itself. Under your own supervisor (runit, supervisord,
tmux, launchd, a container), materialize the environment yourself:

```bash
node --env-file="$HOME/.config/orchestrator/env" "$(which orc)"
# or: set -a; . ~/.config/orchestrator/env; set +a; orc
```

Give it restart-on-exit and capture stdout (structured JSON logs) — that's
all the systemd unit does.

## Configuration and state reference

| Path / variable | What it is |
|---|---|
| `~/.config/orchestrator/env` | Secrets + tunables (chmod 600), loaded by the unit's `EnvironmentFile` — scaffolded by `orc init` |
| `~/.config/orchestrator/routing-hints.json` | The delegable-repo allow-list with aliases/descriptions/default agents — scaffolded by `orc init` |
| `$XDG_STATE_HOME/orchestrator/orchestrator.db` | SQLite state (sessions, delegations, pending gates); defaults to `~/.local/state/…` |
| `ORCHESTRATOR_ROUTING_HINTS_PATH` | Env override for the hints file location (tests, nonstandard setups) |
| `ORCHESTRATOR_DB_PATH` | Env override for the database location |
| `DASHBOARD_PORT` | Dashboard sidecar port, default `8787` |
| `DASHBOARD_BIND` | Dashboard bind address, default `127.0.0.1` — widening it is your exposure decision |
| `LOG_LEVEL` | pino log level, default `info` |
| `SESSION_WARM_TTL_MINUTES` | Minutes a finished-turn session keeps its live process, default 30 |

`$XDG_CONFIG_HOME` is honored for the config dir (falling back to
`~/.config`). The annotated template for every env var, including the
optional caps and cost thresholds, is [`.env.example`](../.env.example) at
the repo root; the canonical scaffold is `orc init`.

## Uninstall

```bash
orc service uninstall               # stop + disable + remove both units
npm rm -g @nvergez/orchestrator     # remove the package and the orc CLI
```

What stays on disk — remove by hand if you want it gone:

- `~/.config/orchestrator/` — your tokens and routing hints,
- `~/.local/state/orchestrator/orchestrator.db` (or your
  `ORCHESTRATOR_DB_PATH`) — session and delegation history.

Linger (`loginctl disable-linger $USER`) and the Slack app are also yours to
retire if nothing else uses them.

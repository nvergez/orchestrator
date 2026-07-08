# Deploy & operations

The `main` checkout at `/home/dev/projects/orchestrator` **is** the deployed
instance (spec §10). The daemon runs as the systemd **user** unit
`orchestrator.service` ([`deploy/orchestrator.service`](../deploy/orchestrator.service)),
supervised by the already-lingering user manager — it restarts on crash and
comes back after a VPS reboot.

> **Orca shells**: `systemctl --user` / `journalctl --user` need the user bus.
> If you see `Failed to connect to user scope bus`, run
> `export XDG_RUNTIME_DIR=/run/user/1000` first.

## First-time install

```bash
cd /home/dev/projects/orchestrator
npm ci

# Secrets: .env lives next to the checkout root, git-ignored, owner-only.
# Template: .env.example. The unit loads it via EnvironmentFile.
chmod 600 .env

cp deploy/orchestrator.service ~/.config/systemd/user/orchestrator.service
systemctl --user daemon-reload
systemctl --user enable --now orchestrator
```

Reboot survival needs linger (already active on this VPS):
`loginctl show-user dev --property=Linger` must say `Linger=yes`
(one-time: `sudo loginctl enable-linger dev`).

## Deploy a new version

```bash
cd /home/dev/projects/orchestrator
git pull
npm ci
systemctl --user restart orchestrator
```

If `deploy/orchestrator.service` itself changed, re-copy it and
`systemctl --user daemon-reload` before the restart.

## Logs

Structured JSON (pino) on stdout, kept by journald (persistent storage +
rotation are already configured system-wide):

```bash
journalctl --user -u orchestrator -f          # follow
journalctl --user -u orchestrator -b          # since boot
journalctl --user -u orchestrator -o cat | jq # pretty-print the JSON
```

Verbosity is `LOG_LEVEL` in `.env` (pino levels; default `info`). Change it,
then `systemctl --user restart orchestrator`.

## Boot healthcheck

At startup the daemon fires one read-only `orca repo list --json` probe —
non-blocking, never fatal (user units cannot order against the Orca system
unit, so Orca may legitimately still be down at boot). Look for one of:

- `boot healthcheck: Orca runtime reachable` (info, with `repoCount`)
- `boot healthcheck: Orca runtime unavailable` (warn, with `reason`)

An `unavailable` outcome does not stop the daemon; it connects to Slack anyway.

## Supervision checks

```bash
systemctl --user status orchestrator            # running? main PID?
kill $(systemctl --user show -p MainPID --value orchestrator)
sleep 6 && systemctl --user status orchestrator # back with a new PID (RestartSec=5)
```

After a VPS reboot the unit starts automatically (`WantedBy=default.target`
+ enabled + linger); check `journalctl --user -u orchestrator -b` for the
boot healthcheck line.

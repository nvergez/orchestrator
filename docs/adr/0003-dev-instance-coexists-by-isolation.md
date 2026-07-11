# A dev instance coexists with the installed service by isolation, enforced at boot

A daemon started from a checkout (#90) collides with the installed service
on exactly two shared resources, and both corrupt silently: Slack
load-balances Socket Mode events across every connection of one app, so a
shared `SLACK_APP_TOKEN` splits messages nondeterministically between the
two daemons, and a shared SQLite path makes two writers interleave state —
boot reconciliation would touch the other daemon's in-flight delegations.
We chose coexistence by isolation over the two alternatives: forbidding a
dev daemon while the service is active (kills the legitimate
dev-on-the-VPS loop), and convention-only docs (the first dev run with
prod tokens still in `.env` would split events with no error). A dev
instance owns a dev Slack app, its own database path and its own sidecar
port — the first is credentials, which no default can supply, so the
daemon boot enforces it: when the `orchestrator` unit is definitely active
and this process is not it (units carry `$INVOCATION_ID`), a
`SLACK_APP_TOKEN` or resolved-db-path match against the canonical env file
refuses the boot with the remediation in the message. Provable collisions
only — an unreachable user bus or unreadable env file fails open, because
ignorance must never block dev on a machine running no service. The
sidecar needs no guard: it is read-only and a port clash fails loudly on
its own. ADR 0002's line survives verbatim — a dev instance binds nothing
past loopback either.

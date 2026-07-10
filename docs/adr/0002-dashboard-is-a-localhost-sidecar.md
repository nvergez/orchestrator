# The dashboard is a localhost-bound sidecar, never a daemon endpoint

The stack decision (#3) picked Slack Socket Mode specifically so the daemon
exposes no inbound HTTP surface on the VPS — so a web dashboard looks like a
reversal. It isn't: the dashboard (#87) is a separate `orc`-managed process
that opens the SQLite state read-only and serves it on `127.0.0.1` (bind and
port env-configurable); the daemon still binds nothing. Two properties fall
out of the separation and are the reason for it: the daemon's no-listener
guarantee survives verbatim, and the ops view keeps working precisely when
the daemon is down or crashed — the moment it is most needed. Network
exposure beyond the machine (Tailscale, SSH tunnel) is deliberately the
operator's business, not the project's: the project never terminates remote
traffic, so it carries no auth story. Consequence for the daemon: it enables
WAL on the SQLite file so a concurrent reader can never trip its writes —
that pragma is load-bearing for the sidecar, not an optimization.

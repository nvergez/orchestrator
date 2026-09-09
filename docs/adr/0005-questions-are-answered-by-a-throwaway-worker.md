# A Question is answered by a throwaway worker, never by the coordinator

Answering "where is the config for X?" costs a fresh worktree and about a
minute of agent boot, which looks absurd next to handing the coordinator
session read-only file tools on the repos' main checkouts. We kept the
coordinator blind on purpose: its only tool is Bash, allow-listed to `orca`,
`gh` and `git` (spec §7), and the project's founding rule is that the daemon
coordinates and relays but never does the work itself. Read tools would
widen that boundary for every thread, tie the coordinator to checkout paths
and whatever branch they sit on, and fill its long-lived context with code.
A Question is instead a delegation like a Change, with a "answer, change
nothing" brief: the same supervision, gates, watchdog, cleanup and repo
skills apply, and the daemon posts the worker's answer verbatim, which the
coordinator could not vouch for anyway. The minute of latency is the price
of one machinery instead of two.

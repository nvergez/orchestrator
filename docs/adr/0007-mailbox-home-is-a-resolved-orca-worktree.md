# The mailbox home is a resolved Orca worktree, not the daemon's working directory

A thread mailbox is an Orca terminal, and Orca creates terminals only inside
a worktree it lists. The daemon used `process.cwd()` for that worktree — "the
daemon's own checkout, the one worktree that always exists and never gets
archived with a delegation" — which held while the daemon ran from its git
checkout. The packaged install broke the premise silently: the generated
systemd unit sets no `WorkingDirectory` (spec §10 forbids ordering the unit
against Orca and the checkout is no longer the deployed instance), so the
daemon's cwd is the home directory, and the first mailbox after the cutover
died with `selector_not_found`. No delegation had been attempted on the
packaged install until then, so the ⚠️ line was the first sign.

We resolve the home instead of assuming it, and we resolve it lazily. The
order is: `ORCHESTRATOR_MAILBOX_WORKTREE` when the operator set one — a
value Orca does not list is a configuration error reported as such, never
silently replaced by a guess; else the daemon's cwd when Orca lists it,
which keeps the checkout-run dev instance (ADR 0003) exactly where it was;
else the default repo's registered checkout, the one worktree every install
has because the routing hints must mark a default (spec §4). Lazily, because
Orca may be down at boot (spec §10) and a boot-time resolution would pin a
failure for the daemon's lifetime: the delegation coordinator asks at the
first mailbox, remembers a success, and turns a failure into the existing
"Orca runtime unavailable" line so the next mailbox asks again. `orc doctor`
runs the same resolution and prints the resolved home, so the answer is
visible before any delegation.

We did not add `WorkingDirectory=` to the unit: it would tie the service to
a checkout the packaged install is meant to retire, and a mailbox living in
the default repo's checkout is what an operator with one project expects to
see in Orca anyway.

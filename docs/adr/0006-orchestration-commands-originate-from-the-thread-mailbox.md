# Every orchestration command originates from the thread mailbox, which owns one Orca Run

Orca 1.4.198 retired the sender-less orchestration grammar: every
`orca orchestration` command now names a sender terminal (`--from`, or the
`ORCA_TERMINAL_HANDLE` of a live Orca terminal), a task can only be created
under a Run bound to that sender, the task list is scoped to that Run, and a
consuming `check` hands out one Delivery that replays until acknowledged.
The coordinator session runs its commands from the daemon's own process,
not from an Orca terminal, so the day the VPS updated, step 4 of the
delegation sequence died with `no_active_sender_terminal` and nothing was
dispatched. We already had the answer for the dispatch step alone — the
daemon appends the thread's mailbox terminal as `--from` (issue #9) — and we
chose to generalize it rather than hand the session a sender of its own.

The session never picks its sender. The daemon appends `--from <mailbox>`
to EVERY orchestration command it runs — `task-create`, `dispatch`, `reply`,
the read-only inspections — and denies a session-chosen `--from`: the sender
is what files a task under a Run and routes a worker's `worker_done`, `ask`
and `escalation` into a Run's inbox, so a session-chosen one would detach a
worker's reports from the only thread that can act on them. The mailbox
carries one Run, bound once when the mailbox is created (`run-create
--from <mailbox>`) and remembered beside the handle; a mailbox from before
Runs gets one on its next use, and a recreated mailbox re-binds its
previous Run (`run-use`) so workers still in flight keep reporting into
the same inbox. The alternative — the composed `worker-start` /
`worker-release` loop the new guide prefers — would rewrite the delegation
sequence, the cards and the cleanup for no product gain; the guide keeps
the low-level `worktree create` + `dispatch --inject` recipe valid, and
that is the recipe this daemon supervises.

Deliveries belong to the gate watcher. It acknowledges a handled batch on
its next window and settles the last one before it stops, drops the ack
after a failed window (an already-applied ack fails every retry as
`stale_delivery`, while an unacknowledged batch merely replays into the
handlers' duplicate guards), and the session is denied `check --ack` so no
turn can consume a thread's worker events from under the daemon.

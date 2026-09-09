# A Slack request creates no GitHub issue; the PR or the thread is its record

The v1 delegation sequence opened a GitHub issue before every worktree and
made its number the delegation's identity (`<repo>-<n>-<slug>`, `repo#n` in
the cards) and "the durable home for status and results beyond the Slack
thread". Once the main use case became small Questions and Changes asked
in Slack by anyone on the team, that issue was noise: nobody read it, a
Question changes nothing so it had nothing to track, and the ceremony was
invisible to the requester but real on the tracker. We chose to create no
issue: a Change's durable record is its pull request, whose body carries the
Slack thread permalink; a Question's record is the thread itself. A
delegation is identified by its worktree name, then by its PR link. An
issue the requester points at ("fix #123") is still reused and closed by
the PR. We gave up `Closes #n` automation and Orca's issue link on the
worktree card, which is why `--issue` is optional in the create step rather
than gone.

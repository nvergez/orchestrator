# The 🚦 is for what cannot be undone, and a proposal is a pull request

Issue #8 built the autonomy tiers fail-closed on both axes: a binary outside
`orca`/`gh`/`git` is denied, and *inside* those binaries anything the
classifier did not explicitly recognize as a read was gated. In practice the
second half was where the operator's days went. The whitelists could only
ever be as complete as the audit that wrote them, so every guessed CLI
spelling, every ordinary `gh pr comment`, every local `git commit` and every
`>` into a scratch file stopped the thread on a 🚦 the human had to answer
before anything continued — for a command that changed nothing they would
have minded. The gates that did matter drowned in them.

We inverted the inner default. The binary allow-list stays fail-closed —
it is the boundary that keeps arbitrary ops off the VPS, and command
substitution stays forbidden whole because it smuggles binaries past it.
Inside it, a recognized command runs, and the CONFIRM tier is now a short
named list of the irreversible: force and delete pushes, `reset --hard`,
`clean -f`, ref deletion, `worktree remove`, `stash drop`/`clear`,
`filter-branch`, taking an Orca worktree away, `gh pr merge`, releases,
issue deletion, `gh auth`, a writing `gh api`, and `rm`. Everything else — commits, branches, ordinary pushes, PRs, comments,
labels, redirections — runs silently. A command that is merely *wrong* is
now caught where wrong code has always been caught: on the pull request.

`orca terminal send` was gated too, as the one command whose blast radius is
another agent's, with the relay lifting the sends it could vouch for back to
AUTO. That sanction is gone with the gate: typing at a worker is undone by
the next keystrokes, and what a send may *carry* — an answer's fidelity, an
answered gate's refusal — was never the classifier's to decide, but the
relay's, which still enforces it on every send.

The same reversal applies to how a request becomes work. "In doubt,
Question" (#107) meant an ambiguous ask produced a worker whose deliverable
was an essay ending in "Reply *do it* and I'll open a PR" — a wall of text
whose only purpose was to collect a go, after which the identical
investigation ran again as a Change. In doubt is now Change: the pull
request IS the proposal, it is reviewed on GitHub and merged by a human, so
opening one costs the thread less than asking whether to open one. A worker
that finds the scope too big ships the most useful coherent slice and names
what it left out instead of stopping for approval; a Question leads with its
answer and keeps the offer of a fix to one closing line.

What we gave up: a wrong turn now costs a branch and a PR nobody merges
instead of a question, and the classifier no longer stops a coordinator that
decides to `git commit` something odd inside a worktree. Both were judged
cheaper than an operator who stopped reading the gates.

# Orchestrator

A Slack-driven orchestrator-dispatcher daemon: one Claude Code session per
Slack thread, delegating work to Orca worktree agents. Published to npm as
`@nvergez/orchestrator`, installing the `orc` CLI.

## Language

### Releasing

**Release**:
A published version of the package — git tag, npm publish, and GitHub Release
cut together. A release contains every pending change merged since the
previous release.
_Avoid_: Deploy, publish (alone)

**Release label**:
The `release` label on a pull request. Merging a PR that carries it triggers a
release. It is a trigger, not a selector: it decides *when* a release happens,
never *which* changes it contains.

**Pending changes**:
The releasable (`fix:`/`feat:`/breaking) merges accumulated on main since the
last release, waiting for the next release to ship them. A release trigger with
no pending changes releases nothing.

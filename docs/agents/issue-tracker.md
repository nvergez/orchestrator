# Issue tracker — this repo

This repo uses **GitHub Issues** on `nvergez/orchestrator` as its issue tracker.

## Wayfinding operations

How the `/wayfinder` skill's concepts map onto GitHub here:

- **Map** — a GitHub issue labelled `wayfinder:map`. Find it with:
  `gh issue list --repo nvergez/orchestrator --label wayfinder:map --state all`
- **Tickets** — GitHub native **sub-issues** of the map, each labelled `wayfinder:<type>` where `<type>` ∈ `research | prototype | grilling | task`.
  List them: `gh api /repos/nvergez/orchestrator/issues/<map#>/sub_issues --jq '.[].number'`
- **Blocking** — GitHub native issue-dependencies are **not** used (not reliably scriptable). Blocking is a **body convention**: a line `**Blocked by:** #N, #M` in the ticket body. A ticket is **unblocked** when every issue it lists is **closed**.
- **Claim** — assign the ticket to the driving dev *before* any work:
  `gh issue edit <n> --repo nvergez/orchestrator --add-assignee @me`
  An open, unassigned ticket is unclaimed; that assignee *is* the claim.
- **Frontier** — open sub-issues of the map that are **unassigned** and whose every "Blocked by" issue is **closed**.
- **Resolve** — post the answer as an issue **comment**, **close** the issue
  (`gh issue close <n> --repo nvergez/orchestrator`), then append a one-line pointer to the map's **Decisions so far**.
- **New tickets** — create the issue, add its `wayfinder:<type>` label, link it as a sub-issue of the map
  (`gh api -X POST /repos/nvergez/orchestrator/issues/<map#>/sub_issues -F sub_issue_id=<child db id>`),
  and add any `**Blocked by:**` line. Assets (research md, prototypes) are **linked** from the issue, not pasted into it.
- **Out of scope** — close the ticket and leave one line in the map's **Out of scope** section (gist + why), linking the closed issue. It never graduates.

Only ever resolve **one ticket per session**.

---
name: exercise-pr
description: Pre-registered live test pass over a PR — post the test plan as a PR comment, exercise every registered test via Orca's browser / direct API calls / dev-DB reads against the locally launched app, then post a results comment answering each one.
disable-model-invocation: true
metadata:
  author: nvergez
---

# Exercise PR

Prove a PR's behavior by exercising it live, under **pre-registration**: the test plan is posted to the PR as a comment *before* execution, and the results comment answers every registered test — pass, fail, or blocked. The two comments are the deliverable.

## Arguments

`/exercise-pr [pr]`

- `pr` — a PR number (`123`, `#123`). Default: the PR of the current branch (`gh pr view`).

## Preconditions

1. The PR resolves (`gh pr view <n> --json baseRefName,headRefName,body`) and its head is checked out locally with a clean working tree — evidence must reflect the head, not local edits.
2. Orca is running: `orca status --json` succeeds (on Linux outside Orca terminals the binary is `orca-ide`; bare `orca` is the GNOME screen reader). Browser commands (`orca tab create/goto/snapshot/click/...`) are documented in `orca skills get orca-cli`.
3. The app is launchable locally: find the project's dev command (package scripts, README, Makefile) and the base URL it serves.
4. Dev-DB access, if the project has one: connection details come from the project's env/config (`.env*`, config files). Unreachable DB is not fatal — its assertions grade `blocked`.

## Test model

A **test** exercises one behavior the diff changes, and declares up front:

- **id** — `T1`, `T2`, …
- **behavior** — the user-visible or API-visible claim under test.
- **drive** — how it is exercised: `browser` (Orca's embedded browser, for flows a user sees) or `api` (direct HTTP calls, for contract and logic behavior).
- **assertions** — the observables that decide it, including any **db** reads verifying persisted side effects. DB access stays read-only: side effects are confirmed with SELECTs; writes happen only through the app under test.

Verdicts: **pass** / **fail** / **blocked** (could not execute — reason cited). Every verdict cites **evidence**: a screenshot path, a request/response excerpt, a query and its rows. A verdict with no observable behind it is `blocked`, not `pass`.

Every registered test keeps its id and behavior through to its verdict. Tests discovered mid-run may be added, flagged "added during execution".

## Process

### 1. Scope

Read the spec (PR description, linked issue) and the diff from `$(git merge-base HEAD <base-branch>)`. List the behaviors the diff changes. Scoping is complete when every changed source hunk is either mapped to a planned test or listed as out of scope with its reason (pure refactor, needs prod-only credentials, …) — the out-of-scope list ships in the plan comment.

### 2. Pre-register

Design the tests and post the plan as the first PR comment (`gh pr comment`):

```markdown
## 🧪 E2E plan (pre-registered)

| # | Behavior | Drive | Asserts |
|---|----------|-------|---------|
| T1 | … | browser | UI shows …; db: row in … |

Out of scope: …
Results follow in a second comment after execution.
```

Once posted, the plan is **registered**.

### 3. Stand up

Launch the app with the project's dev command as a background process and wait until the base URL responds; open an Orca browser tab on it. If the app cannot be brought up, every test grades `blocked` and the run proceeds straight to step 5 — pre-registration means even a dead environment gets its results comment.

### 4. Execute

Dispatch one subagent — the **runner** — to execute the whole registered plan. A runner executes; it does not redesign. One runner, not one per test: the tests share the app, the tab, and the dev DB.

The dispatch carries:

- the registered plan table, verbatim — the runner's entire brief,
- the base URL and the tab opened in step 3, plus dev-DB connection details,
- `.scratch/e2e/` as the evidence directory,
- a pointer to this SKILL.md's § Test model, by absolute path — the `drive`, assertion, and verdict rules stay defined there, not restated in the prompt.

The runner works in id order: `browser` tests drive via `orca` browser commands, screenshotting each decisive assertion; `api` tests hit the local base URL, capturing request and a response excerpt; `db` assertions are read-only queries captured with their rows. A `fail` is a result, not an obstacle — record it and move to the next test. It returns one row per test: id, verdict, evidence path, and a one-line justification.

Execution is complete when the returned rows carry a verdict for every registered id. Re-dispatch once for any ids the runner dropped; still missing grades `blocked`.

### 5. Report

Build the comment from the runner's returned rows, citing its evidence paths as returned rather than re-opening them — the runner's justification line is the accountability. Post it as the second PR comment: a verdict table answering every registered test, same ids and order, added tests appended.

```markdown
## 🧪 E2E results

Overall: X pass / Y fail / Z blocked

| # | Behavior | Verdict | Evidence |
|---|----------|---------|----------|
| T1 | … | pass | screenshot .scratch/e2e/t1.png — success toast visible |
```

Then stop the app, close the browser tab, and give the user the same summary, fails first.

The run is complete when both comments are on the PR and every registered test carries a verdict with cited evidence — reported, not fixed: failures land in the comment; the fix decision stays with the user.

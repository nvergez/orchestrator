# Live e2e scenarios — driving the deployed bot

How to exercise the orchestrator end-to-end against the **deployed daemon** (no mocks): post to
a configured channel (your `SLACK_CHANNEL_IDS`) as an allowed user, watch `journalctl --user -u orchestrator -f`,
and verify worker side-effects on disk. First run: 2026-07-09 (findings became issues #45–#52,
all fixed and redeployed the same day).

## Ground rules

- Roots must @mention the bot. A mention in an unknown human thread opens a session
  with its earlier messages quoted as data; the mentioner's message is the instruction.
  Plain replies resume registered sessions and stay ignored in unknown threads.
- `close` is the bare word as the whole reply, **mention optional**. Only a longer sentence
  containing "close" is an ordinary turn (spec §3).
- Messages sent through the claude.ai Slack MCP arrive with a `*Envoyé avec* @Claude` context
  footer; the daemon extracts command/turn text from `rich_text` blocks only (#41), so commands
  still match.
- Use an isolated dev Slack app/database and test GitHub repo for Changes. A Question
  can target a sandbox folder repo. Mark exactly one repo as default in the hints;
  inspect PRs but never merge as part of this suite. These are manual scenarios,
  not authorization to use service credentials or production state for development.
- Ops note: `export XDG_RUNTIME_DIR=/run/user/$(id -u)` before `systemctl --user` / `journalctl --user`
  in Orca shells.

## Scenario suite

| # | Scenario (mock ref) | Drive | Expect |
|---|---|---|---|
| S1 | Session open + capability Q&A | Root: `@bot which repos can you delegate to, is Orca reachable?` | 👀 ack on root during the turn (#49); answer lists the routing-hints repos + runtime health; no gate |
| S2 | Default-repo routing | Root: `@bot where is the retry timeout configured?` | Announces Question on the configured Default repo and dispatches directly; no routing question or zero-match stop |
| S3 | Change without an issue | Root: `@bot in <test repo>, add <tiny feature>` | Announces Change; worktree named `<repo>-<slug>` with comment `change`, no new GitHub issue; worker tests, reviews, commits and opens a ready PR on the default branch; PR body has request, Slack permalink and verification; final Slack message starts with PR URL; card keeps PR link; worktree removed |
| S4 | Worker gate relay (mock C) | Root: delegation whose brief forces the worker to `ask` with numbered options before writing | ❓ relay: worktree name, question **verbatim** in blockquote, numbered options, "Reply in this thread"; root 👀→❓; reply `N` routes to the **live** gate, forwards option N's verbatim text (#50); re-asks supersede (one live relay, no duplicates, #46) |
| S5 | Mid-flight status (mock E) | Reply `where is <task> at?` (no mention) while a delegation runs | Snapshot answer from task-list/worktree ps, **zero 🚦** (#45); card stays the living surface |
| S6 | Close + closed thread | Reply `close` (no mention), then reply or mention again after | 🔚 summary with outcomes by worktree name, cost, turns; next reply gets the fixed "Session closed." line and never reopens |
| S9 | Mention-less resume (#38) | Reply in a registered thread with **no mention** | A turn starts (warm resume) and the bot answers; a *mentioned* reply still yields exactly **one** turn (the `message` copy is deduped, never a double turn) |
| S7 | 🚦 gate replies | Trigger any CONFIRM command (e.g. ask it to `worktree rm` something) | `go — <comment>` **approves** (#47); a denial gets a visible "taking that as a no" ack, never a silent identical re-gate; denied read still answers best-effort |
| S8 | Restart reconcile ("Daemon restart") | `systemctl --user restart orchestrator` with a delegation in flight | One ⚠️ line per affected thread, sessions not woken; next human message resumes supervision |
| S10 | Mention in a human thread | Colleague posts a code question, allowed user replies `@bot` | Opens with the mentioner as root user; reads all earlier authors, excluding the bot; quotes context as data; bare mention means handle this thread; unknown mention-less or third-party replies stay silent |
| S11 | Question and follow-up | Ask `@bot why does <failure> happen?`, then reply `do it` | 🔎 card; worker changes no files and makes no commits, pushes or PRs; its complete Slack-mrkdwn answer posts verbatim in order, card gains duration, root ✅, worktree removed, no coordinator completion turn; `do it` dispatches a Change with the earlier answer verbatim |
| S12 | Thread context limits and failure | Mention in a long thread; separately simulate a replies API failure in the dev app | Recent messages kept with a dropped-context note; a failed read still opens with the mention and one visible notice |
| S13 | Cited issue and repo selection | Request `fix #<existing issue> in <alias of other repo>` | Other repo selected directly, cited issue linked on worktree and closed by the PR; no issue creation; explicit requests for both repos create separate delegations |
| S14 | Question restart recovery | In a dev instance interrupt after saving a Question result, or after its first long-answer chunk | Restart delivers the remaining answer from the ledger, edits the card, settles root and cleans up; no coordinator wake. A task marked completed without an answer remains watched |
| S15 | Default validation | Run doctor with one repo and no marker, multiple repos and no marker, then two defaults | Single repo is implicit default; other two configurations fail with an actionable message; init example shows `default` |

| S16 | Image mention and image-only reply | Root `@bot why does this look wrong?` + PNG; follow with an image-only `file_share`, then `@bot` + another screenshot | One turn per message, 👀 sets/clears, coordinator acknowledges the picture; root image-only mention opens on the image instead of greeting |
| S17 | Context images and ordering | Colleague posts screenshots in a human thread; mention the bot with a before/after pair; separately use more than eight images | Instructing images keep Slack order, context is newest first with author labels and quoted as data; older excess images are noted silently; re-mention in a served thread reads only its own images |
| S18 | Image rejection and scope diagnostics | Send PDF/SVG, over-5-MiB or over-8,000-px images, then simulate failed downloads in the isolated dev app; repeat before granting `files:read` | One visible skip line per instructing message; words still run; context skips stay silent; missing-scope line says to reinstall; doctor is informational and boot logs one warning |
| S19 | Worker evidence and follow-up | Ask a Question with a screenshot, then `do it` to request a Change in the test repo | Each worker reads the same saved absolute path before working, treats image contents as evidence, and acknowledges the picture; no copy into or commit from a worktree |
| S20 | Attachment lifetime | Restart a dev instance with an image thread open; resume, then close; seed an orphan attachment directory while stopped and boot again | Open-thread files and paths survive restart; explicit/7-day close removes them after summary; boot removes closed/unknown directories without waking sessions |

**Image integration checks (#109):** capture an actual dev-app mention with a
screenshot and verify the acting `app_mention` has `files`. If it does not,
the design needs the bounded single-message history fallback described in the
issue. Verify that each worker sandbox permits reading the absolute state-dir
path. These checks require an isolated Slack app and worker; do not substitute
production credentials, or copy images into a worktree to hide a sandbox denial.

Not drivable single-user: third-party filter (G1/G2), the ⏳ session-cap queue, $5/$10 cost warnings
(would need real spend). Covered by unit tests instead.

## Failure modes to watch (seen live on 2026-07-09)

- **Worker-side orca CLI transient failure** ("The Orca runtime closed the connection" / "Orca is
  not running"): the worker can miss its `ask` answer and be unable to send `worker_done` while its
  TUI spinner keeps `lastOutputAt` fresh — invisible to the silence-based watchdog. The
  max-in-flight-age alert (#48, `WATCHDOG_MAX_INFLIGHT_MINUTES`) now covers the permanent case; the
  `terminal send` fallback covers answer delivery.
- Worker `ask` timeout retries arrive as **new** `decision_gate` msg_ids — the relay must supersede,
  not stack (#46). Replies to expired asks return `ok:true` and vanish worker-side: route to the
  newest gate.
- A failed worker keeps its worktree; successful cleanup can be refused by a dirty tree,
  producing one 🧹 notice. A Question answer remains durable even after cleanup.

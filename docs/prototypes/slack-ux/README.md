# PROTOTYPE — Orchestrator Slack UX

> **Throwaway artifact** for ticket [#7 — Orchestrator Slack UX (format, status, threading)](https://github.com/nvergez/orchestrator/issues/7).
> This is not code: it's a **mock of Slack conversations** to critique. Once the UX
> is validated, the decision is captured in the ticket's resolution comment; this folder
> remains as a visual reference for the implementation.

## The question

What does the Slack interface **look like** and how does it **behave** — the "stylish" that was asked for?
The mock embodies the 8 decisions already made on the map (#2–#6, #8–#10); it does not re-decide
any mechanism, only their **rendering**.

## Guiding principle: "edit the status, post the event"

Slack physics: **editing a message notifies nobody**; a new message in a followed
thread does. Hence the rule that structures the whole mock:

- Anything that **requires the human** (gate, escalation, question, stalled worker, done) = **new
  message** in the thread → notification.
- Anything that is **ambient state** (progress, last sign of life) = **in-place
  edit** (post-then-edit, per #3) or **reaction** → zero noise.

## Two surfaces per thread

1. **The voice** — the session's conversational messages (replies, questions, acknowledgments).
   Streamed via post-then-edit (~1 edit/s, Tier 3 throttled per #3).
2. **The card** — one status message **per delegation**, posted at dispatch then **edited at
   milestones** (orchestration events + "last sign of life"). Never a token stream
   in it: it's a dashboard, not a terminal.

## The ticket's 4 slices — choices made in this mock

| Slice | Prototyped choice |
|---|---|
| **Status rendering** | **Hybrid**: bot reactions on the root message = coarse state readable from the channel (👀 in progress, ❓ blocked on you, 🚨 alert, ✅ delivered, ❌ failure — the bot removes the stale one); edited card = per-delegation detail. **Pure mrkdwn in v1** — per #9 text is the mechanism, Block Kit = optional comfort layer (variant in [block-kit.md](block-kit.md)). |
| **Streaming granularity** | Two regimes. Voice: post-then-edit as generation flows. Card: edited **at milestones** (worktree created, brief handed off, worker status/heartbeat, done) + a "last sign of life" line refreshed at most once every 2 min. |
| **Links** | GitHub (issue, PR, commit) = rich links `<url\|repo#n>`. Worktree = no URL: **path in code** `~/orca/workspaces/<repo>/<worktree>`. The **card** carries the durable links; the voice may repeat them in the summary. |
| **Pinned welcome** | **No welcome** — neither pinned per thread, nor pinned/canvas at the channel level. Usage is learned by practice: the polite refusal guides third parties, and the reactions and cards are self-explanatory. *(Decided in a HITL iteration — the proposed channel pin was rejected.)* |

## Emoji lexicon (stable, never decorative)

| Emoji | Meaning | Where |
|---|---|---|
| 👀 | session/delegation in progress | root reaction |
| ❓ | gate/question awaiting YOUR reply | root reaction + gate message |
| 🚦 | one-line autonomy gate (push/merge/deploy/deletion) | message |
| 🚨 | worker escalation | root reaction + message |
| ⚠️ | stalled worker (watchdog) / boot-time reconciliation | message |
| ✅ | delivered / relayed | root reaction + card + acknowledgments |
| ❌ | failure | root reaction + card |
| ⏳ | queued (session cap) | message |
| 💸 | cost warning ($5/$10) | message |
| 🔚 | closing summary | message |
| ⚙️ | delegation in flight | card |

## Map decisions → where to see them in the mock

| Decision | Embodied in |
|---|---|
| #3 post-then-edit + throttle | scenario A (streamed voice, edited card) |
| #4 issue-linked delegation, worktree `<repo>-<issue#>-<slug>` | cards in scenarios A/C, links |
| #5 root mention, resume without re-mention, ⏳ queue, close, closed thread | scenarios A, F; brief moments |
| #8 one-line gates, $5/$10 thresholds, polite refusal of a third party, boot | scenarios B, D, G; brief moments |
| #9 gate = worker + **verbatim** question + numbered options; ✅ relayed | scenario C; brief moments (🚨, ⚠️) |
| #10 clarify-on-doubt ≡ confirmation (a single round trip); conditional gate | scenarios A (clarify) and B (direct delegation) |

## Files

- [`conversations.md`](conversations.md) — the 7 key scenarios + the brief moments.
- [`block-kit.md`](block-kit.md) — Block Kit variant (card + gate), **not adopted by default**.

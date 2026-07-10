# Slack conversation mock — `#orchestrator`

Reading convention: each quoted block `>` is **one Slack message**. `**who** — time` at
the top. The *(annotations in italics)* are not messages: they explain the mechanics.
When a message is **edited in place**, its successive versions are shown with
"✏️ the same message, after editing". Repos, issue links, and Slack IDs are
fictional examples (`acme/webapp`, `U0EXAMPLE456`, …).

---

## A — Full nominal path: request → clarify → delegation → progress → done

*(Root message in the channel. Session opened by @mention on the root, per #5.)*

> **Nicolas** — 14:02
> @orchestrator add a small CSV export of the send metrics
>
> reactions: 👀 *(added by the bot: "I'm on it")*

*(Everything that follows happens in the thread. Routing runs silently: `orca repo list
--json` + hints → two credible candidates → clarify-on-doubt, per #10. The bot's reply
appears via post-then-edit — truncated at first, then complete in ~2 s:)*

> **orchestrator** `APP` — 14:02
> Two repos could match:
> **1.** `webapp` — the product: the export would live in the app, wired to real data
> **2.** `sandbox` — scratch space: a one-shot script alongside the product
> I'd go with the **claude** agent. Reply **1**, **2**, or name another repo.
>
> root reaction: 👀 → ❓

*(Per #10: the disambiguation **is** the confirmation — a single round trip. Replying "1"
counts as go, including for the announced agent. No second gate.)*

> **Nicolas** — 14:03
> 1

*(Immediate delegation, per #4: GitHub issue created on the target repo, worktree
`<repo>-<issue#>-<slug>`, brief via `dispatch --inject`. The bot posts **the card** — a
status message that will be edited at milestones, never re-posted:)*

> **orchestrator** `APP` — 14:04
> ⚙️ **webapp#84 — CSV export of send metrics**
> `webapp-84-csv-export` · claude · issue [webapp#84](https://github.com/acme/webapp/issues/84)
> • 14:04 — issue created, worktree ready, brief handed off (task `t-3f81`)
>
> root reaction: ❓ → 👀

*(✏️ the same message, after editing — 14:12, on a worker `status`. Edits don't
notify: that's intentional, it's ambient.)*

> **orchestrator** `APP` — 14:04 *(edited)*
> ⚙️ **webapp#84 — CSV export of send metrics**
> `webapp-84-csv-export` · claude · issue [webapp#84](https://github.com/acme/webapp/issues/84)
> • 14:04 — issue created, worktree ready, brief handed off (task `t-3f81`)
> • 14:12 — worker: "endpoint `/metrics/export` in place, tests running"
> • last sign of life: 2 min ago

*(14:31 — `worker_done`. The daemon wakes the session (per #9), which does two things:
it **edits the card** to its final ✅ state — the durable links live there — and posts a
**short summary** as a new message, because "it's done" deserves a notification.)*

> **orchestrator** `APP` — 14:04 *(edited)*
> ✅ **webapp#84 — CSV export of send metrics — delivered in 27 min**
> • PR: [webapp#87 — Add CSV export of send metrics](https://github.com/acme/webapp/pull/87) *(ready for review)*
> • issue: [webapp#84](https://github.com/acme/webapp/issues/84) — resolution comment posted
> • worktree: `~/orca/workspaces/webapp/webapp-84-csv-export`

> **orchestrator** `APP` — 14:31
> ✅ Delivered — [webapp#87](https://github.com/acme/webapp/pull/87) ready for review:
> `/metrics/export` endpoint + dashboard button, tests green. Details in the card ⤴
>
> root reaction: 👀 → ✅

---

## B — Autonomy gate (push)

*(Repo and action explicit in the request → direct delegation/action, no routing
confirmation gate, per #10. But `git push` is in the CONFIRM category, per #8:
`canUseTool` suspends the command and posts a ONE-line gate.)*

> **Nicolas** — 09:15
> @orchestrator PR webapp#87 has a conflict — rebase it on main and re-push
>
> reactions: 👀

> **orchestrator** `APP` — 09:16
> Rebase done in `webapp-84-csv-export`, conflict resolved (lockfile), tests green.
>
> root reaction: 👀

> **orchestrator** `APP` — 09:18
> 🚦 `git push --force-with-lease` on `webapp/csv-export-metrics` — go?
>
> root reaction: 👀 → ❓

> **Nicolas** — 09:20
> go

> **orchestrator** `APP` — 09:20
> ✅ Pushed — CI re-triggered on [webapp#87](https://github.com/acme/webapp/pull/87).
>
> root reaction: ❓ → ✅

*(The 🚦 gate is an ordinary thread message awaiting a reply — not a button,
not a DAG `decision_gate`. Same mold for merge, deploy, deletion:
"🚦 `gh pr merge webapp#87` (squash) — go?", "🚦 `orca worktree delete
webapp-84-csv-export` — go?".)*

---

## C — Worker gate relayed: verbatim question + options → reply

*(A delegation `tooling#53` has been in flight for 20 min; the session has gone dormant (30 min TTL
per #5). The worker posts an `ask`. The daemon — which is listening, per #9 — wakes the session, which
posts a **new** gate message. Content contract per #9: who is asking, the question
**verbatim, never paraphrased**, the numbered options, the instructions.)*

> **orchestrator** `APP` — 16:40
> ❓ **`tooling-53-lint-ci`** ([tooling#53](https://github.com/acme/tooling/issues/53)) asks:
>
> > Two lint configs coexist (`.eslintrc.cjs` at the root, `eslint.config.mjs` in
> > `app/`). Which one is authoritative for CI?
> > **1.** `.eslintrc.cjs` (root)
> > **2.** `eslint.config.mjs` (app/)
> > **3.** Merge both into flat config
>
> Reply in this thread — a number or free text.
>
> root reaction: 👀 → ❓

> **Nicolas** — 16:52
> 3

*(A single pending gate in this thread → the reply routes to it without ceremony, per #9.
"3" is relayed as the **full text of option 3, verbatim** — the LLM never
rephrases a human decision. Sent back down via `orchestration reply --id`.)*

> **orchestrator** `APP` — 16:52
> ✅ Relayed to `tooling#53` — "Merge both into flat config"
>
> root reaction: ❓ → 👀

*(The delegation's card, higher up in the thread, is edited: the "❓ awaiting
your reply" line goes back to "⚙️ in progress".)*

---

## D — Cost warning

*(SQLite ledger per session, per #5/#8: configurable thresholds, defaults $5 then $10.
Measurement only — never blocking. New message: crossing a threshold deserves a
notification, not an edit.)*

> **orchestrator** `APP` — 17:20
> 💸 This thread has cost **$5.03** ($5 threshold crossed) — info only, nothing is blocked.
> Next warning at $10.

*(Counts the orchestrator session only: delegated workers' tokens don't feed
into the v1 ledger — limitation accepted in #8.)*

---

## E — "Where is X at?"

*(On-demand status = the third path of the "progress" slice: the card is the
ambient dashboard, but you can always ask. Reply = **new** snapshot
message; the card remains the living surface.)*

> **Nicolas** — 15:05
> where is the CSV export at?

> **orchestrator** `APP` — 15:05
> ⚙️ Still in progress — `webapp-84-csv-export` (claude) has been working for 22 min.
> Last status (3 min ago): "endpoint done, wiring up the dashboard button".
> No question pending. Details: card ⤴

*(Sources: `task-list`, `worktree ps`, latest `status`/heartbeats — no guessing.
If the session was dormant, this message woke it like any human message.)*

---

## F — Dormant session, woken without ceremony

*(Last exchange at 14:31. 30 min warmth TTL → the session went dormant at ~15:00:
process reaped, `session_id` persisted, per #5. NO dormancy message — it's a
technical state, not an event. At 17:48, resume in-thread **without re-mention**:)*

> **Nicolas** — 17:48
> by the way, also add a JSON export

> **orchestrator** `APP` — 17:48
> Nice follow-up to [webapp#84](https://github.com/acme/webapp/issues/84) — I'll create
> a linked issue and delegate on **webapp** with **claude**. Go?

*(The cold wake via `resume` costs a few seconds of latency — that's ALL the
human perceives. The confirmation gate reappears here because repo/agent are inferred
from context, per #10.)*

### F′ — Cap reached: the queue

*(5 live sessions, all mid-turn, per #5: never a hard rejection, never lost work
— the message is queued and announced:)*

> **orchestrator** `APP` — 11:02
> ⏳ Queued (5 active sessions) — I'll get to it as soon as a slot frees up.

---

## G — A third party writes

*(User allow-list in env, v1 = a single user, per #8.)*

**G1 — root @mention by a third party → polite refusal, no session created:**

> **Charline** — 10:12
> @orchestrator deploy webapp to prod

> **orchestrator** `APP` — 10:12
> v1: only <@U0EXAMPLE456> can drive me.

*(Discoverable: a colleague trying it out doesn't think the bot is broken. No 👀 reaction, no
session.)*

**G2 — third-party reply in an active thread → silently ignored:**

> **Charline** — 10:31 *(in the CSV export thread)*
> actually do it in Go instead

*(Nothing. The message is never injected into the session — anti-injection guardrail per #8:
in-thread resume happens without re-mention, so without this filter anyone could
drive a running session. Deliberate silence — no "I'm ignoring you" polluting the thread.)*

---

## Brief moments

### Explicit close — `@orchestrator close`

> **Nicolas** — 18:30
> @orchestrator close

> **orchestrator** `APP` — 18:30
> 🔚 Session closed.
> • 2 delegations: ✅ `webapp#84` (PR [#87](https://github.com/acme/webapp/pull/87) merged) · ✅ `webapp#91` (JSON export, PR [#93](https://github.com/acme/webapp/pull/93) to review)
> • thread cost: $6.84 · 19 turns
> Mention me on a new root message to start again.

### Reply in a closed thread

> **Nicolas** — *(3 days later, in the same thread)*
> and an XML version?

> **orchestrator** `APP`
> Session closed. Mention me on a new root message to start again.

*(Verbatim from #5: `closed` is final and predictable — no reopening in v1.)*

### Daemon restart — reconciliation

*(Per #8: at boot, re-read in-flight delegations, reconcile with `task-list`/`worktree
ps`, post ONE line per affected thread — without waking the session.)*

> **orchestrator** `APP` — 08:04
> ⚠️ Restarted — `webapp#84` was in flight: still in progress (last sign
> 4 min ago). Reply to resume supervision.

### Zero match — stop + list

> **Nicolas** — 11:40
> @orchestrator fix the showcase site bug

> **orchestrator** `APP` — 11:40
> No repo I drive matches. I know: `webapp`, `tooling`, `sandbox`,
> `orchestrator`. Rephrase targeting one of them.

*(Per #10: never a silent fallback, no catch-all `sandbox`.)*

### Worker escalation

> **orchestrator** `APP` — 15:47
> 🚨 **`webapp-84-csv-export`** ([webapp#84](https://github.com/acme/webapp/issues/84)) escalates:
>
> > The e2e tests break on `main` even without my changes — I'm pausing until further notice.
>
> Reply in this thread.
>
> root reaction: 👀 → 🚨

*(Same contract as the ❓ gate — verbatim, but flagged urgent and usually without options,
per #9.)*

### Stalled worker (watchdog)

> **orchestrator** `APP` — 16:20
> ⚠️ **`sandbox-21-bench`** ([sandbox#21](https://github.com/acme/sandbox/issues/21)) seems stalled —
> no sign for 25 min, without having asked a question. Last output:
>
> > `? Overwrite existing bench.json? (y/N)`
>
> Tell me what to answer, I'll relay it to its terminal.
>
> root reaction: 👀 → 🚨

*(Sent back down via `terminal send` — no `reply` possible, there is no `ask`, per #9.)*

### Welcome

*(None — neither pinned per thread, nor pinned/canvas at the channel level. Decided in a
HITL iteration: usage is learned by practice — the polite refusal guides third parties, and the
reactions and cards are self-explanatory.)*

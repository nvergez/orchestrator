# Orchestrator — v1 Specification

> The executable spec this repo's [wayfinder map (#1)](https://github.com/nvergez/orchestrator/issues/1) was finding its way to.
> Every section below condenses a decision resolved on the tracker; the linked ticket holds the full rationale, the alternatives that were rejected, and the HITL discussion. When this document and a ticket disagree, the ticket wins.

**What it is.** A Slack-driven **orchestrator-dispatcher**: a single long-lived Node daemon on the operator's VPS that gives a Claude Code agent a Slack presence — **one session per Slack thread** — and lets it interpret requests, **delegate** the work to Orca worktree agents (any allow-listed repo), **supervise** them (worker questions and escalations relayed into the thread), and report status + results back. The orchestrator *never codes itself*; it routes, delegates, supervises, relays.

**Non-goals (v1)** — ruled out of scope on the map:
- Managing Orca automations from Slack.
- Creating / registering new Orca repos or projects from Slack.
- Running arbitrary commands / ops on the VPS (hard-denied by the tool guardrails).

---

## 1. Architecture overview

```
Slack (the configured channels, Socket Mode)
   │  app_mention / message events        one Bolt WebSocket
   ▼
┌──────────────────────────────────────────────────────────────┐
│  orchestrator daemon (Node/TS, systemd user unit)            │
│                                                              │
│  Slack Bolt (Socket Mode) ── event filter (user allow-list)  │
│  Session manager ── Claude Agent SDK, 1 session / thread     │
│  Gate watchers ── `orca orchestration check --wait` children │
│  Watchdog sweep ── `worktree ps` / `tui-idle`                │
│  SQLite: sessions · delegations · pending_gates              │
│    (~/.local/state/orchestrator/orchestrator.db)             │
└──────────────────────────────────────────────────────────────┘
   │  Bash tool, guarded by canUseTool (orca / gh / git only)
   ▼
Orca runtime (headless, system unit) ── worktrees + worker agents
```

Stack decision ([#3](https://github.com/nvergez/orchestrator/issues/3), research asset: [`docs/research/slack-claude-bridge.md`](research/slack-claude-bridge.md)):
- **Slack half**: Bolt (JS) in **Socket Mode** — outbound WebSocket, no public URL/reverse proxy. Internal (non-distributed) app to keep Tier-3 rate limits.
- **Claude half**: **Claude Agent SDK (TypeScript)**, in-process — one `claude` subprocess per thread (fault isolation), session resume via `session_id`, streaming input to inject replies into live sessions, `canUseTool` as the enforcement hook, per-turn cost on `ResultMessage`.
- Rejected: headless CLI shell-out per message (re-implements session tracking), Slack HTTP Events (needs inbound URL), Anthropic-hosted managed agents (`orca` must run on the same machine as the daemon), homegrown loop on the Messages API.

## 2. Slack surface

Provisioned ([#2](https://github.com/nvergez/orchestrator/issues/2)) on the operator's Slack workspace — to provision your own app, see [`docs/setup-slack.md`](setup-slack.md). IDs below are placeholders for the instance's real values:
- App `@orchestrator` (bot user `U0EXAMPLEBOT`), Socket Mode ON. **Multi-channel & multi-user** (issue #93): the daemon serves the channels in `SLACK_CHANNEL_IDS` (e.g. `C0EXAMPLE123` — a **private** channel in this deployment, bot a member of each) for the users in `SLACK_ALLOWED_USER_IDS` (e.g. `U0EXAMPLE456`). One channel and one user remain the smallest valid deployment; the legacy singular env vars still configure exactly that.
- Bot scopes (6): `chat:write, app_mentions:read, channels:history, groups:history, reactions:write, users:read`. Events: `app_mention`, **`message.groups`** (+ `message.channels`).
  - The channel's **privacy decides the message event**: Slack emits `message.groups` for private channels and `message.channels` for public ones — `groups:history` is load-bearing, not incidental. Subscribing to only `message.channels` on a private channel silently delivers **no message event at all**, so plain thread replies never reach the daemon while `app_mention` keeps working ([#38](https://github.com/nvergez/orchestrator/issues/38)). Both subscriptions arrive as `type: "message"` (private ones carry `channel_type: "group"`), so one listener handles either; a mention fires the `message` copy *and* `app_mention`, deduped by the filter.
- `channels:read` is **not granted and not needed** (the channel list is pinned by configuration, membership is never queried; no `conversations.info/members`).
- Secrets in the daemon's env file (chmod 600, outside git; template `.env.example`).

## 3. Session model — thread ↔ Claude Code session

Decision [#5](https://github.com/nvergez/orchestrator/issues/5). Guiding principle: **process liveness ≠ session existence** — the persisted `session_id` is the durable anchor; the subprocess is transient.

- **Open**: an allowed user's **@mention**, at the channel root or in a reply to an unregistered thread (#107). On a reply opener, fetch earlier messages with `conversations.replies` using the existing history scopes. Quote each message with its author as data, excluding the bot's own messages; only the mentioning message is an instruction. A bare reply mention means “Handle this thread.” Root bare mentions retain their greeting behavior. `root_user` is the mentioner, even if someone else authored the root.
- **Thread context**: paginate through messages before the mention, keep the most recent messages within a 12,000-character body cap, and note dropped context. A read failure opens with the mention alone and one visible warning. Events for the same thread are serialized while the opener reads.
- **Resume**: any reply in a registered thread, no re-mention needed. Ignored: bot's own messages, `subtype` events, other bots, mention-less replies in unregistered threads (never a ghost resume). Re-mentions in registered threads are ordinary turns and never re-read earlier messages; closed threads stay final.
- **States**: `live` (turn in progress, or warm ≤ 30 min after last turn) ⇄ `dormant` (no process; cold-resume via `query({ resume: session_id })`) → `closed` (final).
- **Concurrency**: FIFO per thread (double-posts queue until next `ResultMessage`); **global cap of 5 live sessions** (env-configurable). At the cap: reap the coldest finished-turn session, else queue the message and post `⏳ queued`. Never a hard reject.
- **Close**: an explicit `close` — the bare word as the whole thread reply, **mention optional** (it was mention-only while mention-less replies never reached the daemon, [#38](https://github.com/nvergez/orchestrator/issues/38)) — posts a closing summary (delegations, cost, turns); or auto-close after **7 days** dormant. Thread-only: a mention-less `close` at the channel root opens nothing, a mentioned one opens a session. A longer sentence containing the word is an ordinary turn. Reply in a closed thread → one fixed line, no resume. No implicit close on task completion.
- **Boot rule**: every session comes back **dormant**; a turn orphaned by a crash waits for the next human message (no auto-resume in v1).

## 4. Repo routing & agent selection

Decision [#107](https://github.com/nvergez/orchestrator/issues/107), superseding #10's routing round trip.

- **Closed candidate set**: load the living registry (`orca repo list --json`) and enrich it with the operator's hints: aliases, description, keywords, default agent and a `default` marker. Only repos in both the hints and registry are delegable.
- **Default repo**: exactly one hint has `"default": true`. A single-repo file without a marker is implicitly default; multiple repos without a default, or multiple defaults, fail startup with an actionable message. `orc doctor` shows the default and `orc init` scaffolds the field.
- **Routing**: choose the default unless the request identifies another delegable repo by canonical name, alias or keyword. Explicit requests for both repos create one delegation per repo, in worker-cap waves. No routing confirmation, numbered disambiguation, or zero-match stop. Registry failures and off-list targets still fail explicitly.
- **Agent precedence**: explicit user choice > per-repo default > global **claude**. Both deployed repos use Claude; Codex remains accepted by the protocol.
- **Kind**: “how”, “why”, “where” and ambiguous requests are a **Question**; “fix”, “add”, “implement”, “change” are a **Change**. In doubt, Question. Announce kind and repo in one informational line and proceed. Repo-less capability/status turns stay with the coordinator.

## 5. Delegation & supervision (Orca)

Decision [#4](https://github.com/nvergez/orchestrator/issues/4), refined by [#9](https://github.com/nvergez/orchestrator/issues/9). The orchestrator session **is** the coordinator (manual coordination; no autonomous `orchestration run`).

**Delegation sequence** (after routing):

```bash
orca worktree create --repo id:<repoId> --name <repo>-<slug> \
  --agent <codex|claude> --comment <question|change> --no-parent --json          # no --prompt!
orca terminal list --worktree id:<newWtId> --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration task-create --spec "<brief>" --task-title "<short>" \
  --display-name "<worktree-name>" --json
orca orchestration dispatch --task <taskId> --to <handle> --inject --json
```

The brief travels via **`dispatch --inject`** (never `--prompt` at create time — the worker must get the coordinator preamble to emit `worker_done`). No GitHub issue is created for a Slack request ([ADR 0004](adr/0004-slack-requests-create-no-github-issue.md)). Add optional `--issue <n>` only for a cited issue and close that issue in the PR. The required `--comment` is exactly `question` or `change`. Repo identity comes from resolving `--repo` against the registry; the name is only the display reference.

**Every `orca orchestration` command originates from the thread mailbox** ([ADR 0006](adr/0006-orchestration-commands-originate-from-the-thread-mailbox.md)). Since Orca 1.4.198 the runtime refuses a sender-less orchestration command and files tasks under the Run bound to the sender, so the daemon appends `--from <mailbox>` to each one the session runs — `task-create`, `dispatch`, `reply`, the read-only inspections alike — and denies a session-chosen `--from`. The mailbox carries one Orca Run, bound once per handle (`run-create --from <mailbox>`), remembered beside the handle, and re-bound to a recreated handle (`run-use`) so workers still in flight keep reporting into the same inbox. A mailbox from before Runs gets one bound on its next use. `check --ack` stays the daemon's alone.

**Where the mailboxes live** ([ADR 0007](adr/0007-mailbox-home-is-a-resolved-orca-worktree.md)): a mailbox is an Orca terminal, so it needs an Orca worktree that always exists and never gets archived with a delegation. The packaged daemon runs from no checkout (its unit sets no `WorkingDirectory`), so the home is resolved lazily at the first mailbox, strongest first: `ORCHESTRATOR_MAILBOX_WORKTREE` when set (a value Orca does not list is a configuration error, never replaced), else the daemon's cwd when it is an Orca worktree (the checkout-run dev instance), else the default repo's registered checkout. A success is remembered for the daemon's lifetime; a failure surfaces as the ⚠️ line and is asked again at the next mailbox. `orc doctor` reports the resolved home.

**Fixed briefs** live in code and are rendered into the coordinator's prompt. It copies the matching skeleton and fills in the request, a digest of thread context, the Slack permalink, and a relevant earlier answer verbatim for a follow-up Change. The permalink is built from the workspace URL returned by Slack `auth.test` and the thread's channel/timestamp.

- **Question** ([ADR 0005](adr/0005-questions-are-answered-by-a-throwaway-worker.md)): fresh worktree, answer from code, change nothing — no file edits, commits, pushes or PRs. Use `/diagnosing-bugs` when available for failure diagnosis. Write Slack mrkdwn without Markdown headers, identify what could not be verified, and offer “Reply *do it* and I'll open a PR” when a fix is evident.
- **Change**: inline the implement process — `/tdd` at agreed seams, focused tests and typechecks while iterating, full applicable checks, `/code-review`, resolve findings, commit. If skills are absent, execute the process directly. Decide naming, placement and style autonomously; gates are for ambiguities that change the outcome or external contracts. Too large for one PR → report a split before starting; nothing to change → plain report. Otherwise open a ready-for-review PR against the default branch, following repo conventions, with request + Slack thread link + verification in the body. Never merge. Push/PR failures report failure with the reason. The worker_done report starts with the PR URL.

**State detection — two layers.** Authority = structured messages (`worker_done`, `escalation`, `decision_gate` via `check --wait`) + `task-list` (asked from the thread mailbox: the list is scoped to its Run). A `worker_done` states its verdict with `--outcome succeeded|failed` (Orca ≥ 1.4.198), which wins; a report without one falls back to the `Failed: <reason>` subject contract. Watchdog = `worktree ps` `agents[].state` / stale `lastOutputAt` / `tui-idle`, to catch a worker stalled at a prompt without an `ask` → "needs attention" in the thread. A second watchdog signal ([#48](https://github.com/nvergez/orchestrator/issues/48)) catches the inverse — a worker that LOOKS alive (a TUI spinner keeps `lastOutputAt` fresh) but whose bus said nothing (no heartbeat, ask or done) past a max in-flight age (`WATCHDOG_MAX_INFLIGHT_MINUTES`, default 30): same ⚠️ mold, quoting the agent's `state` + `lastAssistantMessage` from `worktree ps`; any bus message from the worker resets the clock. A `check` timeout or `{count:0}` is a checkpoint, not a failure.

**Parallelism**: one coordinator (mailbox) per thread → no cross-thread leakage on the runtime-global bus; multi-repo fan-out in waves; a self-imposed global cap on concurrent workers.

**Cleanup on success** ([#43](https://github.com/nvergez/orchestrator/issues/43)): once a delegation closes as completed — at `worker_done` time or by boot reconciliation — the daemon removes the worktree it created (`orca worktree rm`, deliberately **without** `--force`: a dirty tree makes the runtime refuse, the worktree stays on disk for inspection and the thread gets one 🧹 line saying why). A **failed** delegation always keeps its worktree for debugging. This daemon-side removal is not a session Bash call, so §7's CONFIRM tier does not apply — the gate remains for any deletion the *coordinator session* attempts itself.

## 6. Gate relay — worker questions into the thread and back

Decision [#9](https://github.com/nvergez/orchestrator/issues/9). Architecture: **the daemon listens, the session thinks.**

- After a dispatch the session **ends its turn** and may doze; the **daemon** holds one child `orca orchestration check --wait --terminal <mailbox> --types worker_done,escalation,decision_gate` per thread with in-flight work (rolling windows). The mailbox is a lightweight terminal `slack-<thread_ts>`, lazily created at the thread's first orchestration command, remembered in SQLite with the Orca Run bound to it, and passed as `--from` on every orchestration command ([ADR 0006](adr/0006-orchestration-commands-originate-from-the-thread-mailbox.md)). A window returns one **Delivery** that replays identically until acknowledged: the daemon acknowledges a handled batch on its next window (`check --ack <deliveryId> --wait`) and settles the last one before the watcher stops; a failed window drops its ack (an already-applied one fails every retry as `stale_delivery`), and the replayed batch lands in the handlers' duplicate guards — at-least-once, never lost.
- A **Change completion** stores the report, flips the card, settles the root, and wakes the session for a summary starting with the PR link when present. If no session can wake, the daemon posts the PR-first summary or the no-PR report itself. Failures retain the existing ❌/reason/wake behavior for both kinds. A **Question completion** stores the answer and settles the root in terminal-event order, then posts its body verbatim as ordered messages, finishes the light card with duration and removes the worktree, with **no coordinator wake**. Posting failures retry from a durable per-message checkpoint, including after restart; delayed delivery never overwrites a newer root reaction. Stable client message ids accompany retries; a crash between Slack acceptance and checkpointing can still depend on Slack's deduplication behavior. Boot re-arms watchers for both in-flight work and pending Question deliveries.
- **Relay up** (new message, never an edit): worktree name + optional cited issue link, the worker's question **verbatim** (blockquote, never paraphrased), numbered options if any, "reply in this thread". `escalation` = same, marked 🚨. Watchdog = same mold + last terminal output. One exception ([#46](https://github.com/nvergez/orchestrator/issues/46)): a worker re-asking the same question after an `ask` timeout **edits** the existing relay in place — one notification per logical question; the stale gate flips to `superseded`, forwarding to the re-ask.
- **Route back down** — the LLM routes the human reply, anchored on the SQLite `pending_gates` registry:
  - `decision_gate` / `escalation` → `orca orchestration reply --id <msg_id> --body "<answer>"` (nominal path);
  - worker stalled at a TUI prompt (no `ask`) → `orca terminal send --terminal <handle> --text "…" --enter`;
  - **never `gate-resolve`** in this relay (DAG gates are reserved for coordinator DAG decisions).
  - Fidelity: "2" → forward option 2's text verbatim; free text as-is. The LLM never rephrases a human decision.
- **Continuity**: each human turn gains recent Question answers for its own thread, newest first (up to five, each capped at 6,000 characters with a truncation note). “Do it” or “no, fix it” becomes a Change on that subject and repo, embedding the relevant answer verbatim. No answer block is added when none exist.
- **Disambiguation**: cross-thread impossible by construction (per-thread mailbox + registry filtered by `thread_ts`). Intra-thread with 2+ pending gates → LLM match on clues, **clarify-on-doubt** at the slightest doubt. An `answered` gate never re-routes (best-effort correction via `terminal send`).

## 7. Autonomy & security boundaries

Decision [#8](https://github.com/nvergez/orchestrator/issues/8). Enforcement = the SDK's **`canUseTool`** hook on the Bash tool, three tiers:

| Tier | What | Behavior |
|---|---|---|
| **AUTO** | reads/observation (`orca repo list`, `worktree ps`, `terminal list/wait`, `check`, `task-list`, `gh …view/list`); the full delegation sequence; relays carrying a human reply | silent |
| **CONFIRM** | `git push` / `git merge`, `gh pr merge`, deploys, deletions (`worktree delete`, `rm`, branches), writes outside the delegated worktree | one-line gate in the thread; the call suspends until the reply |
| **FORBIDDEN** | anything outside the `orca` / `gh` / `git` allow-list; Orca automations; repo creation/registration | hard deny, never asked |

- **Repo allow-list = the routing hints file**: no entry ⇒ not delegable, even if registered in Orca (treated as zero-match). Adding a repo = one edit to the hints file. Example set: `webapp`, `tooling`, `sandbox`, `orchestrator`.
- **Cost: measure-only in v1.** SQLite ledger (per-session `turn_count`, `cost_usd_total` from `ResultMessage`); threshold warnings in the thread at **$5 then $10** (env-configurable); nothing ever blocks; no time cap. Known limitation: delegated workers' own token usage is not measured.
- **User allow-list (env)**: `SLACK_ALLOWED_USER_IDS` (issue #93 — legacy `SLACK_ALLOWED_USER_ID` still accepted), filtered at the source. One shared trust boundary, no per-thread ownership: **any** allowed user may open, reply, answer 🚦 gates and worker gates, and close any registered thread — `root_user` stays recorded for attribution. Third-party @mention → one-line polite refusal, no session. Third-party reply inside an active thread → **silently ignored, never injected** (anti-injection: resumption needs no re-mention).
- **Crash recovery: reconcile + notify, resume on demand.** Workers are independent processes — never killed at boot. At boot: re-read `delegations` with `status=dispatched`, reconcile against `task-list` + `worktree ps`, post one ⚠️ status line per affected thread **without waking sessions**; the next human message resumes supervision. Question answers and Change reports stay in the ledger. Reconciliation also delivers Questions closed before posting and posts recovered Change reports. Pending-answer recovery restores root reactions using outcomes since the oldest pending answer: any failure in that recovery window wins, and success never signals all-clear while siblings remain in flight. A task marked completed without a Question answer stays watched until its report arrives.

## 8. Slack UX

Decision [#7](https://github.com/nvergez/orchestrator/issues/7); visual reference: [`docs/prototypes/slack-ux/`](prototypes/slack-ux/) (README = grammar, conversations.md = 7 validated scenarios, block-kit.md = rejected variant, kept for the record).

Guiding principle: **"edit the status, post the event."** Anything requiring the human (gate, escalation, done, stalled, cost threshold) = a **new message** (it notifies); anything ambient (progress, liveness) = in-place edit or reaction.

- **Pure mrkdwn** — Block Kit rejected for v1 (text is the mechanism per #6-relay; buttons would add a second reply path).
- **Root reactions** = coarse state readable from the channel: 👀 in progress · ❓ blocked on the human · 🚨 attention · ✅ delivered · ❌ failed (stale one removed).
- **One card per delegation**, posted at dispatch and edited at **milestones** only (worktree created, brief handed over, heartbeats, done) + a liveness line at most every 2 min — never a token stream. The conversational **voice** streams via post-then-edit (~1 edit/s, Tier-3 throttle).
- **Cards**: refer to delegations by worktree name everywhere, including ack refs, restart notices and closing summaries. A Question uses a light 🔎 “Looking on *repo*” card with no issue line, completed with its duration. A Change's links put PRs first; an issue appears only when cited.
- **Done**: a Question's answer posts verbatim; a Change's summary starts with its PR link, followed by what changed. The card keeps durable links and duration. No-change and proposed-split Change reports count as delivered without a PR.
- **Reference verbatims** (fixed by the mock): autonomy gate `🚦 <command> on <worktree> — go?`; worker gate = verbatim question + numbered options + "Reply in this thread"; queue `⏳ Queued (5 active sessions)…`; close 🔚 summary; cost `💸 This thread has cost $5.03…`; third party "Only authorized operators can drive me." (deliberately generic, issue #93 — the refusal never enumerates the allow-list to the people it keeps out; supersedes the mock's single-user line); reboot `⚠️ Restarted — <worktree-name> was in flight: <state>. Reply to resume supervision.`
- **No welcome message** — no per-thread pin, no channel pin/canvas.

## 9. Data model (SQLite)

One database: `~/.local/state/orchestrator/orchestrator.db` (override: `ORCHESTRATOR_DB_PATH`). Survives any git operation on the checkout; never in the repo.

- **`sessions`** — key `(thread_ts, channel_id)`: `session_id`, `root_user`, `status ∈ {open, closed}`, `created_at`, `last_activity_at`, `turn_count`, `cost_usd_total`. (#5)
- **Thread identity is the `(thread_ts, channel_id)` pair** (issue #93): a thread ts is only unique within its channel, so every thread-scoped table and query carries the channel. Gate/stall rows written before the multi-channel migration keep a NULL channel and match under any channel — the single-channel era needs no disambiguation.
- **`delegations`** — `task_id`, `dispatch_id`, worktree id/name/path, optional issue number, registry-resolved repo, thread/channel, status and timestamps. Two nullable columns migrate forward: `kind` (`question` or `change`) and `result_text` (answer or report). Older rows retain NULL kind and result; unknown kinds behave as Change. Written at dispatch, closed together with the result on `worker_done`; drives the worker cap and reconciliation.
- **`question_deliveries`** — dispatch id, successfully posted character offset, completion timestamp. Tracks ordered answer delivery across retries/restarts; no delivery row is required before closing a Question, so the close-to-post crash window is recoverable.
- **Dashboard** — read-only snapshot exposes worktree reference, kind, PR links extracted from the result, and optional issue link. Missing new columns in an older database produce unknown kind and no PRs; the reader never migrates or writes. Demo state includes a Question and Changes. WAL remains enabled.
- **`pending_gates`** — `msg_id`, `thread_ts`, `task_id`, `dispatch_id`, `worker_handle`, worktree name, question, options, relay Slack ts, `status ∈ {pending, answered, superseded, closed}` + `superseded_by`; written by the daemon at relay time; anchors answer routing — which only ever considers `pending` rows: a re-ask supersedes its stale gate, and a closing delegation closes its unanswered ones. (#9, #46)
- **`mailboxes`** — key `(thread_ts, channel_id)`: the thread's mailbox terminal `handle` (#9) and the nullable `run_id` of the Orca Run bound to it ([ADR 0006](adr/0006-orchestration-commands-originate-from-the-thread-mailbox.md)); a pre-Run row reads a NULL run and gets one bound on its next use.
- Pure runtime state (process handles, throttle buffers, warm flags) is **not** persisted — lost harmlessly on restart.

## 10. Deployment & operations

Decision [#6](https://github.com/nvergez/orchestrator/issues/6). Operator runbook for the packaged install (service management, updates, uninstall): [`docs/operations.md`](operations.md).

- **The daemon is this repo**: `package.json` at the root, code in `src/`; the `main` checkout at `<checkout>` **is** the deployed instance. Deploy = `git pull` + `npm ci` + `systemctl --user restart orchestrator`.
- **systemd user unit** `~/.config/systemd/user/orchestrator.service`: `ExecStart` = absolute node path (e.g. `~/.nvm/versions/node/<version>/bin/node` — user units don't source shell profiles); `Environment=PATH=…` including the `orca` CLI's bin dir + the node bin dir (SDK spawns the bundled `claude`); `WorkingDirectory=` the checkout; `Restart=always`, `RestartSec=5`; `WantedBy=default.target` + enable → reboot survival via linger. Cold restart is safe by design (#5 boot rule). Ops note: in Orca shells, `export XDG_RUNTIME_DIR=/run/user/$(id -u)` before `systemctl --user`/`journalctl --user`.
- **Auth**: `claude setup-token` → **`CLAUDE_CODE_OAUTH_TOKEN`** in the env file (subscription-billed; independent of the interactive login used by delegated workers). Never `--bare` (strips the OAuth token). `ANTHROPIC_API_KEY` = plan B only.
- **Secrets**: `EnvironmentFile=` pointing at the daemon's env file; code reads `process.env` only (no dotenv). Dev run: `node --env-file=.env`.
- **Orca dependency**: none at boot (user units can't order against system units anyway). Non-blocking startup healthcheck (`orca repo list --json`, logged); **every `orca` call wrapped** — on failure, a clear "Orca runtime unavailable" message in the thread, never a crash.
- **Logs**: structured JSON (pino) on stdout → persistent journald (rotation already configured). `LOG_LEVEL` env (default `info`). Read: `journalctl --user -u orchestrator -f`.

## 11. Configuration (`.env`)

| Key | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` bot token (#2) |
| `SLACK_APP_TOKEN` | `xapp-…` app-level token, `connections:write` (#2) |
| `SLACK_CHANNEL_IDS` | CSV of `C…` — the channels the daemon serves (#2, issue #93); legacy `SLACK_CHANNEL_ID` still accepted |
| `SLACK_ALLOWED_USER_IDS` | CSV of `U…` — the user allow-list (#2/#8, issue #93); legacy `SLACK_ALLOWED_USER_ID` still accepted |
| `CLAUDE_CODE_OAUTH_TOKEN` | daemon auth, from `claude setup-token` (#6) |
| `LOG_LEVEL` | pino level, default `info` (#6) |
| `ORCHESTRATOR_DB_PATH` | optional SQLite override (#6) |
| `ORCHESTRATOR_MAILBOX_WORKTREE` | optional absolute path of the Orca worktree hosting the thread mailbox terminals (ADR 0007); unset resolves to the cwd when it is a worktree, else the default repo's checkout |
| *(cap & threshold vars)* | live-session cap (default 5, #5); cost warning thresholds (default 5, 10 USD, #8); warmth TTL (default 30 min, #5) |

## 12. Known v1 limitations (accepted)

- A turn in flight at crash time is orphaned — no auto-resume; the session waits for the next human message (#5).
- Delegated workers' token usage isn't metered — the ledger sees only the orchestrator session (#8).
- No cost/time hard caps — warnings only, to be calibrated from ledger data in v2 (#8).
- `closed` is final — no thread reopening (#5).
- `channels:read` not granted — fine while the channel list is pinned by configuration; grant + reinstall if channel metadata is ever needed (#2/#6).

## 13. References

| Decision | Ticket |
|---|---|
| Slack surface & tokens | [#2](https://github.com/nvergez/orchestrator/issues/2) |
| Bridge technology | [#3](https://github.com/nvergez/orchestrator/issues/3) + [research](research/slack-claude-bridge.md) |
| Delegation & supervision | [#4](https://github.com/nvergez/orchestrator/issues/4) |
| Session lifecycle | [#5](https://github.com/nvergez/orchestrator/issues/5) |
| Deployment & secrets | [#6](https://github.com/nvergez/orchestrator/issues/6) |
| Slack UX | [#7](https://github.com/nvergez/orchestrator/issues/7) + [prototype](prototypes/slack-ux/) |
| Autonomy & security | [#8](https://github.com/nvergez/orchestrator/issues/8) |
| Gate relay | [#9](https://github.com/nvergez/orchestrator/issues/9) |
| Routing & agent selection | [#10](https://github.com/nvergez/orchestrator/issues/10) |
| The map | [#1](https://github.com/nvergez/orchestrator/issues/1) |

# Live e2e scenarios — driving the deployed bot

How to exercise the orchestrator end-to-end against the **deployed daemon** (no mocks): post to
`#orchestrator` (`C0ASJR3LAE6`) as the allowed user, watch `journalctl --user -u orchestrator -f`,
and verify worker side-effects on disk. First run: 2026-07-09 (findings became issues #45–#52,
all fixed and redeployed the same day).

## Ground rules

- Roots must @mention the bot; **replies do not** — plain thread replies resume the session, as
  designed. (Until #38 was fixed on 2026-07-09 they were silently dropped: the channel is private,
  so Slack emits `message.groups`, and only `message.channels` was subscribed.)
- `close` is the bare word as the whole reply, **mention optional**. Only a longer sentence
  containing "close" is an ordinary turn (spec §3).
- Messages sent through the claude.ai Slack MCP arrive with a `*Envoyé avec* @Claude` context
  footer; the daemon extracts command/turn text from `rich_text` blocks only (#41), so commands
  still match.
- Use `scratch` (folder repo, no remote) as the delegation target: side-effects land in
  `/home/dev/scratch`, nothing ships, and it exercises the degraded no-GitHub rendering.
- Ops note: `export XDG_RUNTIME_DIR=/run/user/1000` before `systemctl --user` / `journalctl --user`
  in Orca shells.

## Scenario suite

| # | Scenario (mock ref) | Drive | Expect |
|---|---|---|---|
| S1 | Session open + capability Q&A | Root: `@bot which repos can you delegate to, is Orca reachable?` | 👀 ack on root during the turn (#49); answer lists the routing-hints repos + runtime health; no gate |
| S2 | Zero-match routing ("Zero match") | Root: `@bot fix the pricing typo on the showcase site` | Verbatim stop+list: "No repo I drive matches. I know: …. Rephrase targeting one of them." — no fallback repo |
| S3 | Nominal delegation (mock A) | Root: `@bot in the sandbox, write <tiny one-shot script> and run it once` | Direct dispatch, no routing gate ("sandbox" is a listed alias, #52); zero 🚦 for reads (#45); ⚙️ card at dispatch, ✅ flip + "Delivered" summary on `worker_done`; artifact exists on disk |
| S4 | Worker gate relay (mock C) | Root: delegation whose brief forces the worker to `ask` with numbered options before writing | ❓ relay: worktree name, question **verbatim** in blockquote, numbered options, "Reply in this thread"; root 👀→❓; reply `N` routes to the **live** gate, forwards option N's verbatim text (#50); re-asks supersede (one live relay, no duplicates, #46) |
| S5 | Mid-flight status (mock E) | Reply `where is <task> at?` (no mention) while a delegation runs | Snapshot answer from task-list/worktree ps, **zero 🚦** (#45); card stays the living surface |
| S6 | Close + closed thread | Reply `close` (no mention), then reply again after | 🔚 summary with **per-delegation outcomes** (✅ repo#n, #51), cost, turns; second reply gets the fixed "Session closed." line |
| S9 | Mention-less resume (#38) | Reply in a registered thread with **no mention** | A turn starts (warm resume) and the bot answers; a *mentioned* reply still yields exactly **one** turn (the `message` copy is deduped, never a double turn) |
| S7 | 🚦 gate replies | Trigger any CONFIRM command (e.g. ask it to `worktree rm` something) | `go — <comment>` **approves** (#47); a denial gets a visible "taking that as a no" ack, never a silent identical re-gate; denied read still answers best-effort |
| S8 | Restart reconcile ("Daemon restart") | `systemctl --user restart orchestrator` with a delegation in flight | One ⚠️ line per affected thread, sessions not woken; next human message resumes supervision |

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
- Leftover worker workspaces in `scratch` accumulate until #43 (auto-clean on `worker_done`) lands.

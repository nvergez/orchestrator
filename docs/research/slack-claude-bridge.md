# Slack ↔ Claude Code bridge technology

> Resolution asset for ticket [#3 "Choose the Slack ↔ Claude Code bridge technology"](https://github.com/nvergez/orchestrator/issues/3) (map [#1](https://github.com/nvergez/orchestrator/issues/1)).
> Type `research` (AFK). First-hand sources: Anthropic docs (Agent SDK / Claude Code headless / sessions & auth) and Slack docs (Bolt / Socket Mode). Researched on 2026-07-07.

## Summary (TL;DR)

The bridge has two independent halves:

1. **The Slack half** is not really a choice: on a VPS with no inbound public URL, it's **Slack Bolt in Socket Mode** (outbound WebSocket, no reverse proxy/TLS). This holds regardless of the option chosen on the Claude side.
2. **The Claude half** is the real trade-off: **(a) Claude Agent SDK** (a long-lived process that opens/resumes one session per thread, in process) vs **(b) headless `claude` CLI** (`claude -p --output-format stream-json --resume <id>`, shelled out per message).

**Firm recommendation: option (a), Claude Agent SDK in TypeScript + Slack Bolt (JS) in Socket Mode**, a single long-lived Node daemon, one SDK session per Slack thread. Both options can resume a session, stream, and launch `orca` (via the session's Bash tool). The SDK wins on the points that matter for an **orchestrator-supervisor**: fine-grained programmatic control of the multi-session lifecycle (in process, no JSON re-parsing or per-message subprocess management), typed streaming, **streaming input** to inject Slack replies into a live session, and above all a **programmatic permission hook (`canUseTool`)** which is the natural mechanism for the autonomy guardrails of ticket [#8](https://github.com/nvergez/orchestrator/issues/8) (push/merge/deploy → confirmation in the thread). The headless CLI remains an excellent prototyping tool, but hand-rebuilding session tracking, stream-json parsing, and process management makes no sense when the SDK provides it natively.

## The setting: what the bridge must do (recap from the map)

The orchestrator = a Claude Code agent, **one session per Slack thread**, which interprets requests, **delegates** to Orca worktree agents (via the `orca` CLI), **supervises** them, and relays their **HITL gates** into the thread ([#9](https://github.com/nvergez/orchestrator/issues/9)). At a minimum, the bridge must therefore:

- open a session on the root message and **resume it** on every thread reply ([#5](https://github.com/nvergez/orchestrator/issues/5));
- **stream** the agent's output into the thread;
- **feed** Slack messages back in as new turns of the session;
- let the session **launch `orca …`** (subprocess);
- run as a robust **daemon** on the VPS ([#6](https://github.com/nvergez/orchestrator/issues/6)).

## Slack half — Bolt in Socket Mode (non-negotiable for a VPS)

**Socket Mode** delivers Slack events over an **outbound WebSocket** that the bot opens toward Slack, instead of Slack POSTing to a public Request URL. That is exactly the VPS/NAT case: nothing inbound to expose, no reverse proxy, no TLS, no firewall hole. Slack: *"Socket Mode allows your app to use the Events API and interactive features—without exposing a public HTTP Request URL"* and *"helps developers working behind a corporate firewall … that don't allow exposing a static HTTP endpoint"* ([using-socket-mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).

- **Tokens (both)**: app-level token `xapp-…` with the **`connections:write`** scope (opens the WebSocket) + bot token `xoxb-…` (Web API calls like `chat.postMessage`). Bolt JS startup: `new App({ token, socketMode: true, appToken })` ([Bolt JS Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)). Python equivalent: `AsyncSocketModeHandler(app, app_token).start_async()` ([Bolt Python](https://docs.slack.dev/tools/bolt-python/concepts/socket-mode/)). → aligned with ticket [#2](https://github.com/nvergez/orchestrator/issues/2).
- **Threads**: listen for `app_mention`/`message`, reply with `thread_ts` = `event.thread_ts || event.ts` (the `app_mention` payload carries no `thread_ts` on a root message — use its own `ts` to open the thread) ([app_mention](https://docs.slack.dev/reference/events/app_mention), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)).
- **Streaming to Slack = post-then-edit**: there is **no** token-by-token streaming API. Post with `chat.postMessage`, then edit in place with `chat.update`. `chat.update` is **Tier 3 (≈ 50/min)** and `chat.postMessage` ≈ **1 msg/s per channel** → **throttle the edits** (coalesce deltas, ~1 update / 1–2 s) ([chat.update](https://docs.slack.dev/reference/methods/chat.update), [rate-limits](https://docs.slack.dev/apis/web-api/rate-limits/)). This is a UX constraint ([#7](https://github.com/nvergez/orchestrator/issues/7)), not a runtime-choice one.
- **Daemon robustness**: up to **10 simultaneous WebSockets**, reconnection and `refresh_requested` handled by Bolt/the SDKs (*"We recommend using our Bolt framework … to handle the details of Socket Mode"*). Open a new connection before closing the old one for a lossless restart ([using-socket-mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).
- **Documented production caveats**: Slack recommends HTTP for the *highest* reliability and **explicitly sanctions Socket Mode for the firewall/NAT case** — ours ([comparing-http-socket-mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)). Socket Mode is **forbidden on the Marketplace** — irrelevant here (an **internal**, non-distributed app). Building it as an **internal (customer-built) app** also avoids the reduced `conversations.history`/`.replies` limits (1 req/min, 15 objects) imposed on non-Marketplace apps since **2025-05-29**; internal apps keep 50+/min ([changelog 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).

## Claude half — Agent SDK (a) vs headless CLI (b)

The SDK was **renamed** from `claude-code-sdk` to **`claude-agent-sdk`**: *"we're renaming the Claude Code SDK to the Claude Agent SDK"* ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). The SDK **wraps the CLI**: the npm package **bundles the `claude` binary** (optional dependency); the Python package requires the CLI to be installed separately ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript)). So both options use the **same engine** — the debate is about the interface (in-process library vs shelled-out process).

### Comparison table

| Criterion | (a) Agent SDK (TS/Python) | (b) headless `claude` CLI |
|---|---|---|
| **Install** | `npm i @anthropic-ai/claude-agent-sdk` (bundled binary) / `pip install claude-agent-sdk` (CLI required) | `claude` CLI already present |
| **Session resume** | `session_id` read from the `ResultMessage`/`SDKResultMessage`; passed back via `resume: <id>` (TS) / `resume=<id>` (Py), or `continue: true` for the latest; `ClaudeSDKClient` (Py) chains turns within the same session ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)) | `--resume <id>` / `--continue`; `session_id` extracted from the JSON (`--output-format json \| jq .session_id`) ([headless](https://code.claude.com/docs/en/headless)) |
| **Output streaming** | `includePartialMessages: true` → `stream_event` messages (`content_block_delta`/`text_delta`) + `AssistantMessage`/`ResultMessage`, **typed**, async-iterated in process ([streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)) | `--output-format stream-json --include-partial-messages` → **NDJSON to parse yourself** (jq/parse) ([headless](https://code.claude.com/docs/en/headless)) |
| **Streaming input** | Yes — streamed input (async iterable) to **inject turns into a live session** without respawning a process | One prompt per invocation (`-p`), or `--input-format stream-json` to wire up by hand |
| **Concurrent multi-session** | One long-lived Node/Py process manages N sessions (`query()` / N `ClaudeSDKClient`); **each session = its own `claude` subprocess** → central control + **fault isolation** | Doable, but tracking `session_id`s + one subprocess per message to orchestrate by hand |
| **Launching `orca` (subprocess)** | Yes — **Bash** tool within the session (`allowedTools`/`permissionMode`) | Yes — Bash tool (`--allowedTools "Bash"`) |
| **HITL / permission gate** | **`canUseTool` (in-process callback)** + `permissionMode` + hooks → per-tool-call decision relayable into the thread ([permissions](https://code.claude.com/docs/en/agent-sdk/permissions)) | Auto-approval (`--allowedTools`/`--permission-mode`) or routing through a **permission MCP tool** (`--permission-prompt-tool`) — more indirect |
| **Daemon robustness** | Thin supervisor (Bolt + session registry); the real work lives in child subprocesses → an agent crash doesn't take the daemon down | Per-process/per-message isolation, but session/state bookkeeping to reimplement |
| **VPS auth** | Same as CLI: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` (Pro/Max subscription, ~1 year), or a cloud provider ([authentication](https://code.claude.com/docs/en/authentication)) | Same |
| **Implementation effort** | Medium-low: lifecycle/stream/permission provided; you mostly write the Slack↔session glue | Low for a POC; **climbs fast** as soon as you want multi-session + resume + robust gates (you end up reimplementing the SDK) |

### Decisive points for *this* orchestrator

- **Long-lived multi-thread supervisor.** The SDK gives a clean model: parent = Bolt socket + `thread_ts → session` table ([#5](https://github.com/nvergez/orchestrator/issues/5)); children = one `claude` subprocess per active thread → **programmatic control + fault isolation**. With the CLI, you glue that together by hand (spawn per message, capture stdout, correlate sessions).
- **Injecting Slack replies.** The SDK's streaming input feeds a *live* session without respawning a process — more natural than re-invoking `claude -p … --resume` per message.
- **Autonomy guardrails ([#8](https://github.com/nvergez/orchestrator/issues/8)).** `canUseTool` is *the* mechanism to gate the orchestrator's **own** dangerous actions in-thread (push/merge/deploy/deletion): silently allow `orca worktree create`, ask for confirmation on the rest. In headless mode this means wiring up a permission MCP tool — considerably heavier.
- **Cost/token tracking ("Observability" fog).** The SDK's `ResultMessage` carries `total_cost_usd` + per-turn `usage` → cost/ceiling tracking ([#8](https://github.com/nvergez/orchestrator/issues/8)) and history ([#5](https://github.com/nvergez/orchestrator/issues/5)) become cleanly readable.

> Important note: the **HITL gates of the *delegated* agents** ([#9](https://github.com/nvergez/orchestrator/issues/9)) surface via **Orca** (waiting terminal / `orchestration gate-list`), not via Claude Code's permission prompt — that's a **message-level** exchange in the thread. `canUseTool` covers the orchestrator's *own* actions. The two HITL layers coexist.

### TypeScript or Python?

**TypeScript**, for a single-language stack with Bolt JS (the reference Bolt implementation) and a **`claude` binary bundled** by the SDK (simpler VPS deployment, no separate CLI install). **Python is a clean equivalent** (Bolt Python `AsyncApp` + `claude-agent-sdk`, but the CLI must be installed separately) — worth keeping in mind if the rest of the tooling leans Python. Non-blocking: to be confirmed in the deployment ticket ([#6](https://github.com/nvergez/orchestrator/issues/6)).

## Other approaches (rejected)

- **Slack via the HTTP Events API** instead of Socket Mode: viable but requires an inbound public URL (reverse proxy/TLS/tunnel) on the VPS. Socket Mode eliminates that ops burden. → rejected for v1.
- **Managed Agents (Anthropic-hosted agent)**: Anthropic runs the loop and hosts the tool container. But the orchestrator must run `orca` **on this VPS** to drive **local** Orca worktrees. A *self-hosted sandbox* would bring execution back to the VPS, but it's a **beta** surface and heavier (polling worker, SSE event stream) — overkill for v1. Worth keeping in mind for a v2. → rejected.
- **Home-grown agent loop on the raw Messages API** (defining file/bash tools, permissions, and sessions yourself): reinvents Claude Code. → rejected.

## Recommendation

**Build the bridge as (a): Claude Agent SDK (TypeScript) + Slack Bolt (JS) in Socket Mode**, a single long-lived Node daemon:

1. Bolt Socket Mode receives `app_mention`/`message`; the parent holds the `thread_ts → session_id` table ([#5](https://github.com/nvergez/orchestrator/issues/5)).
2. Root message → new SDK session; thread reply → resume via `resume` / streaming input.
3. Output streamed to Slack via **post-then-edit**, throttled to ~1 update/1–2 s ([#7](https://github.com/nvergez/orchestrator/issues/7)).
4. The session launches `orca …` via the Bash tool; delegated agents' gates surface via Orca ([#9](https://github.com/nvergez/orchestrator/issues/9)).
5. Orchestrator autonomy guardrails via `canUseTool` ([#8](https://github.com/nvergez/orchestrator/issues/8)).
6. VPS auth: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, subscription) **or** `ANTHROPIC_API_KEY` — to be pinned down at deployment ([#6](https://github.com/nvergez/orchestrator/issues/6)). ⚠️ Do not use `--bare` / `settingSources: []` if you depend on the OAuth token (bare mode strips it) — in any case the orchestrator wants its config (CLAUDE.md, skills), so no bare.

TypeScript is the recommended default; Python remains a clean alternative if the tooling requires it (language decision non-blocking, to be confirmed in [#6](https://github.com/nvergez/orchestrator/issues/6)).

## Sources (first-hand)

**Anthropic — Agent SDK / Claude Code**
- Agent SDK overview (rename) — https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK TypeScript (bundled binary, `query`) — https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK Python (`ClaudeSDKClient`) — https://code.claude.com/docs/en/agent-sdk/python
- Work with sessions (`session_id`, `resume`, `continue`) — https://code.claude.com/docs/en/agent-sdk/sessions
- Streaming output (`includePartialMessages`, `stream_event`) — https://code.claude.com/docs/en/agent-sdk/streaming-output
- Configure permissions (`canUseTool`, `permissionMode`, hooks) — https://code.claude.com/docs/en/agent-sdk/permissions
- Run Claude Code programmatically / headless (`-p`, `--output-format stream-json`, `--resume`) — https://code.claude.com/docs/en/headless
- Authentication (`ANTHROPIC_API_KEY`, `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, bare) — https://code.claude.com/docs/en/authentication

**Slack — Bolt / Socket Mode / Web API**
- Using Socket Mode — https://docs.slack.dev/apis/events-api/using-socket-mode
- HTTP vs Socket Mode (prod recommendation, firewall case) — https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/
- Bolt for JavaScript — Socket Mode — https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/
- Bolt for Python — Socket Mode — https://docs.slack.dev/tools/bolt-python/concepts/socket-mode/
- `chat.postMessage` (`thread_ts`) — https://docs.slack.dev/reference/methods/chat.postMessage
- `chat.update` (Tier 3, in-place editing) — https://docs.slack.dev/reference/methods/chat.update
- Web API rate limits — https://docs.slack.dev/apis/web-api/rate-limits/
- `app_mention` (payload, `app_mentions:read` scope) — https://docs.slack.dev/reference/events/app_mention
- Rate-limit change for non-Marketplace apps (2025-05-29) — https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/

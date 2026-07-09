# Slack app provisioning for a fresh install

> Resolution asset for ticket [#71 "Research: Slack app provisioning for a fresh install"](https://github.com/nvergez/orchestrator/issues/71) (map [#65](https://github.com/nvergez/orchestrator/issues/65)).
> Type `research` (AFK). First-hand sources: this repo's source (`src/config.ts`, `src/index.ts`, `src/app.ts`, `src/filter.ts`, `src/voice.ts`, `.env.example`, `docs/spec.md`) and official Slack docs (docs.slack.dev method/event/scope references, app-manifest reference, Socket Mode guide, token docs). Researched on 2026-07-09.

## Summary (TL;DR)

A stranger installing the orchestrator needs **their own Slack app** — one per workspace. Everything the app must *be* can be pre-baked in a shareable **app manifest** (YAML or JSON, pasted into Slack's "create an app from a manifest" flow at <https://api.slack.com/apps?new_app=1>): bot user, the **5 bot scopes** the code actually uses (`app_mentions:read`, `channels:history`, `groups:history`, `chat:write`, `reactions:write`), the **3 event subscriptions** (`app_mention`, `message.channels`, `message.groups`), and `socket_mode_enabled: true`. What the manifest **cannot** do — and what the walkthrough below covers — is mint tokens or place the bot: the operator must still (1) generate the **app-level token** (`xapp-…`, scope `connections:write`) by hand under *Basic Information → App-Level Tokens*, (2) **install the app to the workspace** to obtain the **bot token** (`xoxb-…`), (3) **invite the bot** into the single pinned channel, and (4) copy four IDs/tokens into the env: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_ALLOWED_USER_ID` (plus the non-Slack `CLAUDE_CODE_OAUTH_TOKEN`). The complete manifest is in [§4](#4-draft-app-manifest); the step-by-step spec in [§5](#5-provisioning-walkthrough-spec).

Two derivation results worth flagging:

- **`users:read` is not needed.** The live app was provisioned with 6 scopes including `users:read` (`docs/spec.md:45`), but no code path calls any `users.*` method — the minimal manifest omits it.
- **`files:read` is not needed.** `voice.ts` is *outbound-only* streaming (post-then-edit via `chat.postMessage`/`chat.update`, `src/voice.ts:8-13`); the daemon never downloads user-posted files (`url_private` appears nowhere in `src/`), so no file scopes are required.

## 1. Derived from the code

### 1.1 How the app connects

The daemon is a single Bolt (JS) `App` in **Socket Mode**: `new App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true, … })` (`src/index.ts:57-65`), exactly the construction the Bolt docs describe ("pass in `socketMode:true` and `appToken:YOUR_APP_TOKEN` when initializing `App`", [Bolt JS: Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)). Socket Mode means **no public Request URL** — events arrive over an outbound WebSocket ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).

### 1.2 Every Web API method the code calls → required bot scope

All Slack Web API calls live in `src/index.ts` and `src/app.ts`; every other module (`watcher.ts`, `dispatch.ts`, `relay.ts`, `gate.ts`, `sessions.ts`, `voice.ts`, …) receives injected `post`/`update`/`react`/`unreact` closures built there (`src/index.ts:80-115`), so the table below is exhaustive:

| Web API method | Where called | Required bot scope | Slack doc |
|---|---|---|---|
| `auth.test` | `src/index.ts:70` (boot: verify token, learn own `user_id` for the self-filter) | **none** — "No scopes required" | [auth.test](https://docs.slack.dev/reference/methods/auth.test) |
| `chat.postMessage` | `src/index.ts:81` (`postToThread`: voice messages, 🚦 gates, delegation cards, 💸/⚠️ notices); `src/app.ts:63` (third-party refusal line) | `chat:write` | [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage) |
| `chat.update` | `src/index.ts:107` (card edits), `src/index.ts:164` (voice post-then-edit streaming) | `chat:write` | [chat.update](https://docs.slack.dev/reference/methods/chat.update) |
| `reactions.add` | `src/index.ts:110` (👀 turn ack on thread roots) | `reactions:write` | [reactions.add](https://docs.slack.dev/reference/methods/reactions.add) |
| `reactions.remove` | `src/index.ts:113` (👀 off at turn end) | `reactions:write` | [reactions.remove](https://docs.slack.dev/reference/methods/reactions.remove) |

Notes:

- `chat:write` lets the bot post only where it is a **member**; `chat:write.public` (posting to public channels without membership) is *not* needed because the bot must be invited to the pinned channel anyway to receive its `message` events (see §1.3) — the [chat.postMessage doc](https://docs.slack.dev/reference/methods/chat.postMessage) says `chat:write.public` is only for "the ability to post in all public channels" without joining.
- No `conversations.*`, `users.*`, or `files.*` method is called anywhere in `src/` (verified by grep over every non-test module). `docs/spec.md:46` already records that `channels:read` is deliberately absent; the same holds for `users:read`, which the spec's live-app inventory lists (`docs/spec.md:45`) but nothing in the code exercises.
- `voice.ts` was specifically checked for audio/file downloads: its entire transport is `post(text)` + `update(ts, text)` (`src/voice.ts:8-13`) — outbound only. **No `files:read`.**

### 1.3 Every event subscription → required scope

`registerHandlers` subscribes to exactly two Bolt events: `app.event('app_mention', handle)` and `app.event('message', handle)` (`src/app.ts:127-128`). The `message` listener receives whichever **Events API** message subtype the app is subscribed to; the filter then narrows by channel, user, subtype, and mention (`src/filter.ts:84-154`):

| Events API subscription | Why the code needs it | Required scope | Slack doc |
|---|---|---|---|
| `app_mention` | Root `@bot` mention opens a session; in-thread mentions reply/close (`src/app.ts:127`, `src/filter.ts:130-153`) | `app_mentions:read` | [app_mention](https://docs.slack.dev/reference/events/app_mention) |
| `message.channels` | Mention-less thread replies when the pinned channel is **public** (`src/app.ts:33-37`, issue [#38](https://github.com/nvergez/orchestrator/issues/38)) | `channels:history` | [message.channels](https://docs.slack.dev/reference/events/message.channels) |
| `message.groups` | Mention-less thread replies when the pinned channel is **private** (`src/app.ts:33-37`, `docs/spec.md:45`) | `groups:history` | [message.groups](https://docs.slack.dev/reference/events/message.groups) |

- **The channel's privacy decides which `message.*` event fires** — Slack emits `message.groups` for private channels (`channel_type: "group"`) and `message.channels` for public ones. Subscribing to only the wrong one silently delivers *no* message events while `app_mention` keeps working (the #38 failure mode, `docs/spec.md:45`). The manifest below subscribes to **both** so a fresh install works with either channel type; the strictly minimal set is `app_mention` + the one matching your channel.
- The bot only receives events for conversations it is party to ("Subscribe your Slack apps to events related to channels and direct messages they are party to", [Events API](https://docs.slack.dev/apis/events-api/)); a mention in a channel the app is not a member of produces no event ([app_mention](https://docs.slack.dev/reference/events/app_mention)) — hence the mandatory invite step in §5.
- `message.im` / `message.mpim` are **not** needed: the filter drops anything outside the single pinned channel (`src/filter.ts:85-87`), and `SLACK_CHANNEL_ID` must start with `C` (`src/config.ts:158`) — a channel, never a DM.
- No `app.action` / `app.command` / `app.shortcut` / `app.view` handlers exist, so **interactivity, slash commands, and shortcuts are all unnecessary** in the app config.

### 1.4 Tokens and Slack-related env values (authority: `src/config.ts`)

| Env var | Prefix enforced | What it is | Source |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` | Bot User OAuth Token — all Web API calls | `src/config.ts:156` |
| `SLACK_APP_TOKEN` | `xapp-` | App-level token with `connections:write` — opens the Socket Mode WebSocket | `src/config.ts:157` |
| `SLACK_CHANNEL_ID` | `C` | The single pinned channel; everything else is ignored (`src/filter.ts:85`) | `src/config.ts:158` |
| `SLACK_ALLOWED_USER_ID` | `U` | Single-user allow-list — the only human the daemon obeys | `src/config.ts:159` |
| `CLAUDE_CODE_OAUTH_TOKEN` | `sk-ant-` | Not Slack: daemon auth from `claude setup-token` (spec §10) | `src/config.ts:160` |

Config is read from `process.env` only — no dotenv; systemd `EnvironmentFile` in prod, `node --env-file=.env` in dev (`src/config.ts:4-7`, `package.json` `dev` script). All five are hard-required: boot fails with a `ConfigError` naming every missing/misprefixed one (`src/config.ts:66-80,180-182`). The remaining env vars (`LOG_LEVEL`, `ORCHESTRATOR_DB_PATH`, `SESSION_*`, `WORKER_CAP`, `WATCH*`, `COST_WARN_THRESHOLDS_USD`) are optional tuning with defaults — see `.env.example` for the annotated template.

The `xapp-` token's one scope is confirmed by Slack: `connections:write` "Grants permission to generate websocket URIs and connect to Socket Mode" — an **app-level token** scope used to call `apps.connections.open` ([connections:write scope reference](https://docs.slack.dev/reference/scopes/connections.write)).

## 2. What an app manifest can pre-configure (verified against Slack's docs)

Manifests are "YAML or JSON-formatted configuration bundles for Slack apps" ([Configuring apps with manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)). The schema ([App manifest reference](https://docs.slack.dev/reference/app-manifest)) covers everything this app needs:

**CAN pre-configure:**

- `display_information` — `name` (≤ 35 chars, required), `description` (≤ 140), `long_description`, `background_color`.
- `features.bot_user` — `display_name` (≤ 80 chars, `a-z 0-9 - _ .`), `always_online`.
- `oauth_config.scopes.bot` — the bot scope list (≤ 255 entries).
- `settings.socket_mode_enabled` — boolean; with it on, `event_subscriptions` needs **no** `request_url` (events require "either Request URL or Socket Mode Enabled", [manifest guide](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)).
- `settings.event_subscriptions.bot_events` — the Events API subscriptions (≤ 100).
- Also available but unused here: `features.app_home`, `slash_commands`, `shortcuts`, `settings.interactivity`, `settings.org_deploy_enabled`, `settings.token_rotation_enabled`, `oauth_config.redirect_urls`.

**CANNOT pre-configure** (no manifest field exists for any of these — see §6 for the resulting manual steps):

- **Tokens of any kind.** The bot token only exists after workspace install; the app-level token is generated by hand ("Find your app-level token in the **Basic Information** tab of the app settings", [Token types](https://docs.slack.dev/authentication/tokens); "under Basic Information, scroll to the **App-level tokens** section and click the button to generate", [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).
- **Installing the app to a workspace** (the OAuth grant that mints `xoxb-…`).
- **Inviting the bot into a channel** — a workspace action, not app config.
- **The app icon/avatar** — `display_information` has no icon field; upload it in *Basic Information → Display Information* if wanted.

**Where the flow lives:** <https://api.slack.com/apps?new_app=1> → *Create New App* → **"From a manifest"** → pick the workspace → paste → review → *Create* ([manifest guide](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)). An existing app's manifest can be viewed/exported from its settings under **App Manifest**, which is how this draft stays verifiable against the live app.

**Caveats:**

- In workspaces with **admin app approval** enabled, installing a custom app may require an admin's approval first ([Slack Help: Manage app approval for your workspace](https://slack.com/help/articles/222386767)).
- Socket Mode apps are "not currently allowed in the public Slack Marketplace" ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)) — irrelevant here: each installer creates their own internal app, which also keeps the better non-Marketplace rate limits (`docs/research/slack-claude-bridge.md`, Slack-half caveats).
- Socket Mode allows up to 10 concurrent WebSocket connections ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)); the daemon uses one.

## 3. Scope set (minimal)

| Bot scope | Needed by |
|---|---|
| `app_mentions:read` | `app_mention` event subscription |
| `channels:history` | `message.channels` subscription (public pinned channel) |
| `groups:history` | `message.groups` subscription (private pinned channel) |
| `chat:write` | `chat.postMessage`, `chat.update` |
| `reactions:write` | `reactions.add`, `reactions.remove` |

App-level (not a bot scope): `connections:write` on the `xapp-` token.

Conditionality: if the operator commits to one channel type, one of `channels:history`/`groups:history` (and its event) can be dropped; keeping both costs nothing and survives the channel being converted or swapped. Nothing else is conditional — there is no optional file/voice-download feature in the code today (§1.2).

## 4. Draft app manifest

Ready to paste into **Create New App → From a manifest** (YAML tab). Rename freely — the code resolves the bot's identity via `auth.test` at boot (`src/index.ts:70-78`), so nothing depends on the literal name:

```yaml
display_information:
  name: orchestrator
  description: Slack-driven orchestrator — one Claude Code session per thread, delegating to Orca worktree agents.
  background_color: "#1a1d21"
features:
  bot_user:
    display_name: orchestrator
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - groups:history
      - chat:write
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

Field-by-field this maps to: bot user (§2), the 5 scopes (§3), the 3 event subscriptions (§1.3), and Socket Mode on (§1.1). No `interactivity`, `slash_commands`, or `request_url` — the code registers no such handlers (§1.3), and Socket Mode replaces the Request URL. `token_rotation_enabled: false` keeps the classic long-lived `xoxb-` token that `src/config.ts:156` expects.

## 5. Provisioning walkthrough spec

End state: a filled env file (dev: `.env` read by `npm run dev` via `node --env-file=.env`; prod: the systemd `EnvironmentFile` — `src/config.ts:4-7`). Template: `.env.example`.

1. **Create the app from the manifest.**
   Go to <https://api.slack.com/apps?new_app=1> → *From a manifest* → select the target workspace → paste the YAML from §4 → *Next* → review the summarized scopes/events → *Create* ([manifest guide](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)). If the workspace requires admin approval for custom apps, request it now (§2 caveats).

2. **Generate the app-level token → `SLACK_APP_TOKEN`.**
   In the app's settings: *Basic Information* → scroll to **App-Level Tokens** → *Generate Token and Scopes* → name it (e.g. `socket`), add the **`connections:write`** scope, *Generate* ([Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode); [connections:write](https://docs.slack.dev/reference/scopes/connections.write)). Copy the `xapp-…` value into `SLACK_APP_TOKEN`. (The manifest already turned Socket Mode on; verify under *Socket Mode* if paranoid.)

3. **Install to the workspace → `SLACK_BOT_TOKEN`.**
   *Install App* (or *OAuth & Permissions*) → **Install to Workspace** → authorize the requested scopes. The **Bot User OAuth Token** (`xoxb-…`) then appears under *OAuth & Permissions* — copy it into `SLACK_BOT_TOKEN` (`.env.example:7-8` records the same location). Reinstalling is only needed if scopes change later.

4. **Create/choose the single channel and invite the bot.**
   One dedicated channel, public or private — the daemon ignores every other conversation (`src/filter.ts:85-87`). In that channel run `/invite @orchestrator` (or *Add apps* from the channel's settings). Membership is what makes both posting (`chat:write`, §1.2) and event delivery (§1.3) work.

5. **Find the channel ID → `SLACK_CHANNEL_ID`.**
   In Slack, click the channel name to open its details; the **Channel ID** is shown at the bottom of the About tab (with a copy button). Alternatively right-click the channel → *Copy link* — the ID is the last path segment. It must start with `C` (`src/config.ts:158`); modern private channels also use `C…` IDs. (Legacy `G…`-prefixed private-group IDs would fail config validation — if you hit one, use the ID shown in channel details, which is the canonical one.)

6. **Find your user ID → `SLACK_ALLOWED_USER_ID`.**
   Click your profile picture → *Profile* → the **⋮** (three-dot) menu → **Copy member ID** — a `U…` value ([Slack Help: Locate your Slack URL or ID](https://slack.com/help/articles/221769328)). This is the single authorized user: root mentions by anyone else get one polite refusal, thread messages by anyone else are silently ignored (`src/filter.ts:116-138`).

7. **Set the remaining env value and boot.**
   `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (`sk-ant-…`, `src/config.ts:160`, spec §10) — not a Slack step but required for boot. Then `npm run dev` (or start the systemd unit). Boot self-verifies: a bad/missing var fails fast with a `ConfigError` naming it (`src/config.ts:180-182`); a bad bot token fails the boot `auth.test` (`src/index.ts:68-73`); success logs `connected to Slack over Socket Mode` with the bot user and channel IDs (`src/index.ts:237-240`). Smoke test: `@orchestrator` in a **root** message of the pinned channel — expect the 👀 reaction and a threaded reply; then a mention-less reply *in the thread* must also get a response (that proves the `message.*` subscription matches the channel type — the #38 failure mode otherwise).

## 6. What the manifest cannot pre-configure (residual manual steps)

Everything in this list is inherent to Slack's model, not a gap in the draft (§2):

1. **App-level token** (`xapp-…`) — generated by hand in *Basic Information → App-Level Tokens* (step 2). No manifest field, no API for a fresh app's first token.
2. **Workspace install / bot token** (`xoxb-…`) — the operator clicks *Install to Workspace* and, where enabled, an admin approves (step 3).
3. **Channel creation + bot invite** — workspace actions (step 4).
4. **The four env IDs/tokens** — tokens exist only post-install; `SLACK_CHANNEL_ID`/`SLACK_ALLOWED_USER_ID` are workspace-specific lookups (steps 5–6).
5. **App icon** — optional cosmetic upload in *Basic Information* (§2).

## 7. Discrepancies and open points

- **`users:read` (live app) vs code**: the live app's 6-scope inventory (`docs/spec.md:45`) includes `users:read`, which no code path requires (§1.2). The minimal manifest drops it. If a future feature resolves display names (e.g. `users.info`), it comes back — a scope change requiring a reinstall.
- **Slack's docs don't publish an explicit "message events require membership" sentence** on the `message.channels`/`message.groups` reference pages; the requirement is stated at the Events API level ("channels and direct messages they are party to", [Events API](https://docs.slack.dev/apis/events-api/)) and is confirmed operationally by the live app (bot invited, `docs/spec.md:44`). The invite step is mandatory regardless, since `chat:write` posting needs membership too.

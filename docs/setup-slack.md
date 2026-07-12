# Setting up the Slack app

The orchestrator needs **its own Slack app** in your workspace — one app per
install. Everything the app must *be* is pre-baked in the manifest below; what
Slack cannot pre-configure, you do by hand in five short steps: mint two
tokens, install the app, invite the bot into each managed channel, and copy four values
into your config.

You end up with the four Slack values of `~/.config/orchestrator/env`
(scaffolded by `orc init`):

| Env var | Prefix | What it is |
|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-` | Bot User OAuth Token — all Web API calls |
| `SLACK_APP_TOKEN` | `xapp-` | App-level token — opens the Socket Mode WebSocket |
| `SLACK_CHANNEL_IDS` | `C` | Comma-separated channel IDs the daemon listens to |
| `SLACK_ALLOWED_USER_IDS` | `U` | Comma-separated users authorized to operate any managed thread |

The app runs in **Socket Mode**: it connects outbound to Slack over a
WebSocket, so your machine needs no public URL, reverse proxy, or open port.

> **Admin approval:** in workspaces where custom-app installs require
> approval, request it from a workspace admin when you hit the install step.

## 1. Create the app from the manifest

Go to <https://api.slack.com/apps?new_app=1> → **Create New App** →
**From a manifest** → pick your workspace → paste the JSON below (JSON tab) →
review the summarized scopes and events → **Create**.

```json
{
    "display_information": {
        "name": "orchestrator",
        "description": "Slack-driven orchestrator — one Claude Code session per thread, delegating to Orca worktree agents.",
        "background_color": "#1a1d21"
    },
    "features": {
        "bot_user": {
            "display_name": "orchestrator",
            "always_online": true
        }
    },
    "oauth_config": {
        "scopes": {
            "bot": [
                "app_mentions:read",
                "channels:history",
                "groups:history",
                "chat:write",
                "reactions:write"
            ]
        }
    },
    "settings": {
        "event_subscriptions": {
            "bot_events": [
                "app_mention",
                "message.channels",
                "message.groups"
            ]
        },
        "org_deploy_enabled": false,
        "socket_mode_enabled": true,
        "token_rotation_enabled": false
    }
}
```

Rename the app freely — the daemon discovers its own identity at boot, so
nothing depends on the literal name. What the manifest configures:

- **5 bot scopes** — exactly what the code uses: read mentions
  (`app_mentions:read`), read thread replies in public or private channels
  (`channels:history`, `groups:history`), post and edit messages
  (`chat:write`), add/remove the status reactions (`reactions:write`).
- **3 event subscriptions** — `app_mention` plus both `message.channels`
  (public channels) and `message.groups` (private channels). The channel's
  privacy decides which `message.*` event Slack emits; subscribing to both
  means the install works with either channel type. Subscribing to only the
  wrong one *silently* delivers no thread replies while mentions keep working
  — the most confusing failure mode there is.
- **Socket Mode on, token rotation off** — the daemon expects the classic
  long-lived `xoxb-` token.

No interactivity, slash commands, or request URL — the bot is driven entirely
by messages.

## 2. Generate the app-level token → `SLACK_APP_TOKEN`

In the app's settings: **Basic Information** → scroll to **App-Level Tokens**
→ **Generate Token and Scopes** → name it (e.g. `socket`), add the
**`connections:write`** scope, **Generate**. Copy the `xapp-…` value.

This is the one thing a manifest can never contain: tokens are minted by
hand. (The manifest already turned Socket Mode on — verify under *Socket
Mode* in the sidebar if in doubt.)

## 3. Install to the workspace → `SLACK_BOT_TOKEN`

**Install App** (or **OAuth & Permissions**) → **Install to Workspace** →
authorize the requested scopes. The **Bot User OAuth Token** (`xoxb-…`) then
appears under *OAuth & Permissions* — copy it. You only ever need to
reinstall if the scopes change.

## 4. Choose the channels and invite the bot

The daemon listens to the configured channels — public or private, your
choice — and ignores every other conversation. In each channel, run
`/invite @orchestrator` (or *Add apps* from the channel settings).

Membership is not cosmetic: Slack only delivers events for conversations the
bot is party to, and `chat:write` only lets it post where it is a member. No
invite → no bot.

## 5. Collect the channel and operator IDs

- **Channel IDs → `SLACK_CHANNEL_IDS`.** For each channel, click the channel name to open its
  details; the **Channel ID** is at the bottom of the *About* tab (with a
  copy button). It must start with `C` — modern private channels also use
  `C…` IDs.
- **Authorized user IDs → `SLACK_ALLOWED_USER_IDS`.** For each operator, open
  their **Profile** → the **⋮** menu → **Copy member ID** — a `U…` value.
  Any listed operator may open, reply to, answer gates in, or close any managed
  thread. Root mentions by anyone else get one polite refusal; their thread
  replies are silently ignored.

## 6. Fill the env file and smoke-test

Put the four values into `~/.config/orchestrator/env` (alongside
`CLAUDE_CODE_OAUTH_TOKEN` — not a Slack step, but required for boot; see the
[README](../README.md#prerequisites)), then start the daemon.

Boot self-verifies: a missing or mis-prefixed variable fails fast naming the
culprit; a bad bot token fails the boot auth check; success logs
`connected to Slack over Socket Mode`.

Then, in the pinned channel:

1. Post a **root** message mentioning the bot: `@orchestrator hello`. Expect
   the 👀 reaction and a threaded reply.
2. Reply **in the thread without mentioning it**. A response proves the
   `message.*` subscription matches your channel's type — the last thing that
   can silently misfire.

/**
 * The `orc init` scaffold templates, embedded in the compiled code (issue
 * #70): no loose JSON or dotfiles in the tarball — `files: ['dist']` stands.
 * `routing-hints.example.json`, `persona.example.md` and
 * `persona-workers.example.md` at the repo root are browsing aids pinned to
 * their templates by tests; edit them together.
 */

export const ROUTING_HINTS_TEMPLATE = `{
  "$comment": "Routing hints (spec §4) — and the delegation allow-list (spec §7): a repo absent from this file is not delegable even if registered in Orca. \`name\` must match the Orca registry displayName; \`defaultAgent\` (claude|codex) is optional — omitted means the global default \`claude\`. Replace these fictional examples with your own repos.",
  "repos": [
    {
      "name": "webapp",
      "default": true,
      "description": "The product web app — features, endpoints and dashboards wired to real data.",
      "aliases": ["the app", "the product"],
      "keywords": ["feature", "endpoint", "dashboard", "export"]
    },
    {
      "name": "sandbox",
      "description": "Scratch space for one-shot scripts, experiments and benchmarks — nothing here ships.",
      "aliases": ["playground"],
      "keywords": ["one-shot", "script", "experiment", "prototype", "throwaway"]
    }
  ]
}
`;

/** The five required env vars plus the commented LOG_LEVEL tunable (#70). */
export const ENV_TEMPLATE = `# Orchestrator daemon environment — read by systemd via
# EnvironmentFile=%h/.config/orchestrator/env (and by dev runs via
# \`node --env-file\`). Holds live tokens: keep this file chmod 600 and
# never commit it anywhere.

# Bot User OAuth Token — starts with xoxb- (Slack: OAuth & Permissions, after install)
SLACK_BOT_TOKEN=

# App-Level Token — starts with xapp- (Slack: Socket Mode, connections:write scope)
SLACK_APP_TOKEN=

# The channel(s) the daemon serves — comma-separated IDs, each starts with C
# (the legacy single-value SLACK_CHANNEL_ID is still accepted)
SLACK_CHANNEL_IDS=

# Authorized Slack user ID(s) — comma-separated allow-list, each starts with U
# (the legacy single-value SLACK_ALLOWED_USER_ID is still accepted)
SLACK_ALLOWED_USER_IDS=

# Claude Code OAuth token — starts with sk-ant- (run \`claude setup-token\`)
CLAUDE_CODE_OAUTH_TOKEN=

# Optional: pino log level (default: info)
#LOG_LEVEL=info

# Optional: the Orca worktree the per-thread mailbox terminals are created
# in (an absolute path Orca lists). Unset, the daemon uses its working
# directory when that is an Orca worktree, else the default repo's checkout.
#ORCHESTRATOR_MAILBOX_WORKTREE=

# Optional: where the dashboard sidecar listens (defaults shown). Localhost
# is the security boundary — expose it beyond the machine your own way
# (Tailscale, SSH tunnel); the project ships no auth.
#DASHBOARD_PORT=8787
#DASHBOARD_BIND=127.0.0.1
`;

/**
 * The optional voice file (persona.md): scaffolded fully commented on
 * purpose — persona.ts strips HTML comments, so an operator who never
 * opens it keeps the stock voice instead of inheriting an example tone.
 */
export const PERSONA_TEMPLATE = `<!--
Persona (optional) — how the Slack-facing orchestrator should SOUND.

Whatever you write outside these comment markers is appended to the
session's system prompt, so keep it to the tone rules that matter: a few
lines beat a style essay, and every line rides in every turn of every
thread. HTML comments like this one are stripped, so an untouched file
means "no persona" — the stock voice.

It shapes the bot's own words only. The fixed protocol lines (the dispatch
ack, gate and stall acks, delegation cards) and anything relayed to a
worker are never restyled — a human's answer always goes down verbatim.

Restart the daemon after editing: the system prompt is fixed when a
session's process starts (systemctl --user restart orchestrator).

Example — delete the markers around it, or write your own:

Write like a senior engineer in a hurry: lower-case, no filler, no
"Great question!". French with the team, English for anything quoted from
code or GitHub. Say what you did, not what you are about to do.
-->
`;

/**
 * The worker register (persona-workers.md): same commented-scaffold trick,
 * a much tighter budget. It is copied into every brief and read by both
 * `claude` and `codex`, so the template asks for blunt lines, not prose.
 */
export const WORKER_PERSONA_TEMPLATE = `<!--
Worker register (optional) — how the WORKERS write what lands in Slack.

Why a second file: a Question's answer is the worker's own text, posted to
the thread verbatim by the daemon. persona.md never touches it — this file
is the only thing that does. It is copied into every brief, so it must stay
short (2 000 characters max) and blunt enough for claude and codex alike.

Tone only. Do not ask a worker to drop precision to sound casual: an answer
still needs its paths, its numbers and its "could not verify" notes.

Restart the daemon after editing (systemctl --user restart orchestrator).

Example — delete the markers around it, or write your own:

pas de formules d'assistant, pas de "Excellente question", pas de recap de
la demande. direct, minuscules, phrases courtes. dis ce que tu as trouve,
puis ce que tu n'as pas pu verifier. si un truc est casse, dis-le franchement.
-->
`;

/**
 * The `orc init` scaffold templates, embedded in the compiled code (issue
 * #70): no loose JSON or dotfiles in the tarball — `files: ['dist']` stands.
 * `routing-hints.example.json` at the repo root is a browsing aid pinned to
 * ROUTING_HINTS_TEMPLATE by a test; edit them together.
 */

export const ROUTING_HINTS_TEMPLATE = `{
  "$comment": "Routing hints (spec §4) — and the delegation allow-list (spec §7): a repo absent from this file is not delegable even if registered in Orca. \`name\` must match the Orca registry displayName; \`defaultAgent\` (claude|codex) is optional — omitted means the global default \`claude\`. Replace these fictional examples with your own repos.",
  "repos": [
    {
      "name": "webapp",
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

# Comma-separated IDs of channels the bot serves — each starts with C
SLACK_CHANNEL_IDS=

# Comma-separated authorized Slack user IDs — each starts with U
SLACK_ALLOWED_USER_IDS=

# Claude Code OAuth token — starts with sk-ant- (run \`claude setup-token\`)
CLAUDE_CODE_OAUTH_TOKEN=

# Optional: pino log level (default: info)
#LOG_LEVEL=info

# Optional: where the dashboard sidecar listens (defaults shown). Localhost
# is the security boundary — expose it beyond the machine your own way
# (Tailscale, SSH tunnel); the project ships no auth.
#DASHBOARD_PORT=8787
#DASHBOARD_BIND=127.0.0.1
`;

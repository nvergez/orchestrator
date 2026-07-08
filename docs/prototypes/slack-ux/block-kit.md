# Block Kit variant — not adopted by default

Per the decision on gate relaying (#9), **plain text is the mechanism**; Block Kit
would be a comfort layer. This page shows what that layer would look like on the
two most structured messages, so the call can be made with full knowledge.

Costs of the variant: heavier payloads to edit (post-then-edit over entire
`blocks`), rigid rendering (a block doesn't reflow like text), and if you add **buttons**
to the gates you need an interactivity path (`block_actions`) on top of the text path — two
reply mechanics to maintain for the same gesture. Pure mrkdwn keeps "reply in the
thread" as the single gesture.

## 1. The delegation card (in-progress state)

```json
{
  "channel": "C0ASJR3LAE6",
  "thread_ts": "1751970120.000200",
  "text": "⚙️ forwardly#84 — CSV export of send metrics (in progress)",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*⚙️ forwardly#84 — CSV export of send metrics*"
      }
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "`forwardly-84-csv-export` · claude · <https://github.com/lemlist/forwardly/issues/84|forwardly#84>"
        }
      ]
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "• 14:04 — issue created, worktree ready, brief handed off (task `t-3f81`)\n• 14:12 — worker: “endpoint `/metrics/export` in place, tests running”"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "last sign of life: 2 min ago" }
      ]
    }
  ]
}
```

## 2. The worker gate (verbatim question + options)

Version with buttons — each button carries the **full text** of its option (relayed
verbatim per #9); free text in the thread always remains accepted in parallel.

```json
{
  "channel": "C0ASJR3LAE6",
  "thread_ts": "1751970120.000200",
  "text": "❓ orca-53-lint-ci asks: which lint config is authoritative for CI?",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "❓ *`orca-53-lint-ci`* (<https://github.com/nvergez/orca/issues/53|orca#53>) asks:"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "> Two lint configs coexist (`.eslintrc.cjs` at the root, `eslint.config.mjs` in `app/`). Which one is authoritative for CI?"
      }
    },
    {
      "type": "actions",
      "block_id": "gate_t-9a41",
      "elements": [
        {
          "type": "button",
          "action_id": "gate_opt_1",
          "text": { "type": "plain_text", "text": "1 · .eslintrc.cjs (root)" },
          "value": ".eslintrc.cjs (root)"
        },
        {
          "type": "button",
          "action_id": "gate_opt_2",
          "text": { "type": "plain_text", "text": "2 · eslint.config.mjs (app/)" },
          "value": "eslint.config.mjs (app/)"
        },
        {
          "type": "button",
          "action_id": "gate_opt_3",
          "text": { "type": "plain_text", "text": "3 · Merge into flat config" },
          "value": "Merge both into flat config"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "or reply in this thread — a number or free text"
        }
      ]
    }
  ]
}
```

# Variante Block Kit — non retenue par défaut

Per la décision sur le relais des gates (#9), **le texte pur est le mécanisme** ; Block Kit
serait une couche de confort. Cette page montre à quoi ressemblerait cette couche sur les
deux messages les plus structurés, pour trancher en connaissance de cause.

Coûts de la variante : payloads plus lourds à éditer (post-then-edit sur des `blocks`
entiers), rendu figé (un bloc ne reflow pas comme du texte), et si on ajoute des **boutons**
aux gates il faut un chemin d'interactivité (`block_actions`) en plus du chemin texte — deux
mécaniques de réponse à maintenir pour le même geste. Le mrkdwn pur garde « réponds dans le
fil » comme unique geste.

## 1. La carte de délégation (état en cours)

```json
{
  "channel": "C0ASJR3LAE6",
  "thread_ts": "1751970120.000200",
  "text": "⚙️ forwardly#84 — export CSV des métriques d'envoi (en cours)",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*⚙️ forwardly#84 — export CSV des métriques d'envoi*"
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
        "text": "• 14:04 — issue créée, worktree prêt, brief transmis (task `t-3f81`)\n• 14:12 — worker : « endpoint `/metrics/export` posé, tests en cours »"
      }
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "dernier signe de vie : il y a 2 min" }
      ]
    }
  ]
}
```

## 2. Le gate worker (question verbatim + options)

Version avec boutons — chaque bouton porte le **texte intégral** de son option (transmis en
verbatim per #9) ; le texte libre dans le fil reste toujours accepté en parallèle.

```json
{
  "channel": "C0ASJR3LAE6",
  "thread_ts": "1751970120.000200",
  "text": "❓ orca-53-lint-ci demande : quelle config lint fait foi pour la CI ?",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "❓ *`orca-53-lint-ci`* (<https://github.com/nvergez/orca/issues/53|orca#53>) demande :"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "> Deux configs lint coexistent (`.eslintrc.cjs` à la racine, `eslint.config.mjs` dans `app/`). Laquelle fait foi pour la CI ?"
      }
    },
    {
      "type": "actions",
      "block_id": "gate_t-9a41",
      "elements": [
        {
          "type": "button",
          "action_id": "gate_opt_1",
          "text": { "type": "plain_text", "text": "1 · .eslintrc.cjs (racine)" },
          "value": ".eslintrc.cjs (racine)"
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
          "text": { "type": "plain_text", "text": "3 · Fusionner vers flat config" },
          "value": "Fusionner les deux vers flat config"
        }
      ]
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "ou réponds dans ce fil — numéro ou texte libre"
        }
      ]
    }
  ]
}
```

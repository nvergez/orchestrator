# PROTOTYPE — UX Slack de l'orchestrateur

> **Artefact jetable** du ticket [#7 — UX Slack de l'orchestrateur](https://github.com/nvergez/orchestrator/issues/7).
> Ce n'est pas du code : c'est un **mock de conversations Slack** à critiquer. Une fois l'UX
> validée, la décision est capturée dans le commentaire de résolution du ticket ; ce dossier
> reste comme référence visuelle pour l'implémentation.

## La question

À quoi **ressemble** et comment **se comporte** l'interface Slack — le « stylé » demandé ?
Le mock incarne les 8 décisions déjà prises sur la carte (#2–#6, #8–#10) ; il ne re-tranche
aucun mécanisme, seulement leur **rendu**.

## Principe directeur : « édite le statut, poste l'événement »

Physique Slack : **une édition de message ne notifie personne** ; un nouveau message dans un
thread suivi, si. D'où la règle qui structure tout le mock :

- Tout ce qui **exige l'humain** (gate, escalation, question, worker calé, done) = **nouveau
  message** dans le fil → notification.
- Tout ce qui est **de l'état ambiant** (progression, dernier signe de vie) = **édition en
  place** (post-then-edit, per #3) ou **réaction** → zéro bruit.

## Deux surfaces par thread

1. **La voix** — les messages conversationnels de la session (réponses, questions, accusés).
   Streamés en post-then-edit (~1 édition/s, throttlé Tier 3 per #3).
2. **La carte** — un message de statut **par délégation**, posté au dispatch puis **édité aux
   jalons** (événements orchestration + « dernier signe de vie »). Jamais de token-stream
   dedans : c'est un tableau de bord, pas un terminal.

## Les 4 tranches du ticket — choix faits dans ce mock

| Tranche | Choix prototypé |
|---|---|
| **Rendu du statut** | **Hybride** : réactions du bot sur le message racine = état grossier lisible depuis le channel (👀 en cours, ❓ bloqué sur toi, 🚨 alerte, ✅ livré, ❌ échec — le bot retire la périmée) ; carte éditée = détail par délégation. **mrkdwn pur en v1** — per #9 le texte est le mécanisme, Block Kit = couche de confort optionnelle (variante dans [block-kit.md](block-kit.md)). |
| **Granularité du streaming** | Deux régimes. Voix : post-then-edit au fil de la génération. Carte : édition **aux jalons** (worktree créé, brief transmis, status/heartbeat worker, done) + ligne « dernier signe de vie » rafraîchie au plus 1×/2 min. |
| **Liens** | GitHub (issue, PR, commit) = liens riches `<url\|repo#n>`. Worktree = pas d'URL : **chemin en code** `~/orca/workspaces/<repo>/<worktree>`. La **carte** porte les liens durables ; la voix peut les répéter dans la synthèse. |
| **Accueil épinglé** | **Aucun accueil** — ni épinglé par thread, ni épinglé/canvas channel. L'usage s'apprend par la pratique : le refus poli guide les tiers, les réactions et les cartes se comprennent d'elles-mêmes. *(Tranché en itération HITL — l'épinglé channel proposé a été rejeté.)* |

## Lexique emoji (stable, jamais décoratif)

| Emoji | Sens | Où |
|---|---|---|
| 👀 | session/délégation en cours | réaction racine |
| ❓ | gate/question en attente de TA réponse | réaction racine + message de gate |
| 🚦 | gate d'autonomie 1 ligne (push/merge/deploy/suppression) | message |
| 🚨 | escalation d'un worker | réaction racine + message |
| ⚠️ | worker calé (watchdog) / réconciliation au boot | message |
| ✅ | livré / transmis | réaction racine + carte + accusés |
| ❌ | échec | réaction racine + carte |
| ⏳ | mis en file (plafond de sessions) | message |
| 💸 | avertissement de coût (5 $/10 $) | message |
| 🔚 | résumé de clôture | message |
| ⚙️ | délégation en vol | carte |

## Décisions de la carte → où les voir dans le mock

| Décision | Incarnée dans |
|---|---|
| #3 post-then-edit + throttle | scénario A (voix streamée, carte éditée) |
| #4 délégation issue-liée, worktree `<repo>-<issue#>-<slug>` | cartes des scénarios A/C, liens |
| #5 mention racine, reprise sans re-mention, ⏳ file, close, thread clos | scénarios A, F ; moments brefs |
| #8 gates 1 ligne, seuils 5 $/10 $, refus poli d'un tiers, boot | scénarios B, D, G ; moments brefs |
| #9 gate = worker + question **verbatim** + options numérotées ; ✅ transmis | scénario C ; moments brefs (🚨, ⚠️) |
| #10 clarify-on-doubt ≡ confirmation (un seul aller-retour) ; gate conditionnel | scénarios A (clarify) et B (délégation directe) |

## Fichiers

- [`conversations.md`](conversations.md) — les 7 scénarios clés + les moments brefs.
- [`block-kit.md`](block-kit.md) — variante Block Kit (carte + gate), **non retenue par défaut**.

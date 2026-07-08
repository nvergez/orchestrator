# Techno du pont Slack ↔ Claude Code

> Asset de résolution du ticket [#3 « Choisir la techno du pont Slack ↔ Claude Code »](https://github.com/nvergez/orchestrator/issues/3) (carte [#1](https://github.com/nvergez/orchestrator/issues/1)).
> Type `research` (AFK). Sources de première main : docs Anthropic (Agent SDK / Claude Code headless / sessions & auth) et docs Slack (Bolt / Socket Mode). Recherché le 2026-07-07.

## Résumé (TL;DR)

Le pont a deux moitiés indépendantes :

1. **La moitié Slack** n'est pas vraiment un choix : sur un VPS sans URL publique entrante, c'est **Slack Bolt en Socket Mode** (WebSocket sortant, pas de reverse-proxy/TLS). C'est vrai quelle que soit l'option côté Claude.
2. **La moitié Claude** est le vrai arbitrage : **(a) Claude Agent SDK** (un process long-vécu qui ouvre/reprend une session par thread, en process) vs **(b) CLI `claude` headless** (`claude -p --output-format stream-json --resume <id>`, shellé par message).

**Reco tranchée : option (a), Claude Agent SDK en TypeScript + Slack Bolt (JS) en Socket Mode**, un seul daemon Node long-vécu, une session SDK par thread Slack. Les deux options savent reprendre une session, streamer et lancer `orca` (via l'outil Bash de la session). Le SDK gagne sur les points qui comptent pour un **orchestrateur-superviseur** : contrôle programmatique fin du cycle de vie multi-session (en process, pas de re-parsing JSON ni de gestion de sous-process par message), streaming typé, **entrée en streaming** pour injecter les réponses Slack dans une session vivante, et surtout un **hook de permission programmatique (`canUseTool`)** qui est le mécanisme naturel des garde-fous d'autonomie du ticket [#8](https://github.com/nvergez/orchestrator/issues/8) (push/merge/deploy → confirmation dans le thread). La CLI headless reste un excellent outil de prototypage, mais reconstruire à la main le suivi de session, le parsing stream-json et la gestion de process n'a pas de sens quand le SDK l'offre nativement.

## Le décor : ce que le pont doit faire (rappel de la carte)

L'orchestrateur = un agent Claude Code, **une session par thread Slack**, qui interprète les demandes, **délègue** à des agents-worktrees Orca (via la CLI `orca`), les **supervise** et relaie leurs **gates HITL** dans le thread ([#9](https://github.com/nvergez/orchestrator/issues/9)). Le pont doit donc, au minimum :

- ouvrir une session au message racine, **la reprendre** sur chaque réponse du thread ([#5](https://github.com/nvergez/orchestrator/issues/5)) ;
- **streamer** la sortie de l'agent vers le thread ;
- **réinjecter** les messages Slack comme nouveaux tours de la session ;
- laisser la session **lancer `orca …`** (sous-process) ;
- tourner en **daemon** robuste sur le VPS ([#6](https://github.com/nvergez/orchestrator/issues/6)).

## Moitié Slack — Bolt en Socket Mode (non négociable pour un VPS)

**Socket Mode** fait recevoir les événements Slack via un **WebSocket sortant** que le bot ouvre vers Slack, au lieu que Slack POST vers une Request URL publique. C'est exactement le cas VPS/NAT : aucune entrée à exposer, pas de reverse-proxy, pas de TLS, pas de trou firewall. Slack : *« Socket Mode allows your app to use the Events API and interactive features—without exposing a public HTTP Request URL »* et *« helps developers working behind a corporate firewall … that don't allow exposing a static HTTP endpoint »* ([using-socket-mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).

- **Tokens (les deux)** : app-level token `xapp-…` avec scope **`connections:write`** (ouvre le WebSocket) + bot token `xoxb-…` (appels Web API type `chat.postMessage`). Démarrage Bolt JS : `new App({ token, socketMode: true, appToken })` ([Bolt JS Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/)). Équivalent Python : `AsyncSocketModeHandler(app, app_token).start_async()` ([Bolt Python](https://docs.slack.dev/tools/bolt-python/concepts/socket-mode/)). → aligné avec le ticket [#2](https://github.com/nvergez/orchestrator/issues/2).
- **Threads** : écouter `app_mention`/`message`, répondre avec `thread_ts` = `event.thread_ts || event.ts` (le payload `app_mention` ne porte pas de `thread_ts` sur un message racine — on utilise son propre `ts` pour ouvrir le thread) ([app_mention](https://docs.slack.dev/reference/events/app_mention), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)).
- **Streaming vers Slack = post-then-edit** : il n'y a **pas** d'API de streaming token-par-token. On poste avec `chat.postMessage` puis on édite en place avec `chat.update`. `chat.update` est **Tier 3 (≈ 50/min)** et `chat.postMessage` ≈ **1 msg/s par channel** → **throttler les éditions** (coalescer les deltas, ~1 update / 1–2 s) ([chat.update](https://docs.slack.dev/reference/methods/chat.update), [rate-limits](https://docs.slack.dev/apis/web-api/rate-limits/)). C'est un contrainte de l'UX ([#7](https://github.com/nvergez/orchestrator/issues/7)), pas du choix de runtime.
- **Robustesse daemon** : jusqu'à **10 WebSockets** simultanés, reconnexion et `refresh_requested` gérés par Bolt/les SDK (*« We recommend using our Bolt framework … to handle the details of Socket Mode »*). Ouvrir une nouvelle connexion avant de fermer l'ancienne pour un redémarrage sans perte ([using-socket-mode](https://docs.slack.dev/apis/events-api/using-socket-mode)).
- **Caveats production documentés** : Slack recommande HTTP pour la *plus haute* fiabilité et **sanctionne explicitement Socket Mode pour le cas firewall/NAT** — le nôtre ([comparing-http-socket-mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/)). Socket Mode est **interdit au Marketplace** — sans objet ici (app **interne**, non distribuée). Le construire en **app interne (customer-built)** évite aussi la baisse de limites `conversations.history`/`.replies` (1 req/min, 15 objets) imposée aux apps non-Marketplace depuis le **2025-05-29** ; les apps internes gardent 50+/min ([changelog 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/)).

## Moitié Claude — Agent SDK (a) vs CLI headless (b)

Le SDK a été **renommé** de `claude-code-sdk` en **`claude-agent-sdk`** : *« we're renaming the Claude Code SDK to the Claude Agent SDK »* ([overview](https://code.claude.com/docs/en/agent-sdk/overview)). Le SDK **enveloppe la CLI** : le paquet npm **embarque le binaire `claude`** (dépendance optionnelle) ; le paquet Python exige la CLI installée séparément ([typescript ref](https://code.claude.com/docs/en/agent-sdk/typescript)). Donc les deux options utilisent le **même moteur** — le débat porte sur l'interface (bibliothèque en process vs process shellé).

### Tableau comparatif

| Critère | (a) Agent SDK (TS/Python) | (b) CLI `claude` headless |
|---|---|---|
| **Install** | `npm i @anthropic-ai/claude-agent-sdk` (binaire embarqué) / `pip install claude-agent-sdk` (CLI requise) | CLI `claude` déjà présente |
| **Reprise de session** | `session_id` lu sur le `ResultMessage`/`SDKResultMessage` ; repasse via `resume: <id>` (TS) / `resume=<id>` (Py), ou `continue: true` pour la dernière ; `ClaudeSDKClient` (Py) enchaîne les tours dans une même session ([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)) | `--resume <id>` / `--continue` ; `session_id` récupéré du JSON (`--output-format json \| jq .session_id`) ([headless](https://code.claude.com/docs/en/headless)) |
| **Streaming sortie** | `includePartialMessages: true` → messages `stream_event` (`content_block_delta`/`text_delta`) + `AssistantMessage`/`ResultMessage`, **typés**, async-itérés en process ([streaming](https://code.claude.com/docs/en/agent-sdk/streaming-output)) | `--output-format stream-json --include-partial-messages` → **NDJSON à parser soi-même** (jq/parse) ([headless](https://code.claude.com/docs/en/headless)) |
| **Entrée en streaming** | Oui — entrée en flux (async iterable) pour **injecter des tours dans une session vivante** sans relancer un process | Un prompt par invocation (`-p`), ou `--input-format stream-json` à câbler à la main |
| **Multi-session concurrente** | Un process Node/Py long-vécu gère N sessions (`query()` / N `ClaudeSDKClient`) ; **chaque session = son propre sous-process `claude`** → contrôle central + **isolation des fautes** | Faisable, mais suivi des `session_id` + un sous-process par message à orchestrer à la main |
| **Lancer `orca` (sous-process)** | Oui — outil **Bash** dans la session (`allowedTools`/`permissionMode`) | Oui — outil Bash (`--allowedTools "Bash"`) |
| **Gate HITL / permission** | **`canUseTool` (callback en process)** + `permissionMode` + hooks → décision par appel d'outil relayable dans le thread ([permissions](https://code.claude.com/docs/en/agent-sdk/permissions)) | Auto-approbation (`--allowedTools`/`--permission-mode`) ou routage via un **outil MCP de permission** (`--permission-prompt-tool`) — plus indirect |
| **Robustesse daemon** | Superviseur mince (Bolt + registre de sessions) ; le vrai travail est dans les sous-process enfants → un crash agent n'abat pas le daemon | Isolation par process/message, mais bookkeeping session/état à réimplémenter |
| **Auth VPS** | Identique CLI : `ANTHROPIC_API_KEY`, ou `CLAUDE_CODE_OAUTH_TOKEN` via `claude setup-token` (abonnement Pro/Max, ~1 an), ou provider cloud ([authentication](https://code.claude.com/docs/en/authentication)) | Identique |
| **Effort d'implémentation** | Moyen-bas : lifecycle/stream/permission fournis ; on écrit surtout la glue Slack↔session | Bas pour un POC ; **monte vite** dès qu'on veut multi-session + resume + gates robustes (on ré-implémente le SDK) |

### Points décisifs pour *cet* orchestrateur

- **Superviseur long-vécu multi-thread.** Le SDK donne un modèle propre : parent = socket Bolt + table `thread_ts → session` ([#5](https://github.com/nvergez/orchestrator/issues/5)) ; enfants = un sous-process `claude` par thread actif → **contrôle programmatique + isolation des fautes**. Avec la CLI, on recolle ça à la main (spawn par message, capture stdout, corrélation session).
- **Injecter les réponses Slack.** L'entrée en streaming du SDK alimente une session *vivante* sans relancer un process — plus naturel que réinvoquer `claude -p … --resume` par message.
- **Garde-fous d'autonomie ([#8](https://github.com/nvergez/orchestrator/issues/8)).** `canUseTool` est *le* mécanisme pour gater en thread les actions dangereuses **propres à l'orchestrateur** (push/merge/deploy/suppression) : autoriser silencieusement `orca worktree create`, demander confirmation sur le reste. En headless, cela suppose de câbler un outil MCP de permission — nettement plus lourd.
- **Suivi coût/tokens (fog « Observabilité »).** Le `ResultMessage` du SDK porte `total_cost_usd` + `usage` par tour → le suivi coût/plafonds ([#8](https://github.com/nvergez/orchestrator/issues/8)) et l'historique ([#5](https://github.com/nvergez/orchestrator/issues/5)) deviennent lisibles proprement.

> Note importante : les **gates HITL des agents *délégués*** ([#9](https://github.com/nvergez/orchestrator/issues/9)) remontent via **Orca** (terminal en attente / `orchestration gate-list`), pas via le prompt de permission de Claude Code — c'est un échange **au niveau message** dans le thread. `canUseTool` concerne les actions *propres* de l'orchestrateur. Les deux couches HITL coexistent.

### TypeScript ou Python ?

**TypeScript**, pour un stack mono-langage avec Bolt JS (l'implémentation Bolt de référence) et un **binaire `claude` embarqué** par le SDK (déploiement VPS plus simple, pas d'install CLI séparée). **Python est un équivalent propre** (Bolt Python `AsyncApp` + `claude-agent-sdk`, mais CLI à installer à part) — à retenir si le reste de l'outillage penche Python. Non bloquant : à confirmer au ticket déploiement ([#6](https://github.com/nvergez/orchestrator/issues/6)).

## Autres approches (écartées)

- **Slack via HTTP Events API** au lieu de Socket Mode : viable mais impose une URL publique entrante (reverse-proxy/TLS/tunnel) sur le VPS. Socket Mode élimine cette ops. → écarté pour v1.
- **Managed Agents (agent hébergé par Anthropic)** : Anthropic exécute la boucle et héberge le conteneur d'outils. Or l'orchestrateur doit lancer `orca` **sur ce VPS** pour piloter des worktrees Orca **locaux**. Un *self-hosted sandbox* ramènerait l'exécution sur le VPS, mais c'est une surface **beta**, plus lourde (worker de polling, flux d'événements SSE) — sur-dimensionné pour v1. À garder en tête pour une v2. → écarté.
- **Boucle d'agent maison sur l'API Messages brute** (définir soi-même outils fichiers/bash/permissions/sessions) : réinvente Claude Code. → écarté.

## Recommandation

**Construire le pont en (a) : Claude Agent SDK (TypeScript) + Slack Bolt (JS) en Socket Mode**, un daemon Node unique et long-vécu :

1. Bolt Socket Mode reçoit `app_mention`/`message` ; le parent tient la table `thread_ts → session_id` ([#5](https://github.com/nvergez/orchestrator/issues/5)).
2. Message racine → nouvelle session SDK ; réponse dans le thread → reprise via `resume` / entrée en streaming.
3. Sortie streamée vers Slack en **post-then-edit** throttlé ~1 update/1–2 s ([#7](https://github.com/nvergez/orchestrator/issues/7)).
4. La session lance `orca …` via l'outil Bash ; les gates des délégués remontent via Orca ([#9](https://github.com/nvergez/orchestrator/issues/9)).
5. Garde-fous d'autonomie de l'orchestrateur via `canUseTool` ([#8](https://github.com/nvergez/orchestrator/issues/8)).
6. Auth VPS : `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, abonnement) **ou** `ANTHROPIC_API_KEY` — à figer au déploiement ([#6](https://github.com/nvergez/orchestrator/issues/6)). ⚠️ Ne pas utiliser `--bare` / `settingSources: []` si l'on dépend du token OAuth (le mode bare le strippe) — de toute façon l'orchestrateur veut sa config (CLAUDE.md, skills), donc pas de bare.

TypeScript est le défaut recommandé ; Python reste une alternative propre si l'outillage l'exige (décision de langage non bloquante, à confirmer en [#6](https://github.com/nvergez/orchestrator/issues/6)).

## Sources (première main)

**Anthropic — Agent SDK / Claude Code**
- Agent SDK overview (renommage) — https://code.claude.com/docs/en/agent-sdk/overview
- Agent SDK TypeScript (binaire embarqué, `query`) — https://code.claude.com/docs/en/agent-sdk/typescript
- Agent SDK Python (`ClaudeSDKClient`) — https://code.claude.com/docs/en/agent-sdk/python
- Work with sessions (`session_id`, `resume`, `continue`) — https://code.claude.com/docs/en/agent-sdk/sessions
- Streaming output (`includePartialMessages`, `stream_event`) — https://code.claude.com/docs/en/agent-sdk/streaming-output
- Configure permissions (`canUseTool`, `permissionMode`, hooks) — https://code.claude.com/docs/en/agent-sdk/permissions
- Run Claude Code programmatically / headless (`-p`, `--output-format stream-json`, `--resume`) — https://code.claude.com/docs/en/headless
- Authentication (`ANTHROPIC_API_KEY`, `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN`, bare) — https://code.claude.com/docs/en/authentication

**Slack — Bolt / Socket Mode / Web API**
- Using Socket Mode — https://docs.slack.dev/apis/events-api/using-socket-mode
- HTTP vs Socket Mode (reco prod, cas firewall) — https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/
- Bolt for JavaScript — Socket Mode — https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/
- Bolt for Python — Socket Mode — https://docs.slack.dev/tools/bolt-python/concepts/socket-mode/
- `chat.postMessage` (`thread_ts`) — https://docs.slack.dev/reference/methods/chat.postMessage
- `chat.update` (Tier 3, édition en place) — https://docs.slack.dev/reference/methods/chat.update
- Web API rate limits — https://docs.slack.dev/apis/web-api/rate-limits/
- `app_mention` (payload, scope `app_mentions:read`) — https://docs.slack.dev/reference/events/app_mention
- Rate-limit change apps non-Marketplace (2025-05-29) — https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps/

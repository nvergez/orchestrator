# Mock des conversations Slack — `#orchestrator`

Convention de lecture : chaque bloc cité `>` est **un message Slack**. `**qui** — heure` en
tête. Les *(annotations en italique)* ne sont pas des messages : elles expliquent la mécanique.
Quand un message est **édité en place**, ses versions successives sont montrées avec
« ✏️ le même message, après édition ».

---

## A — Nominal complet : demande → clarify → délégation → progression → done

*(Message racine dans le channel. Session ouverte par @mention sur racine, per #5.)*

> **Nicolas** — 14:02
> @orchestrator ajoute un petit export CSV des métriques d'envoi
>
> réactions : 👀 *(posée par le bot : « je traite »)*

*(Toute la suite se passe dans le thread. Le routing tourne en silence : `orca repo list
--json` + hints → deux candidats crédibles → clarify-on-doubt, per #10. La réponse du bot
apparaît en post-then-edit — d'abord tronquée, puis complète en ~2 s :)*

> **orchestrator** `APP` — 14:02
> Deux repos peuvent correspondre :
> **1.** `forwardly` — le produit : l'export vivrait dans l'app, branché sur les vraies données
> **2.** `scratch` — bac à sable : script one-shot à côté du produit
> Je partirais avec l'agent **claude**. Réponds **1**, **2**, ou nomme un autre repo.
>
> réaction racine : 👀 → ❓

*(Per #10 : la désambiguïsation **est** la confirmation — un seul aller-retour. Répondre « 1 »
vaut go, y compris pour l'agent annoncé. Pas de second gate.)*

> **Nicolas** — 14:03
> 1

*(Délégation immédiate, per #4 : issue GitHub créée sur le repo cible, worktree
`<repo>-<issue#>-<slug>`, brief par `dispatch --inject`. Le bot poste **la carte** — un
message de statut qui sera édité aux jalons, jamais re-posté :)*

> **orchestrator** `APP` — 14:04
> ⚙️ **forwardly#84 — export CSV des métriques d'envoi**
> `forwardly-84-csv-export` · claude · issue [forwardly#84](https://github.com/lemlist/forwardly/issues/84)
> • 14:04 — issue créée, worktree prêt, brief transmis (task `t-3f81`)
>
> réaction racine : ❓ → 👀

*(✏️ le même message, après édition — 14:12, sur un `status` du worker. Les éditions ne
notifient pas : c'est voulu, c'est de l'ambiant.)*

> **orchestrator** `APP` — 14:04 *(édité)*
> ⚙️ **forwardly#84 — export CSV des métriques d'envoi**
> `forwardly-84-csv-export` · claude · issue [forwardly#84](https://github.com/lemlist/forwardly/issues/84)
> • 14:04 — issue créée, worktree prêt, brief transmis (task `t-3f81`)
> • 14:12 — worker : « endpoint `/metrics/export` posé, tests en cours »
> • dernier signe de vie : il y a 2 min

*(14:31 — `worker_done`. Le daemon réveille la session (per #9), qui fait deux choses :
elle **édite la carte** vers son état final ✅ — les liens durables vivent là — et poste une
**synthèse courte** en nouveau message, parce que « c'est fini » exige une notification.)*

> **orchestrator** `APP` — 14:04 *(édité)*
> ✅ **forwardly#84 — export CSV des métriques d'envoi — livré en 27 min**
> • PR : [forwardly#87 — Add CSV export of send metrics](https://github.com/lemlist/forwardly/pull/87) *(prête à relire)*
> • issue : [forwardly#84](https://github.com/lemlist/forwardly/issues/84) — commentaire de résolution posté
> • worktree : `~/orca/workspaces/forwardly/forwardly-84-csv-export`

> **orchestrator** `APP` — 14:31
> ✅ Livré — [forwardly#87](https://github.com/lemlist/forwardly/pull/87) prête à relire :
> endpoint `/metrics/export` + bouton dans le dashboard, tests verts. Détails dans la carte ⤴
>
> réaction racine : 👀 → ✅

---

## B — Gate d'autonomie (push)

*(Repo et action explicites dans la demande → délégation/action directe, sans gate de
confirmation de routing, per #10. Mais `git push` est en catégorie CONFIRM, per #8 :
`canUseTool` suspend la commande et pose un gate d'UNE ligne.)*

> **Nicolas** — 09:15
> @orchestrator la PR forwardly#87 a un conflit — rebase-la sur main et re-pousse
>
> réactions : 👀

> **orchestrator** `APP` — 09:16
> Rebase fait dans `forwardly-84-csv-export`, conflit résolu (lockfile), tests verts.
>
> réaction racine : 👀

> **orchestrator** `APP` — 09:18
> 🚦 `git push --force-with-lease` sur `forwardly/csv-export-metrics` — go ?
>
> réaction racine : 👀 → ❓

> **Nicolas** — 09:20
> go

> **orchestrator** `APP` — 09:20
> ✅ Poussé — CI relancée sur [forwardly#87](https://github.com/lemlist/forwardly/pull/87).
>
> réaction racine : ❓ → ✅

*(Le gate 🚦 est un message de thread ordinaire dont on attend la réponse — pas un bouton,
pas un `decision_gate` de DAG. Même moule pour merge, deploy, suppression :
« 🚦 `gh pr merge forwardly#87` (squash) — go ? », « 🚦 `orca worktree delete
forwardly-84-csv-export` — go ? ».)*

---

## C — Gate worker remontée : question verbatim + options → réponse

*(Une délégation `orca#53` est en vol depuis 20 min ; la session s'est assoupie (TTL 30 min
per #5). Le worker pose un `ask`. Le daemon — qui écoute, per #9 — réveille la session, qui
poste un **nouveau message** de gate. Contrat de contenu per #9 : qui demande, la question
**en verbatim, jamais paraphrasée**, les options numérotées, la consigne.)*

> **orchestrator** `APP` — 16:40
> ❓ **`orca-53-lint-ci`** ([orca#53](https://github.com/nvergez/orca/issues/53)) demande :
>
> > Deux configs lint coexistent (`.eslintrc.cjs` à la racine, `eslint.config.mjs` dans
> > `app/`). Laquelle fait foi pour la CI ?
> > **1.** `.eslintrc.cjs` (racine)
> > **2.** `eslint.config.mjs` (app/)
> > **3.** Fusionner les deux vers flat config
>
> Réponds dans ce fil — numéro ou texte libre.
>
> réaction racine : 👀 → ❓

> **Nicolas** — 16:52
> 3

*(Une seule gate pending dans ce fil → la réponse route vers elle sans cérémonie, per #9.
« 3 » est transmis comme le **texte intégral de l'option 3, en verbatim** — le LLM ne
reformule jamais une décision humaine. Redescente par `orchestration reply --id`.)*

> **orchestrator** `APP` — 16:52
> ✅ Transmis à `orca#53` — « Fusionner les deux vers flat config »
>
> réaction racine : ❓ → 👀

*(La carte de la délégation, plus haut dans le fil, est éditée : la ligne « ❓ en attente
de ta réponse » redevient « ⚙️ en cours ».)*

---

## D — Avertissement de coût

*(Ledger SQLite par session, per #5/#8 : seuils configurables, défauts 5 $ puis 10 $.
Mesure seule — jamais de blocage. Nouveau message : un franchissement de seuil mérite une
notification, pas une édition.)*

> **orchestrator** `APP` — 17:20
> 💸 Ce fil a coûté **5,03 $** (seuil 5 $ franchi) — info seulement, rien n'est bloqué.
> Prochain avertissement à 10 $.

*(Compte la session orchestrateur uniquement : les tokens des workers délégués ne remontent
pas dans le ledger v1 — limite actée en #8.)*

---

## E — « Où en est X ? »

*(Statut à la demande = la troisième voie de la tranche « progression » : la carte est le
tableau de bord ambiant, mais on peut toujours interroger. Réponse = **nouveau message**
snapshot ; la carte reste la surface vivante.)*

> **Nicolas** — 15:05
> où en est l'export CSV ?

> **orchestrator** `APP` — 15:05
> ⚙️ Toujours en cours — `forwardly-84-csv-export` (claude) travaille depuis 22 min.
> Dernier statut (il y a 3 min) : « endpoint fait, je branche le bouton dashboard ».
> Aucune question en attente. Détail : carte ⤴

*(Sources : `task-list`, `worktree ps`, derniers `status`/heartbeats — pas de devinette.
Si la session dormait, ce message l'a réveillée comme n'importe quel message humain.)*

---

## F — Session assoupie, réveillée sans cérémonie

*(Dernier échange à 14:31. TTL de chaleur 30 min → la session s'est assoupie à ~15:00 :
process réapé, `session_id` persisté, per #5. AUCUN message d'assoupissement — c'est un
état technique, pas un événement. À 17:48, reprise en thread **sans re-mention** :)*

> **Nicolas** — 17:48
> au fait, ajoute aussi l'export en JSON

> **orchestrator** `APP` — 17:48
> Bonne suite de [forwardly#84](https://github.com/lemlist/forwardly/issues/84) — je crée
> une issue liée et je délègue sur **forwardly** avec **claude**. Go ?

*(Le réveil à froid via `resume` coûte quelques secondes de latence — c'est TOUT ce que
l'humain perçoit. Le gate de confirmation réapparaît ici parce que repo/agent sont inférés
du contexte, per #10.)*

### F′ — Plafond atteint : la file

*(5 sessions live, toutes en plein tour, per #5 : jamais de rejet sec, jamais de travail
perdu — le message est mis en file et on l'annonce :)*

> **orchestrator** `APP` — 11:02
> ⏳ En file (5 sessions actives) — je m'y mets dès qu'un slot se libère.

---

## G — Un tiers écrit

*(Allow-list utilisateur en env, v1 = un seul user, per #8.)*

**G1 — @mention racine par un tiers → refus poli, aucune session créée :**

> **Charline** — 10:12
> @orchestrator déploie forwardly en prod

> **orchestrator** `APP` — 10:12
> v1 : seul <@U09CC6M3W1W> peut me piloter.

*(Découvrable : un collègue qui teste ne croit pas le bot cassé. Pas de réaction 👀, pas de
session.)*

**G2 — réponse d'un tiers dans un thread actif → ignorée en silence :**

> **Charline** — 10:31 *(dans le thread de l'export CSV)*
> ou plutôt fais-le en Go

*(Rien. Le message n'est jamais injecté dans la session — garde-fou anti-injection per #8 :
la reprise en thread se fait sans re-mention, donc sans ce filtre n'importe qui pourrait
piloter une session en cours. Silence assumé, pas de « je t'ignore » qui pollue le fil.)*

---

## Moments brefs

### Clôture explicite — `@orchestrator close`

> **Nicolas** — 18:30
> @orchestrator close

> **orchestrator** `APP` — 18:30
> 🔚 Session close.
> • 2 délégations : ✅ `forwardly#84` (PR [#87](https://github.com/lemlist/forwardly/pull/87) mergée) · ✅ `forwardly#91` (export JSON, PR [#93](https://github.com/lemlist/forwardly/pull/93) à relire)
> • coût du fil : 6,84 $ · 19 tours
> Mentionne-moi sur un nouveau message racine pour repartir.

### Réponse dans un thread clos

> **Nicolas** — *(3 jours plus tard, dans le même fil)*
> et une version XML ?

> **orchestrator** `APP`
> Session close. Mentionne-moi sur un nouveau message racine pour repartir.

*(Verbatim de #5 : `closed` est définitif et prévisible — pas de réouverture v1.)*

### Redémarrage du daemon — réconciliation

*(Per #8 : au boot, relire les délégations en vol, réconcilier avec `task-list`/`worktree
ps`, poster UNE ligne par thread concerné — sans réveiller la session.)*

> **orchestrator** `APP` — 08:04
> ⚠️ Redémarré — `forwardly#84` était en vol : toujours en cours (dernier signe il y a
> 4 min). Réponds pour reprendre la supervision.

### Zéro match — stop + liste

> **Nicolas** — 11:40
> @orchestrator corrige le bug du site vitrine

> **orchestrator** `APP` — 11:40
> Aucun repo que je pilote ne correspond. Je connais : `forwardly`, `orca`, `scratch`,
> `orchestrator`. Reformule en visant l'un d'eux.

*(Per #10 : jamais de fallback silencieux, pas de `scratch` attrape-tout.)*

### Escalation d'un worker

> **orchestrator** `APP` — 15:47
> 🚨 **`forwardly-84-csv-export`** ([forwardly#84](https://github.com/lemlist/forwardly/issues/84)) escalade :
>
> > Les tests e2e cassent sur `main` même sans mes changements — je suspends en attendant.
>
> Réponds dans ce fil.
>
> réaction racine : 👀 → 🚨

*(Même contrat que le gate ❓ — verbatim, mais marqué urgent et généralement sans options,
per #9.)*

### Worker calé (watchdog)

> **orchestrator** `APP` — 16:20
> ⚠️ **`scratch-21-bench`** ([scratch#21](https://github.com/nvergez/scratch/issues/21)) semble calé —
> aucun signe depuis 25 min, sans avoir posé de question. Dernier output :
>
> > `? Overwrite existing bench.json? (y/N)`
>
> Dis-moi quoi répondre, je le transmets à son terminal.
>
> réaction racine : 👀 → 🚨

*(Redescente par `terminal send` — pas de `reply` possible, il n'y a pas d'`ask`, per #9.)*

### Accueil

*(Aucun — ni épinglé par thread, ni épinglé/canvas au niveau du channel. Tranché en
itération HITL : l'usage s'apprend par la pratique — le refus poli guide les tiers, les
réactions et les cartes se comprennent d'elles-mêmes.)*

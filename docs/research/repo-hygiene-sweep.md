# Repo hygiene sweep — personal & instance-specific inventory

> Resolution asset for ticket [#72 "Research: repo-hygiene sweep for public consumption"](https://github.com/nvergez/orchestrator/issues/72) (map [#65](https://github.com/nvergez/orchestrator/issues/65) — ship the orchestrator as a public npm CLI package).
> Type `research` (plan-only — nothing is fixed here). Swept the full tree (dotfiles included, `.git`/`node_modules` excluded) on 2026-07-09 for: `nvergez`, `lemlist`, `nicolas`, `/home/dev`, Slack `T…/U…/C…` IDs, email addresses, IP addresses, token-like strings, VPS/hostname references.

**Verdicts.** Each item gets one of:

- **move to instance config** — belongs in the operator's runtime config (XDG config dir / env / `~/.config`), not in the shipped package;
- **genericize** — stays in the repo, but personal specifics become placeholders or obviously-fake examples;
- **keep** — fine as-is in a public MIT npm package.

---

## 1. `routing-hints.json` — the operator's private repo allow-list, committed at the repo root

What it is: the routing/delegation allow-list (spec §4/§7), committed at the repo root and **loaded from the package root at boot** — `src/index.ts:42`: `loadRoutingHints(join(import.meta.dirname, '..', 'routing-hints.json'))`. Whoever `npm install`s the package gets the owner's personal repo list baked in.

Personal content:

- `routing-hints.json:5-6` — `"name": "forwardly"`, `"description": "The product web app — email campaigns and send metrics; real features wired to real data."` — a private employer (lemlist) product repo, name and purpose disclosed.
- `routing-hints.json:12` — `"description": "The Orca runtime and CLI — … that runs the delegated workers on this VPS."` — "this VPS" ties the file to one machine.
- `routing-hints.json:17` — `"name": "scratch"` — the operator's personal sandbox repo.
- `routing-hints.json:25` — `"aliases": ["the bot", "nikolai", "dispatcher", "the orchestrator"]` — "nikolai" is the operator's personal bot name.

**Verdict: move to instance config.**
Rationale: the package ships this file and reads it from its own install dir, so it cannot contain the operator's private repo names — the file must live in the operator's runtime config (e.g. `~/.config/orchestrator/routing-hints.json` or an env-pointed path), with a generic `routing-hints.example.json` in the repo.

- [ ] Move `routing-hints.json` out of the repo into instance config; change the loader path in `src/index.ts:42` accordingly.
- [ ] Ship a placeholder `routing-hints.example.json` (fake repo names) in its place.

## 2. `docs/spec.md` — VPS paths, lemlist workspace, real Slack IDs, personal bot/channel names

Personal content (the spec is otherwise a genuinely useful design document):

- `docs/spec.md:43` — "Provisioned … on the **lemlist** workspace" — names the employer's Slack workspace.
- `docs/spec.md:44` — "App `@nikolai` (`U0BGRT64CPJ`) … the single channel is `C0ASJR3LAE6` — a **private** channel, today named **#radical-squad** … authorized user `U09CC6M3W1W`" — real bot user ID, channel ID, channel name, and the operator's personal Slack user ID in one line.
- `docs/spec.md:48` — "Secrets in `/home/dev/projects/orchestrator/.env`".
- `docs/spec.md:118` — "Initially: `forwardly`, `orca`, `scratch`, `orchestrator`" — the private repo list again.
- `docs/spec.md:120` — "v1 = `U09CC6M3W1W` only".
- `docs/spec.md:133` — reference verbatim "v1: only <@U09CC6M3W1W> can drive me.".
- `docs/spec.md:150` — "the `main` checkout at `/home/dev/projects/orchestrator` **is** the deployed instance".
- `docs/spec.md:151` — "modeled on `observer.service`" (another personal unit on the same VPS); "`/home/dev/.nvm/versions/node/v22.23.1/bin/node`"; "`/home/dev/.local/bin`"; "`export XDG_RUNTIME_DIR=/run/user/1000`".
- `docs/spec.md:153` — "`EnvironmentFile=/home/dev/projects/orchestrator/.env`".
- `docs/spec.md:163-164` — env table pins the real values: "`C0ASJR3LAE6` — the single channel", "`U09CC6M3W1W` — single-user allow-list".
- Also ambient: `docs/spec.md:6` and `:39` say "this VPS".

**Verdict: genericize.**
Rationale: the spec ships as the package's primary design doc, so real workspace/user/channel identifiers and one machine's filesystem become placeholders (`C0EXAMPLE…`, `<checkout>`, `$HOME`) while the design content stays.

- [ ] Replace real Slack IDs (`U0BGRT64CPJ`, `C0ASJR3LAE6`, `U09CC6M3W1W`), the workspace name (lemlist), the channel name (#radical-squad) and the bot name (@nikolai) with placeholders.
- [ ] Replace `/home/dev/...`, the nvm-versioned node path, `observer.service`, and `/run/user/1000` with generic equivalents.
- [ ] Replace the `forwardly`/`scratch` repo-list examples with neutral names.

## 3. `docs/deploy.md` — one specific VPS's install runbook

Personal content:

- `docs/deploy.md:3` — "The `main` checkout at `/home/dev/projects/orchestrator` **is** the deployed instance".
- `docs/deploy.md:11` — "`export XDG_RUNTIME_DIR=/run/user/1000`" (UID 1000 of one machine).
- `docs/deploy.md:16` and `:36` — "`cd /home/dev/projects/orchestrator`".
- `docs/deploy.md:29-31` — "already active on this VPS … `loginctl show-user dev` … `sudo loginctl enable-linger dev`" — the VPS username `dev`.

**Verdict: genericize.**
Rationale: the npm package needs an install doc a stranger can follow, so paths and the `dev` username become `$HOME`/`<user>` placeholders (a fuller npm-oriented rewrite is a separate map ticket; hygiene only needs the personal specifics gone).

- [ ] Replace `/home/dev/projects/orchestrator` with a placeholder checkout path.
- [ ] Replace username `dev` and `/run/user/1000` with `<user>` / `$UID` phrasing.

## 4. `docs/e2e-scenarios.md` — real channel ID and VPS paths in the test runbook

Personal content:

- `docs/e2e-scenarios.md:4` — "post to `#orchestrator` (`C0ASJR3LAE6`) as the allowed user".
- `docs/e2e-scenarios.md:19` — "side-effects land in `/home/dev/scratch`".
- `docs/e2e-scenarios.md:20` — "`export XDG_RUNTIME_DIR=/run/user/1000`".

**Verdict: genericize.**
Rationale: the runbook is worth shipping as a how-to-verify-your-install guide, but it must reference *your* channel/sandbox, not the operator's real channel ID and home directory.

- [ ] Swap `C0ASJR3LAE6`, `/home/dev/scratch`, and `/run/user/1000` for placeholders.

## 5. `docs/prototypes/slack-ux/` — mock conversations linking the employer's private repo

Personal content (the mocks are labelled throwaway, `README.md:3`, but they ship in the repo):

- `docs/prototypes/slack-ux/conversations.md:43` — "issue [forwardly#84](https://github.com/lemlist/forwardly/issues/84)" — and ~15 more `github.com/lemlist/forwardly` issue/PR links through the file (e.g. `:64-65`, `:69`, `:101`, `:245`, `:282`).
- `docs/prototypes/slack-ux/conversations.md:120` and `:296` — `https://github.com/nvergez/orca/issues/53`, `https://github.com/nvergez/scratch/issues/21` — the operator's other personal repos.
- `docs/prototypes/slack-ux/conversations.md:220` — "v1: only <@U09CC6M3W1W> can drive me." — real user ID.
- `docs/prototypes/slack-ux/block-kit.md:17` and `:61` — `"channel": "C0ASJR3LAE6"` — real channel ID; `:33` and `:69` repeat the lemlist/nvergez repo links.

**Verdict: genericize.**
Rationale: the UX mock is the reference for the shipped message grammar, so it stays — but a public package's example conversations cannot deep-link a private employer repo (`lemlist/forwardly`) or carry real Slack IDs; swap to a fictional org/repo and fake IDs.

- [ ] Replace `github.com/lemlist/forwardly` and `github.com/nvergez/{orca,scratch}` links with a fictional org/repo.
- [ ] Replace `C0ASJR3LAE6` / `U09CC6M3W1W` with obviously-fake IDs.

## 6. `deploy/orchestrator.service` — systemd unit hardcoding one user's filesystem

Personal content:

- `deploy/orchestrator.service:15` — `WorkingDirectory=/home/dev/projects/orchestrator`.
- `deploy/orchestrator.service:17` — `EnvironmentFile=/home/dev/projects/orchestrator/.env`.
- `deploy/orchestrator.service:20` — `Environment=PATH=/home/dev/.local/bin:/home/dev/.nvm/versions/node/v22.23.1/bin:…` — the operator's nvm layout and node version.
- `deploy/orchestrator.service:22` — `ExecStart=/home/dev/.nvm/versions/node/v22.23.1/bin/node src/index.ts`.
- Clean by contrast: `deploy/orchestrator.service:6` `Documentation=https://github.com/nvergez/orchestrator` is the repo's own public URL — fine.

**Verdict: genericize.**
Rationale: the package should ship a unit *template* (placeholders like `%h` or `<CHECKOUT>`/`<NODE>`, documented in deploy.md), because four of its lines are one person's home directory and nvm version; the filled-in copy is the instance's, installed under `~/.config/systemd/user/`.

- [ ] Turn the four `/home/dev/...` lines into template placeholders (or systemd specifiers like `%h`).

## 7. `.env.example` — placeholder values are clean; one comment leaks the VPS path

Every variable's *value* is an empty placeholder or a generic default — verified line by line (`SLACK_BOT_TOKEN=`, `SLACK_APP_TOKEN=`, `SLACK_CHANNEL_ID=`, `SLACK_ALLOWED_USER_ID=`, `CLAUDE_CODE_OAUTH_TOKEN=` all empty; the optional vars at `:24-49` carry only generic defaults like `5,10`). One hit:

- `.env.example:3` — "# Actual location on the VPS: /home/dev/projects/orchestrator/.env (outside the repo, chmod 600)."

**Verdict: genericize.**
Rationale: the template ships as the operator-facing config skeleton; only the comment naming the owner's VPS path needs to become "next to your checkout / in your config dir" phrasing — everything else stays.

- [ ] Reword the `.env.example:3` comment to drop `/home/dev/projects/orchestrator`.

## 8. `skills-lock.json` — vendored-skill pin file, nothing personal

What it is: a lockfile pinning the 20 vendored `.agents/skills/*` to their upstream source — every entry is `"source": "mattpocock/skills"`, `"sourceType": "github"`, a `skillPath` inside that public repo, and a content hash (e.g. `skills-lock.json:4-9` for `ask-matt`). It references only the public upstream repo and SHA-256 hashes; no paths, IDs, or names of the operator.

**Verdict: keep.**
Rationale: it pins public upstream content by hash and leaks nothing about the operator or instance; it also documents provenance/attribution for the vendored skills.

## 9. `.agents/` and `.claude/` — vendored dev-workflow skills, clean of personal data

What's in them: `.agents/skills/` holds 20 skills vendored from the public `mattpocock/skills` pack (ask-matt, tdd, code-review, wayfinder, triage, prototype, …, all pinned by item 8); `.claude/skills` is a relative symlink `-> ../.agents/skills` (both git-tracked). A full grep of `.agents/` for `nvergez`, `lemlist`, `nicolas`, emails, `/home/dev`, and Slack IDs found nothing — the only near-hit is Slack-ID-shaped ALL-CAPS words like `CONTRIBUTOR` in `.agents/skills/setup-matt-pocock-skills/issue-tracker-github.md:23` (false positive). References to "Matt" (e.g. `.agents/skills/ask-matt/SKILL.md`) are the upstream author's framing, not the operator's identity.

**Verdict: keep.**
Rationale: they are genuinely useful, attributed, public-upstream dev tooling for people hacking on the repo, and contain no operator data — just exclude them from the npm tarball (`files` allowlist in `package.json`) since the CLI's runtime never reads them.

- [ ] When defining the npm `files` allowlist, leave `.agents/` and `.claude/` out of the tarball (repo-only).

## 10. `src/routing.ts:245-246` — the shipped system prompt names the private repo

The routing instructions template hardcodes the disambiguation example into every user's system prompt:

- `src/routing.ts:245` — `` *1.* \`forwardly\` — the product: the export would live in the app, wired to real data ``
- `src/routing.ts:246` — `` *2.* \`scratch\` — sandbox: a one-shot script alongside the product ``

The rest of the module is parametric (hints injected at `:235`, zero-match line built from real hint names at `:252`) — only this example is frozen to the operator's repos.

**Verdict: genericize.**
Rationale: this string ships inside the package *and* is sent to the model for every installer, so the example must use neutral repo names (or be derived from the loaded hints).

- [ ] Replace the hardcoded `forwardly`/`scratch` example with neutral names or hint-derived ones (keep `docs/prototypes/slack-ux/conversations.md:25` in sync — the mock is the source of this verbatim).

## 11. Test fixtures — real Slack IDs, `lemlist/forwardly` URLs, and `/home/dev` paths across `src/*.test.ts`

The unit tests reuse the production instance's real identifiers as fixtures:

- Real channel/user/bot IDs: `src/config.test.ts:9-10` (`SLACK_CHANNEL_ID: 'C0ASJR3LAE6'`, `SLACK_ALLOWED_USER_ID: 'U09CC6M3W1W'`); `src/filter.test.ts:5-7` (adds `botUserId: 'U0BGRT64CPJ'`); `const CHANNEL = 'C0ASJR3LAE6'` in `src/watcher.test.ts:15`, `src/watchdog.test.ts:9`, `src/reconcile.test.ts:10`, `src/db.test.ts:8-9`, `src/dispatch.test.ts:9`, `src/sessions.test.ts:16`; `src/messages.test.ts:28-29`. Plus `src/filter.test.ts:273` — `'*Envoyé avec* <@U0A2GC44JKY>'`, the real Claude-app user ID in the operator's workspace (and a French footer betraying the workspace locale).
- Private-repo URLs: `src/messages.test.ts:85` `'https://github.com/lemlist/forwardly/issues/84'` (and ~12 more through `:541`, incl. `nvergez/orca`, `nvergez/scratch`); `src/dispatch.test.ts:44` `gitRemoteIdentity: { canonicalKey: 'github.com/lemlist/forwardly' }`; `src/guardrails.test.ts:162` `'gh pr list --repo nvergez/orca'` (and `:169`, `:190-204`).
- Instance paths: `src/dispatch.test.ts:10` `const DAEMON_WT = '/home/dev/projects/orchestrator';`, `:24` `/home/dev/orca/workspaces/forwardly/...`; `src/guardrails.test.ts:17` `'cat /home/dev/projects/orchestrator/.env'` (and `:235`, `:264`); `src/delegations.test.ts:19-21` `'444c::/home/dev/scratch::workspace:98'`; `src/messages.test.ts:282-294`.

These are identifiers, not credentials — but together they publish the operator's workspace wiring (which user drives the bot, which channel, which private employer repo it delegates to).

**Verdict: genericize.**
Rationale: tests ship in the public repo (even if pruned from the tarball), and fixtures work identically with obviously-fake IDs (`C0000000000`, `U0000000001`) and a fictional org — no reason to publish the real workspace/channel/user graph.

- [ ] Sweep `src/*.test.ts` replacing `C0ASJR3LAE6`, `U09CC6M3W1W`, `U0BGRT64CPJ`, `U0A2GC44JKY` with fake IDs.
- [ ] Replace `lemlist/forwardly`, `nvergez/orca`, `nvergez/scratch` fixture URLs with a fictional org/repos.
- [ ] Replace `/home/dev/...` fixture paths with neutral ones (e.g. `/home/op/...`).

## 12. `docs/agents/issue-tracker.md` — commands hardcoding `nvergez/orchestrator`

- `docs/agents/issue-tracker.md:3` — "This repo uses **GitHub Issues** on `nvergez/orchestrator`", plus `--repo nvergez/orchestrator` in every `gh` recipe (`:10`, `:12`, `:15`, `:19`, `:21`).

**Verdict: keep.**
Rationale: this doc describes how to develop *this* repo, and `nvergez/orchestrator` **is** the repo's real, public home — a contributor needs the literal commands; nothing here is private.

## 13. GitHub issue links to `github.com/nvergez/orchestrator` throughout docs

Examples: `docs/spec.md:3` ("wayfinder map (#1)"), `docs/spec.md:36-190` (per-decision ticket links), `docs/research/slack-claude-bridge.md:3`, `docs/prototypes/slack-ux/README.md:3`.

**Verdict: keep.**
Rationale: they point at the repo's own public issue tracker — that is provenance, not leakage, and the docs' whole convention is "the ticket holds the rationale".

## 14. `package.json` / `package-lock.json` — no personal metadata

`package.json` has no `author`, no email, no personal URLs (`:1-30`); note `"private": true` and the unscoped name `"orchestrator"` will need npm-publish work, but that is other tickets on map #65, not hygiene. `package-lock.json`: `"name": "orchestrator"` (`:2`, `:8`); all 333 `resolved` URLs point at `registry.npmjs.org` — no private registry, no tokens.

**Verdict: keep.**
Rationale: nothing personal or instance-specific; the publish-metadata gap (name/license/files/bin) is tracked separately on the map.

## 15. `.gitignore` and the local `.env` — secrets correctly out of git

`.gitignore:1-4` ignores `.env` / `.env.*` (keeping `.env.example`); the real `.env` present in this checkout is confirmed ignored-and-untracked (`git status --ignored` → `!! .env`). No committed instance-state files exist (the SQLite DB lives outside the repo by design, `docs/spec.md:138`; `skills-lock.json` and `routing-hints.json` are the only root JSONs, covered above). One hit inside the file itself:

- `.gitignore:1` — comment "# Secrets — never committed. Real file lives outside the repo: /home/dev/projects/orchestrator/.env".

**Verdict: genericize** (the one comment line; the ignore rules themselves are correct and complete).
Rationale: the ignore file ships with the repo, and its comment pins the owner's VPS path for no functional gain.

- [ ] Drop `/home/dev/projects/orchestrator` from the `.gitignore:1` comment.

## 16. `src/` runtime code (non-test) — clean, one cosmetic comment

`src/config.ts` reads everything from `process.env` with generic defaults (DB defaults to `join(homedir(), '.local', 'state', …)`, `src/config.ts:162-164`); no hardcoded IDs, paths, or names anywhere in non-test runtime code except the prompt example in item 10. Cosmetic only: `src/permissions.ts:159` — a comment says "~/.claude/settings.json on the VPS" ("on the VPS" is instance framing, harmless).

**Verdict: keep** (item 10 is carved out separately).
Rationale: the runtime is already fully parameterized by env — exactly what an npm CLI needs.

---

## Summary

| # | Item | Verdict |
|---|------|---------|
| 1 | `routing-hints.json` (+ loader path `src/index.ts:42`) | **move to instance config** |
| 2 | `docs/spec.md` (IDs, lemlist, /home/dev, @nikolai, #radical-squad) | **genericize** |
| 3 | `docs/deploy.md` (/home/dev, user `dev`, UID 1000) | **genericize** |
| 4 | `docs/e2e-scenarios.md` (channel ID, /home/dev/scratch) | **genericize** |
| 5 | `docs/prototypes/slack-ux/` (lemlist/forwardly links, real IDs) | **genericize** |
| 6 | `deploy/orchestrator.service` (four /home/dev lines) | **genericize** |
| 7 | `.env.example` (VPS-path comment, line 3) | **genericize** |
| 8 | `skills-lock.json` | **keep** |
| 9 | `.agents/` + `.claude/skills` symlink (npm-tarball exclusion noted) | **keep** |
| 10 | `src/routing.ts:245-246` prompt example (`forwardly`) | **genericize** |
| 11 | `src/*.test.ts` fixtures (real Slack IDs, lemlist URLs, /home/dev) | **genericize** |
| 12 | `docs/agents/issue-tracker.md` (`nvergez/orchestrator` commands) | **keep** |
| 13 | Issue links to `github.com/nvergez/orchestrator` in docs | **keep** |
| 14 | `package.json` / `package-lock.json` | **keep** |
| 15 | `.gitignore` (rules keep; comment on line 1 genericize) | **genericize** |
| 16 | `src/` non-test runtime code | **keep** |

Counts: **1 move to instance config · 9 genericize · 6 keep.**

## Checked, clean

- **Emails** — zero email addresses anywhere in the tree (only regex false-positives in vendored skill prose).
- **IP addresses / hostnames** — none; the only UID-ish value is `/run/user/1000` (covered in items 2-4).
- **Real tokens** — none; `xoxb-`/`xapp-`/`sk-ant-` appear only as prefix documentation (`.env.example:7,10,19`; `src/config.ts:156-160`; `docs/spec.md:161-162`; `docs/research/slack-claude-bridge.md:29`).
- **`nicolas` / `vergez` / personal email** — no hits outside the GitHub org name `nvergez` in URLs (items 5, 11, 12, 13).
- **`.env`** — present locally, untracked and ignored; never committed.
- **`.github/`** — does not exist (no CI workflows to sweep).
- **`eslint.config.js`, `tsconfig.json`** — generic tooling config, no paths or names.
- **`package-lock.json`** — all `resolved` URLs are `registry.npmjs.org`; no private registry or auth.
- **`.agents/` contents** — grep-clean for every personal identifier (item 9).
- **`docs/research/slack-claude-bridge.md`** — vendor-doc citations and own-tracker links only.
- **`.claude/skills`** — a relative symlink (`../.agents/skills`), no absolute path baked in.
- **Committed instance state** — none beyond `routing-hints.json` (item 1); the SQLite DB and secrets live outside the repo by design.

*Adjacent observation (not a hygiene item, for the map): the repo has no `README.md` and no `LICENSE` file yet — a stranger's very first trip-over — presumably covered by the npm-packaging tickets on map #65.*

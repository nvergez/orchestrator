# Release automation for merge-to-main npm publishing

> Resolution asset for ticket [#68 "Research: release automation for merge-to-main npm publishing"](https://github.com/nvergez/orchestrator/issues/68) (map [#65](https://github.com/nvergez/orchestrator/issues/65)).
> Type `research` (AFK). First-hand sources: the tools' own repos/READMEs/release notes, docs.npmjs.com, the GitHub changelog (github.blog), docs.github.com, registry.npmjs.org, nodejs.org. Researched on 2026-07-09.

## Summary (TL;DR)

Four realistic ways to get "every merge to main produces a release" for a single-package npm CLI:

1. **semantic-release** — the only option where a merge to main publishes **in the same CI run**, with no second merge and no bot PR. Costs: conventional-commit discipline going forward (squash-merge PR titles are enough), and a merge without a `fix:`/`feat:`/breaking commit silently releases nothing.
2. **release-please** — a bot maintains a **release PR**; merging *that* PR tags, changelogs, and creates the GitHub Release. Two merges per release, npm publish is your own step, and CI on the release PR needs a PAT/GitHub App.
3. **changesets** — bump type comes from **changeset files** written per change (no commit convention), consumed by a "Version Packages" PR. Highest per-merge ceremony; designed for monorepos, single-package is supported but its main value (inter-package coordination) goes unused here.
4. **plain tag-triggered workflow** — zero tool dependencies and the canonical npm-OIDC case, but "every merge = release" only holds if the human versions and tags every merge.

**Cross-cutting fact that dominates the auth axis**: npm **trusted publishing (OIDC) went GA on 2025-07-31**, classic tokens were **permanently revoked on 2025-12-09**, write-token lifetimes are capped at 90 days, and **bypass-2FA granular tokens lose direct publish capability around January 2027**. Long-lived token publishing is a dead end; whatever we pick must publish via plain `npm publish` under OIDC. All four options can; semantic-release and the plain workflow do it with the least friction.

**Firm recommendation: semantic-release with OIDC trusted publishing** (runner-up: the plain tag-triggered workflow). Details in [Recommendation](#recommendation).

## The setting: what "release on merge" must mean here

Single-package npm CLI (not a monorepo), public under MIT, Node >= 22.18, TypeScript via type stripping (no build step), GitHub Actions CI, **solo maintainer whose history is free-form prose, not conventional commits**. Desired: automated releases on every merge to main, minimal per-merge ceremony, low maintenance.

## Comparison table

| Axis | semantic-release | release-please | changesets | tag-triggered workflow |
|---|---|---|---|---|
| **Bump derived from** | Conventional commits (Angular preset) since last tag | Conventional commits, accumulated into a release PR | Changeset files written per change | Human decision (`npm version` / manual tag) |
| **Publish trigger** | The CI run on every push to main | Merging the bot's release PR | Merging the "Version Packages" PR | Pushing a `v*` tag / publishing a Release |
| **"Every merge = release"?** | Yes, for merges containing `fix`/`feat`/breaking; silent no-op otherwise | No — two merges; only "releasable units" count | No — two merges; only merges carrying changesets count | Only if the human tags every merge |
| **Changelog** | GitHub release notes by default; `CHANGELOG.md` only via extra plugins | `CHANGELOG.md` committed by the release PR | `CHANGELOG.md` written by the version PR | None in-repo; GitHub auto-generated notes per release |
| **GitHub Releases** | Yes (`@semantic-release/github`, default plugin) | Yes, on release-PR merge | Yes (`createGithubReleases`, default `true`) | Yes, if the workflow creates one (`gh release create --generate-notes`) |
| **npm auth (OIDC)** | Trusted publishing supported (`@semantic-release/npm` >= 13.1.0, 2025-10-19) | Publish step is your own `npm publish` → OIDC-native | `changeset publish` wraps `npm publish`; action OIDC-compatible since v1.7.0 (2026-02-12), reported friction | OIDC-native, canonical case |
| **Needs PAT/GitHub App?** | No (no bot PRs) | Yes, if CI checks must run on release PRs | Same caveat on the version PR | No |
| **Per-merge ceremony** | Conventional PR title (squash merge) | Conventional PR title + merge the release PR | Write a changeset file per PR + merge the version PR | Choose version, tag, push |
| **Maintenance status** | Active — v25.0.5 (2026-06-09) | Active — v17.10.3 (2026-07-09) | Active — CLI 2.31.0 (2026-04-17); v3 & action v2 still pre-release | n/a (no tool) |

Versions/dates verified against [registry.npmjs.org](https://registry.npmjs.org/) and the projects' GitHub releases on 2026-07-09.

## Option 1 — semantic-release: publish directly from the CI run on main

- **Model**: "semantic-release is meant to be executed on the CI environment after every successful build on the release branch" ([README](https://github.com/semantic-release/semantic-release)). No release PR, no tag pushed by a human: the run analyzes commits since the last git tag, computes the next version, tags, publishes to npm, and creates the GitHub Release — all in one pass (pipeline steps "Analyze commits → Generate notes → Create Git tag → Publish", per the README).
- **Bump derivation**: "By default, semantic-release uses Angular Commit Message Conventions" — `fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` footer → major ([docs](https://semantic-release.gitbook.io/semantic-release/)). If no commit since the last release matches, the run logs "There are no relevant changes, so no new version is released." and exits without releasing ([index.js](https://github.com/semantic-release/semantic-release/blob/master/index.js)). So "every merge = release" holds **exactly for releasable merges** and degrades gracefully (silent skip) otherwise — the main failure mode is a mistyped commit prefix silently shipping nothing.
- **Changelog / Releases**: the four **default plugins** are `@semantic-release/commit-analyzer`, `release-notes-generator`, `npm`, and `github` ([plugins doc](https://semantic-release.gitbook.io/semantic-release/usage/plugins)). Release notes land on the **GitHub Release**; a committed `CHANGELOG.md` requires the *additional* `@semantic-release/changelog` + `@semantic-release/git` plugins. Note the deliberate default: the repo's `package.json` version is **not** updated in git — "only the published package will contain the version, which is the only place where it is really required", and the FAQ "strongly recommend[s] against" committing it back ([FAQ](https://semantic-release.gitbook.io/semantic-release/support/faq)).
- **npm auth**: `@semantic-release/npm` supports both `NPM_TOKEN` and **OIDC trusted publishing** — for GitHub Actions "the `id-token: write` permission is required to be enabled on the job", and under trusted publishing "provenance attestations are automatically generated … without requiring provenance to be explicitly enabled" ([plugin README](https://github.com/semantic-release/npm)). OIDC-aware auth verification landed in [v13.1.0 (2025-10-19)](https://github.com/semantic-release/npm/releases/tag/v13.1.0) ("trusted-publishing: verify auth, considering OIDC vs tokens").
- **No PAT needed**: it creates no PRs, and tagging/publishing/Release creation happen inside one run, so the GITHUB_TOKEN don't-trigger-workflows rule (below) doesn't bite — unless you want *other* workflows to fire on its tags.
- **Requirements / status**: engines `^22.14.0 || >= 24.10.0` ([package.json](https://github.com/semantic-release/semantic-release/blob/master/package.json)); latest v25.0.5 published 2026-06-09 — actively maintained.
- **Fit**: existing free-form history only matters up to the **first** tag; after an initial `v1.0.0` tag the analyzer only ever looks at commits since the last release. Going forward, with squash merges only the **PR title** must be conventional. Discipline is real but thin; a `docs:`/`chore:` merge simply doesn't release.

## Option 2 — release-please: a bot-maintained release PR

- **Model**: it "pars[es] your git history, looking for Conventional Commit messages, and creating release PRs"; merging the release PR updates `CHANGELOG.md` and `package.json`, tags the commit, and "Creates a GitHub Release based on the tag" ([README](https://github.com/googleapis/release-please)). So a release always takes **two merges**: the change, then the bot's PR. "Every merge = release" holds only approximately, though for a solo maintainer merging the release PR immediately is a one-click habit.
- **Bump derivation**: "Release Please assumes you are using Conventional Commit messages." A release PR appears only when main contains "releasable units": "A releasable unit is a commit to the branch with one of the following prefixes: 'feat', 'fix', and 'deps'. (A 'chore' or 'build' commit is not a releasable unit.)" ([README](https://github.com/googleapis/release-please)). Non-conforming commits are not releasable units and produce no changelog entry (the docs never describe an error path — they're effectively ignored; the README does not state this in so many words). Escape hatch: a `Release-As: x.x.x` footer forces a specific version.
- **npm publish is not included**: "It does not handle publication to package managers" ([README](https://github.com/googleapis/release-please)). The [release-please-action](https://github.com/googleapis/release-please-action) pattern is a publish step in the same workflow gated on `if: ${{ steps.release.outputs.release_created }}` — that step is your own `npm publish`, so it is **fully compatible with OIDC trusted publishing** (register that workflow file as the trusted publisher).
- **GITHUB_TOKEN caveat**: the action README warns "events triggered by the GITHUB_TOKEN will not create a new workflow run" and recommends "a Personal Access Token" "if you want GitHub Actions CI checks to run on Release Please PRs" ([release-please-action](https://github.com/googleapis/release-please-action)). For a solo repo with branch-protection checks, that means a PAT or GitHub App to create/maintain — recurring maintenance (PAT expiry) that the other options don't impose.
- **Status**: v17.10.3 published 2026-07-09; very active, but "This is not an official Google product" ([README](https://github.com/googleapis/release-please)).

## Option 3 — changesets: intent files instead of commit conventions

- **Model**: "A changeset is an intent to release a set of packages at particular semver bump types with a summary of the changes made" ([README](https://github.com/changesets/changesets)). Contributors run `npx changeset` per change; `changeset version` consumes the files into `package.json` + `CHANGELOG.md`; `changeset publish` "Publishes to NPM repo, and creates git tags" ([CLI README](https://github.com/changesets/changesets/blob/main/packages/cli/README.md)). No commit-message discipline at all — the discipline moves to **writing a changeset file in every releasable PR** (the changeset bot or `changeset status` in CI can enforce it).
- **Automation**: [changesets/action](https://github.com/changesets/action) "creates a pull request with all of the package versions updated and changelogs updated" ("Version Packages" PR); merging it publishes (with the `publish` input) and creates GitHub Releases (`createGithubReleases` defaults to `true`). Same two-merge shape as release-please, and the same GITHUB_TOKEN/PAT caveat applies to CI on the version PR (GitHub docs, below). A merge without a changeset never releases.
- **npm auth**: the action README still describes the token path — "you'll need to have an npm token that can publish the packages … and doesn't have 2FA on publish enabled" — and auto-writes `.npmrc` with `NPM_TOKEN` ([action README](https://github.com/changesets/action)); that guidance collides head-on with npm's 2025/2026 token policy (below). Since [v1.7.0 (2026-02-12)](https://github.com/changesets/action/releases/tag/v1.7.0) the `.npmrc` token line is only appended "when `NPM_TOKEN` is defined", which unblocks OIDC (because `changeset publish` shells out to `npm publish`). Friction remains community-documented rather than first-class: [changesets/action#515](https://github.com/changesets/action/issues/515) asked to split publishing into its own workflow for OIDC, and an E404 with scoped packages under trusted publishing was reported at [npm/cli#8976](https://github.com/npm/cli/issues/8976) (issue read only by title — details **unverified**).
- **Single package**: supported and documented ("I am in a single-package repository", [adding-a-changeset](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md)), but the tool self-describes as "a focus on monorepos" — the machinery for internal-dependency coordination is dead weight here.
- **Status**: `@changesets/cli` 2.31.0 (2026-04-17); the repo's main branch is v3 development and the action's v2 is still on `-next` prereleases (v2.0.0-next.3, 2026-07-01) — active, but with a long-running major transition in flight.

## Option 4 — plain tag-triggered GitHub Actions workflow

- **Model**: human bumps and tags (e.g. `npm version minor` creates the commit + tag — [npm-version docs](https://docs.npmjs.com/cli/commands/npm-version)); a workflow on `push: tags: ['v*']` or `release: published` runs `npm publish`. GitHub's own [Publishing Node.js packages](https://docs.github.com/en/actions/publishing-packages/publishing-nodejs-packages) guide uses the `release published` trigger and shows `permissions: id-token: write` with `npm publish --provenance --access public`.
- **Bump derivation**: entirely manual. "Every merge = release" holds **only by discipline** — this is precisely the ceremony automation is meant to remove, and forget-to-tag / tag-vs-package.json drift are the standing failure modes.
- **Changelog / Releases**: nothing in-repo; `gh release create --generate-notes` will "Automatically generate title and notes for the release via GitHub Release Notes API" and even creates the tag if missing ([gh manual](https://cli.github.com/manual/gh_release_create)). Auto-generated notes are "a list of merged pull requests, a list of contributors to the release, and a link to a full changelog", customizable via `.github/release.yml` ([GitHub docs](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)) — notably, they come from **PR titles**, not commit conventions, which suits a free-form history.
- **npm auth**: this is the canonical trusted-publishing shape — register the workflow file on npmjs.com, add `id-token: write`, plain `npm publish`. No tokens, automatic provenance.
- **Caveat when combining with other tools**: a tag pushed by a workflow using `GITHUB_TOKEN` will **not** fire this workflow — "events triggered by the `GITHUB_TOKEN` will not create a new workflow run"; the workarounds are a PAT or a GitHub App ([GitHub docs](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow)). So "tool tags → tag workflow publishes" chains need a PAT; keeping publish in the same run avoids this.

## npm auth in 2026: trusted publishing vs granular tokens

The policy ground shifted hard after the Shai-Hulud supply-chain attack (2025-09-14). Timeline, all first-hand:

- **2025-07-31 — trusted publishing GA**: "npm trusted publishing with OIDC is generally available" for GitHub Actions and GitLab.com; requires npm CLI >= 11.5.1; "the npm CLI automatically generates and publishes provenance attestations" (opt out via `NPM_CONFIG_PROVENANCE=false`) ([changelog](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)).
- **2025-09-22 — roadmap**: npm will limit publishing to three methods — "Local publishing with required two-factor authentication", "Granular tokens with limited seven-day lifetime" (later relaxed: 7-day *default*, 90-day max), and "Trusted publishing"; TOTP 2FA deprecated in favor of FIDO ([Our plan for a more secure npm supply chain](https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/)).
- **2025-09-29 / mid-October 2025**: new write-enabled granular tokens default to "seven days, reduced from 30 days" expiry, maximum "90 days, which used to be unlimited"; new TOTP setups disabled early October ([changelog](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)).
- **2025-11-05**: classic token creation disabled everywhere; new write granular tokens "enforce 2FA by default" with an opt-in "Bypass 2FA" for CI; existing write tokens capped at 90 days ([changelog](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)).
- **2025-12-09**: "We've permanently revoked all existing npm classic tokens"; `npm login` now issues 2-hour session tokens; granular tokens manageable from the CLI; "Recommended approach: Adopt OIDC trusted publishing" ([changelog](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)).
- **2026-02-18**: bulk trusted-publishing configuration (`npm trust`, npm CLI >= 11.10.0) GA ([changelog](https://github.blog/changelog/2026-02-18-npm-bulk-trusted-publishing-config-and-script-security-now-generally-available/)).
- **2026-07-08 — the token endgame**: bypass-2FA granular tokens lose account-management powers in **early August 2026** and "around January 2027" **lose direct publishing capability entirely**; guidance is to "plan to move automated publishing to trusted publishing (OIDC) or staged publishing with a human approval step, rather than a long-lived publish token" ([changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).

Current trusted-publishing mechanics ([docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers)): supported providers are GitHub Actions (GitHub-hosted runners), GitLab.com pipelines, and CircleCI cloud (no provenance on CircleCI); "Self-hosted runners are not currently supported"; one trusted publisher per package; "Trusted publishing requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher"; on GitHub Actions the `id-token: write` permission is mandatory.

**Practical consequence for this repo**: unattended token-based publishing of a public package has a hard expiry (~January 2027). Any option chosen must publish via `npm publish` under OIDC. One trap: **Node 22.18.0 bundles npm 10.9.3** (below the 11.5.1 floor), while Node 24.10.0 bundles npm 11.6.1 ([nodejs.org dist index](https://nodejs.org/dist/index.json)) — so the CI *publish job* must run Node 24, or run `npm install -g npm@latest` first, even though the package itself supports Node >= 22.18.

## Recommendation

**Adopt semantic-release (default four plugins) publishing via npm trusted publishing.** For this repo it is the only option that makes "merge to main → published release" literally one event, with no bot PR to merge, no PAT/GitHub App to mint and rotate, and no per-merge file ceremony:

1. One workflow on `push: branches: [main]` with `permissions: { contents: write, issues: write, pull-requests: write, id-token: write }`, running tests then `npx semantic-release`.
2. Register that workflow file as the package's trusted publisher on npmjs.com; no `NPM_TOKEN` secret ever exists. Provenance comes for free.
3. Run the job on **Node 24** (bundled npm 11.6.1 satisfies the OIDC floor); the package's own `engines` stays `>= 22.18`.
4. Bootstrap: the free-form history is irrelevant once a first tag exists — cut `v1.0.0` manually (tag + one-off publish), then let the tool own everything after.

**What this commits the maintainer to** (eyes open):

- **Conventional commits on main from now on.** With squash merges, that reduces to conventional **PR titles**; optionally enforce with a PR-title lint check. The failure mode is quiet: a merge whose commits carry no `fix:`/`feat:`/`BREAKING CHANGE:` logs "There are no relevant changes, so no new version is released." and ships nothing — acceptable (docs/chore merges *shouldn't* release) but worth knowing when a release seems "missing".
- **No committed `CHANGELOG.md` and a placeholder `package.json` version in git.** Release notes live on GitHub Releases; upstream "strongly recommend[s] against" committing versions back ([FAQ](https://semantic-release.gitbook.io/semantic-release/support/faq)). If an in-repo changelog later becomes a requirement, `@semantic-release/changelog` + `@semantic-release/git` exist — at the cost of release commits on main.
- **"Every merge = release" is per-releasable-merge**, not per-merge — which is the semantically honest version of the requirement anyway.

**Runner-up: the plain tag-triggered workflow** (`npm version` + `gh release create --generate-notes` + OIDC publish). Zero dependencies, the purest trusted-publishing fit, and its auto-generated notes work from PR titles rather than commit conventions — but every release is a manual act, so the actual requirement ("automated releases on every merge") is not met, only made cheap. It is also the natural fallback if semantic-release ever becomes unmaintained: the tag history it leaves behind is exactly what the plain workflow consumes.

Release-please is a fine third (release PRs give a review point, and its `npm publish` step is OIDC-native) but adds a second merge per release plus a PAT/App for CI on its PRs. Changesets is the wrong shape here: it buys monorepo coordination this repo doesn't need at the price of the highest per-merge ceremony, and its action's token-era guidance (npm token without 2FA) is the pattern npm is actively sunsetting.

## Sources (first-hand)

**semantic-release**
- README (CI-driven model, release steps, commit-type table) — https://github.com/semantic-release/semantic-release
- Default plugins — https://semantic-release.gitbook.io/semantic-release/usage/plugins
- FAQ (version not committed back; start at 1.0.0) — https://semantic-release.gitbook.io/semantic-release/support/faq
- "no relevant changes" skip (source) — https://github.com/semantic-release/semantic-release/blob/master/index.js
- engines `^22.14.0 || >= 24.10.0` — https://github.com/semantic-release/semantic-release/blob/master/package.json
- `@semantic-release/npm` (NPM_TOKEN, OIDC trusted publishing, provenance) — https://github.com/semantic-release/npm
- `@semantic-release/npm` v13.1.0 (trusted-publishing auth, 2025-10-19) — https://github.com/semantic-release/npm/releases/tag/v13.1.0

**release-please**
- README (release PRs, releasable units, Release-As, "does not handle publication", disclaimer) — https://github.com/googleapis/release-please
- Action (GITHUB_TOKEN warning, PAT advice, `release_created`-gated publish) — https://github.com/googleapis/release-please-action

**changesets**
- README (changeset concept, monorepo focus) — https://github.com/changesets/changesets
- CLI (`changeset publish` behavior) — https://github.com/changesets/changesets/blob/main/packages/cli/README.md
- Single-package workflow — https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md
- Action (Version Packages PR, npm token guidance, `createGithubReleases`) — https://github.com/changesets/action
- Action v1.7.0 (`.npmrc` token line only when `NPM_TOKEN` defined, 2026-02-12) — https://github.com/changesets/action/releases/tag/v1.7.0
- OIDC friction — https://github.com/changesets/action/issues/515 ; https://github.com/npm/cli/issues/8976 (unverified beyond title)

**npm / GitHub (auth & platform)**
- Trusted publishers (providers, npm >= 11.5.1, id-token, limits) — https://docs.npmjs.com/trusted-publishers
- Trusted publishing GA (2025-07-31) — https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- Security roadmap (2025-09-22) — https://github.blog/security/supply-chain-security/our-plan-for-a-more-secure-npm-supply-chain/
- Token expiry changes (2025-09-29) — https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/
- Classic token creation disabled (2025-11-05) — https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/
- Classic tokens revoked; session auth (2025-12-09) — https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/
- Bulk trusted publishing GA (2026-02-18) — https://github.blog/changelog/2026-02-18-npm-bulk-trusted-publishing-config-and-script-security-now-generally-available/
- Bypass-2FA GAT deprecation (2026-07-08) — https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/
- GITHUB_TOKEN does not trigger workflows — https://docs.github.com/en/actions/using-workflows/triggering-a-workflow
- Publishing Node.js packages (release-triggered publish, provenance) — https://docs.github.com/en/actions/publishing-packages/publishing-nodejs-packages
- Auto-generated release notes (`.github/release.yml`) — https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes
- `gh release create --generate-notes` — https://cli.github.com/manual/gh_release_create
- `npm version` — https://docs.npmjs.com/cli/commands/npm-version
- Node 22.18.0 bundles npm 10.9.3; Node 24.10.0 bundles npm 11.6.1 — https://nodejs.org/dist/index.json

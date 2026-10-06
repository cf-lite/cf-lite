---
version: 0.4.0
scope: agents
evidence: unverified
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief: prepare a version and publish it to npm (the publish itself is the owner's)

## 1. Purpose
Get cf-lite `<ver>` ready so that the owner can publish it with confidence: every surface a version touches is current, the dependency audit gate is met, the tarballs contain only what they should, a clean install of the tarballs works, and the owner has a short list of commands to run. Not your job: choosing the version level, bumping without authorisation, tagging, publishing, deprecating, changing a dist-tag.

cf-lite has no `release/surfaces.json` and no `release check` command: the surfaces are the list in section 4 and the gates are the commands in it.

## 2. Trigger
The owner asks for a version to be prepared (and names the number and the reason: what a user can observe). Do not run it to "tidy" without a version. Known open item at the time of writing: `create-cf-lite` 0.4.1 (the `npx` copy-filter bug fix) is set on `main` and waits for the owner to publish it ([published.md](../docs/published.md)).

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|
| `<ver>` (x.y.z) and the packages it applies to | task statement (owner's authorisation) | ask; never pick the number or the level |
| Reason in one user-visible sentence | task statement | ask |
| Default branch | `git fetch` | stop |
| A publish token | supplied by the owner at publish time, by the owner only | never ask for it, never handle it: the publish step is the owner's |

## 4. Steps
Work in a fresh worktree from `origin/main`. One version = one branch = one PR. The version bump itself happens only when the owner has authorised that number in the task.

1. Install and build from the lockfile:
   ```bash
   bun install --frozen-lockfile && bun run build
   ```
2. **Audit gate** ([dependency-audit](dependency-audit.md), [D-007](../docs/DECISIONS.md#d-007-a-critical-or-high-advisory-in-a-production-dependency-blocks-a-release-or-publish)): run `bun audit` and classify. A critical or high advisory in a production dependency blocks the publish until fixed or accepted in writing by the owner. Dev-only findings do not block. If it blocks, stop here and report; do not publish around it.
3. Gates:
   ```bash
   bun run typecheck && bun run test && bun run docs:check && bun run llms:check && bun run size:check
   ```
   Expected: all pass. CI must also be green on the PR (`gh run list --branch <branch>`); the browser, e2e and dev suites run there (`bun run test:e2e`, `test:dev`, `test:browser` locally if CI is unavailable).
4. Sweep the surfaces (flag each that needs a decision you do not have):
   | Surface | Check |
   |---|---|
   | versions | `version` in every published `packages/*/package.json` equals `<ver>`; lockstep with the `cf-lite` peer ranges of the adapters |
   | changelog | `CHANGELOG.md`: dated heading for `<ver>`, `## Unreleased` empty or only for what is not in this version |
   | published list | [`docs/published.md`](../docs/published.md) names the version and the date of the registry check after the publish (a follow-up PR, not before) |
   | stability | [`docs/stability.md`](../docs/stability.md) tiers still true; promoting a feature to stable is the owner's |
   | docs | `docs:check`, `llms:check`, `docs:snippets` at 0; [docs brief](docs.md) for anything stale |
   | decisions | an entry exists for every policy change the version contains ([DECISIONS](../docs/DECISIONS.md)) |
5. **Tarball content scan**, for every package that will be published (`cf-lite`, `create-cf-lite`, `@cf-lite/preact|react|solid|svelte|vue`; never `@cf-lite/testing` or `@cf-lite/playwright`, which are `private`):
   ```bash
   mkdir -p /tmp/cfl-pack && for d in packages/cf-lite packages/create-cf-lite packages/react packages/preact packages/solid packages/svelte packages/vue; do (cd $d && npm pack --pack-destination /tmp/cfl-pack --silent); done
   for t in /tmp/cfl-pack/*.tgz; do echo "== $t"; tar tzf "$t" | grep -Ei '(^|/)(\.env[^/]*|\.npmrc|\.dev\.vars[^/]*|[^/]*\.(pem|key|map|tgz|log))$'; done
   ```
   Expected: only `*.example` placeholder files (`.dev.vars.example` in the templates). Compare the rest of `tar tzf` with the `files` field of that package. Then scan the unpacked content for what must never ship:
   ```bash
   for t in /tmp/cfl-pack/*.tgz; do tar xzf "$t" -O 2>/dev/null | grep -nEi "(api[_-]?key|secret|token|password)\s*[:=]\s*[\"'][A-Za-z0-9_-]{16,}|BEGIN [A-Z ]*PRIVATE KEY|/home/[a-z]"; done
   ```
   Expected: no output (no literal credential, private key or absolute home path).
6. **Smoke install** from the tarballs in an empty directory (not inside the repository):
   ```bash
   mkdir /tmp/cfl-smoke && cd /tmp/cfl-smoke && npm init -y >/dev/null && npm i /tmp/cfl-pack/cf-lite-<ver>.tgz && npx cf-lite --help | head -3
   mkdir /tmp/cfl-new && cd /tmp/cfl-new && npm exec --yes --package=/tmp/cfl-pack/create-cf-lite-<ver>.tgz -- create-cf-lite my-app --ui react --no-install | tail -3; ls my-app
   ```
   Expected: the CLI prints its help; the scaffold writes `my-app` (the published `create-cf-lite` 0.4.0 tarball fails here with ENOENT on `_gitignore`: that is the known bug 0.4.1 fixes, and this step is its regression check). Adapter tarballs: install one next to `cf-lite` and run the scaffolded app's `bun run build`.
7. Open the PR with the sweep results. After CI is green and the PR is merged, report to the owner **the exact publish commands** and stop:
   ```bash
   # owner, per package, token supplied at that moment, never committed
   npm publish --access public            # add --tag <name> for anything that is not the next latest
   npm view <package> version dist-tags   # confirm after
   ```
   The dist-tag is `latest` for a normal release; a pre-release or a patch to an older line uses `--tag <name>`. The owner decides.
8. After the owner confirms the publish: re-run `npm view` for each package, then open a docs PR that updates `docs/published.md` (version, registry-check date) and the changelog heading date. Tags: see `docs/published.md` (Tags) and D-019; a new tag needs the owner's authorisation.

## 5. Outputs
Branch and PR titled `release: <ver> sweep`: version fields (only when authorised), `CHANGELOG.md`, no other files. PR body: audit output summary and classification, gate outputs, the tarball file list and scan result, smoke-install result, flagged items, the publish commands for the owner.

## 6. Evidence rules
"Clean audit", "tarball clean" and "smoke install works" are claimed only with the command output of that day in the PR. A step you could not run is reported as "not run". Registry state is written only with the date of the `npm view`.

## 7. Stop and ask (owner)
Every publish, version bump and tag: the owner authorises each one, by number, in the task. Also: a blocking audit finding, a real credential or private path found in a tarball, the dist-tag to use, deprecating or unpublishing anything, adding or removing a published package, promoting a feature to stable, declaring 1.0, any date for 1.0, repository visibility, provenance settings, registry credentials or 2FA.

## 8. Forbidden
Running `npm publish`, `npm deprecate`, `npm dist-tag`, `git tag` or `git push --tags` yourself (except where the owner authorised that exact tag, D-019); asking for, printing or storing a token; committing tarballs; bumping a version the owner did not name; weakening a gate; claiming the repository is public.

## 9. Hand-off
Final message: branch and PR, every gate with its output, tarball list and scan result per package, smoke-install result, flagged items, the exact commands for the owner, what could not be verified.

## 10. Where truth lives
| Question | Source |
|---|---|
| What is published | [`docs/published.md`](../docs/published.md), `npm view <pkg> version dist-tags` |
| Which packages publish | `private` field in `packages/*/package.json` |
| What a tarball contains | `files` in each `package.json`, `npm pack --dry-run --json` |
| Release policy and tiers | [`docs/stability.md`](../docs/stability.md), [D-001](../docs/DECISIONS.md#d-001-release-train-is-04x-no-10-yet), [D-006](../docs/DECISIONS.md#d-006-seven-packages-are-published-to-npm-at-040-the-owner-authorises-every-publish-bump-and-tag) |
| Whether CI is green on a SHA | `gh run list --branch <branch>` |

## 11. Definition of done
- [ ] audit gate met or the block reported (paste `bun audit` summary)
- [ ] `bun run typecheck`, `bun run test`, `bun run docs:check`, `bun run llms:check`, `bun run size:check` pass (paste)
- [ ] tarball list and content scan per package pasted; smoke install pasted
- [ ] CHANGELOG dated; PR merged with CI green
- [ ] publish commands handed to the owner; nothing published, tagged or bumped by you

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
| 2026-10-06 | First version, from how 0.4.0 was published (seven packages, token at publish time, no provenance) plus the gates this repository has. Run that day: `npm pack --dry-run` for `cf-lite` (file list is `dist`, `templates`, `LICENSE`, `package.json`); `bun audit` (state in [dependency-audit](dependency-audit.md)); the tarball content scan and the smoke install ran on tarballs packed from `main` (scan clean apart from `.dev.vars.example` placeholders; CLI help printed; scaffold wrote `my-app`); not yet run with a tarball that is about to be published | doc agent | the publish procedure lived only in chat |

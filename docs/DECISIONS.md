---
version: 0.4.0
scope: reference
evidence: n/a
verifiedOn: 2026-10-06
---

# Decisions log

What was decided about cf-lite, by which role, why, and what in this repository supports it. Read it before changing a doc or a policy: an `active` entry beats a doc that disagrees with it, so fix the doc and cite the id.

## How to read and write this log

- Append only. Never edit an old entry's decision text. A reversal is a new entry; the old one gets `status: superseded by D-nnn`.
- `decided by` is a role (`owner`, `maintainer`, `product owner`), never a personal name.
- `source` is one of: `owner statement (<where it was quoted, date>)`, `PR #n`, `doc <path>`. Chat or memory notes are not sources: whoever assigns the work turns them into a dated owner statement in the task description. `date` is the date of the decision when the source states it, otherwise the date of the source (merge date of a PR, first commit of a doc).
- `evidence` is something a reader can open or run here: a path in backticks, a `PR #n`, a command, or `none (owner statement only)`. Never manufacture evidence.
- `status` is `active`, `superseded by D-nnn`, `unverified` (the evidence is gone) or `revoked`. `lastChecked` is `YYYY-MM-DD by <role>`; an `active` entry not re-checked for 90 days is a docs:check finding.
- `bun run docs:check` validates the format (rule `decisions`). The doc-agent steps are in [agents/README](../agents/README.md).
- Back-fill: entries D-001 to D-016 were written on 2026-10-06 from the owner statements quoted in the task, from merged PRs and from docs already in this repository. An entry marked "none (owner statement only)" has no repository evidence by nature.

## Entries

### D-001 Release train is 0.4.x, no 1.0 yet
| field | value |
|---|---|
| date | 2026-10-05 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | cf-lite shares the 0.4.x version train with the sibling product sets; the packages are versioned 0.4.0 and there is no release-candidate naming (no `rc.1`). No 1.0 is promised. |
| why | One number per x.y keeps compatibility readable across the sibling sets; more completion is needed before a 1.0 claim. |
| scope | all published packages |
| evidence | `packages/cf-lite/package.json` (version 0.4.0), `CHANGELOG.md`, `docs/stability.md` (0.x: minor versions may break, each with an upgrade note) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-002 No 1.0 is scheduled; the pre-1.0 soak review date is not fixed
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | While the train is 0.x no 1.0 is promised. A soak happens on apps that already run cf-lite with real traffic (three apps, chosen 2026-10-02: a gated head app, the project's own docs site, the demo example; see `docs/rc-status.md` section 1c). No review date is written anywhere: the owner decides when to review and what, if anything, is still missing. |
| why | A date written by an agent would be a promise nobody made. |
| scope | release policy, `docs/rc-status.md` |
| evidence | `docs/rc-status.md` (section 1c names the soak apps; its former date target is superseded by this entry), `docs/stability.md` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-003 Agent briefs live in `agents/` at the repository root
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The entry page and every process brief are in `agents/`; `AGENTS.md` and `CLAUDE.md` lead to `agents/README.md`. Standing rule: every process that can become repeatable has a brief inside the repository, so a taking-over agent works from the doc and not from chat. |
| why | A root folder is found by `ls`, is covered by docs:check, and is not mixed into the product docs tree. |
| scope | agent instructions |
| evidence | `agents/README.md`, `AGENTS.md`, `CLAUDE.md`, `scripts/docs-check.mjs` (rules `entry-page`, `agent-briefs`) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-004 The decider in this log is a role, never a personal name
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The `decided by` field holds a role (`owner`, `maintainer`, `product owner`). Older docs that name a person are normalised when touched. |
| why | Keeps product docs neutral and the log valid when people change. |
| scope | this log, all docs |
| evidence | `scripts/docs-check.mjs` (rule `decisions` rejects a `decided by` value outside the role list) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-005 cf-lite is described as open source (MIT), version 0.x
| field | value |
|---|---|
| date | 2026-10-05 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | Docs call cf-lite an open source (MIT) framework at version 0.x. The visibility of this repository is unchanged: no doc claims it is public. Whether a package is on the registry is stated only with the date of a registry check. |
| why | The licence is a fact; visibility is the owner's separate decision. |
| scope | README, AGENTS.md, llms.txt, docs |
| evidence | `LICENSE` (MIT), `docs/published.md` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-006 Seven packages are published to npm at 0.4.0; the owner authorises every publish, bump and tag
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | Published at 0.4.0, dist-tag `latest`, public access: `cf-lite`, `create-cf-lite`, `@cf-lite/preact`, `@cf-lite/react`, `@cf-lite/solid`, `@cf-lite/svelte`, `@cf-lite/vue`. `@cf-lite/testing` and `@cf-lite/playwright` stay private. Packages are released from `main` with a short-lived token supplied at publish time. Every publish, version bump and tag is authorised by the owner one at a time; an agent never does one on its own. |
| why | A registry release cannot be taken back; the owner holds the credential and the call. |
| scope | all packages |
| evidence | `docs/published.md`, `packages/*/package.json` (`private: true` on testing and playwright), `npm view cf-lite version` (0.4.0, checked 2026-10-06) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-007 A critical or high advisory in a production dependency blocks a release or publish
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | A `bun audit` finding of severity critical or high in a PRODUCTION dependency (reaches a published package or a deployed Worker; path does not start at a devDependency) blocks a release or a publish until fixed or accepted in writing by the owner. Dev-only findings do not block: they are reported in the PR and fixed when cheap. The same rule holds in the sibling repositories. |
| why | A consumer installs production dependencies; a dev-tool advisory never reaches them. |
| scope | release, publish |
| evidence | `docs/adapters.md` (the Solid section, an advisory handled under this rule), PR #72 |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-008 `solid-js` 1.x pins a vulnerable `seroval`; the override is carried by the consumer app
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | PR #72 |
| decision | Every `solid-js` 1.x release pins a `seroval` version that the audit flags as critical. A library cannot force a transitive version on its consumers, so `@cf-lite/solid` requires `solid-js >=1.9.15`, documents the `seroval` override and `cf-lite add solid` / `create-cf-lite --ui solid` write it into the app. This is a known issue, kept until a stable `solid-js` ships the patched `seroval`. |
| why | The only option for a library that cannot own its consumers' lockfile; the audit gate (D-007) is met on the app side. |
| scope | `@cf-lite/solid` |
| evidence | `docs/adapters.md` (section Solid: minimum `solid-js` and the `seroval` override), `docs/published.md`, `packages/solid/package.json` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-009 cf-lite stays UI-agnostic; UI adapters are opt-in
| field | value |
|---|---|
| date | 2026-09-30 |
| decided by | owner |
| source | doc docs/adapters.md |
| decision | No UI framework is built in. A UI framework is an optional, ready-made integration installed with one command (`add <ui>` or `--ui <ui>`); core never parses UI code. |
| why | Keeps the core small and lets an app pick or change its UI without a fork. |
| scope | core, `@cf-lite/*` adapters |
| evidence | `docs/adapters.md` (the Direction line at the top), `packages/*` (one package per adapter) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-010 Bun-first toolchain
| field | value |
|---|---|
| date | 2026-10-02 |
| decided by | owner |
| source | doc docs/bun-first.md |
| decision | Bun replaces Node as the developer and CI toolchain and as the CLI runtime. The runtime target does not change: Cloudflare workerd. Node stays only where Miniflare needs it (the dev server). |
| why | Measured in the audit in that page: install, scripts and CI work with Bun alone, except the dev server. |
| scope | tooling, CI, scaffolds |
| evidence | `docs/bun-first.md`, `bun.lock`, `.github/workflows/ci.yml` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-011 Vite plus Hono on Cloudflare only; conventions at build time, no framework runtime
| field | value |
|---|---|
| date | 2026-09-30 |
| decided by | owner |
| source | doc docs/design.md |
| decision | cf-lite is a plain Vite front end plus a plain Hono Worker, packaged as file conventions and one Vite plugin. All framework work happens at build time; at request time there is Workers static assets, Hono and the app's code. It is Cloudflare only and not portable to other hosts. |
| why | Refuses a router and middleware runtime inside the Worker on every request. |
| scope | core design |
| evidence | `docs/design.md`, `docs/conventions.md`, `bun run size:check` (opt-in rule: an unused module costs 0 bytes) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-012 No positioning claim against Next.js yet
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The positioning of cf-lite against Next.js is deferred. Until the owner decides, docs may list what cf-lite does and does not do (the honest gap list in `docs/next-parity.md`, the migration notes), and must not claim superiority, replacement or equivalence, nor a public promise built on the comparison. |
| why | A positioning claim is a public promise only the owner can make. |
| scope | README, docs, release notes |
| evidence | `docs/next-parity.md` (a gap list, not a positioning), `docs/migration-from-nextjs.md` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-013 Stability tiers: stable and experimental; nothing is declared stable yet
| field | value |
|---|---|
| date | 2026-10-01 |
| decided by | owner |
| source | doc docs/stability.md |
| decision | Two tiers. Stable means semver with deprecations living at least one minor with a warning; none is declared yet (0.x: minor versions may break, each with an upgrade note). Experimental may change in any release. Promotion needs at least one production app. |
| why | States the policy a 1.0 would follow without promising it. |
| scope | all public API |
| evidence | `docs/stability.md` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-014 Own lightweight preview; Storybook only as an opt-in recipe
| field | value |
|---|---|
| date | 2026-10-02 |
| decided by | owner |
| source | doc docs/roadmap-dx.md |
| decision | cf-lite ships its own built-in preview (`/__preview` with state files and JSON fixtures). Storybook and similar tools are optional integrations, never the default. |
| why | A preview that renders through the real adapter in workerd, with no second source of truth. |
| scope | dev tooling |
| evidence | `docs/roadmap-dx.md` (decisions section), `docs/preview.md` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-015 Product docs carry no infrastructure or client names
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | Docs, agent briefs, templates and examples contain no hostnames, IPs, private-network names, VM ids, secret-store item names, orchestration tooling names, absolute home paths, or client and project names; where a procedure needs infrastructure it says what is needed, not where it lives. A blocking check covers the agent files and the decisions log. |
| why | Every sentence in an open source repository is read by strangers. |
| scope | all docs |
| evidence | `scripts/docs-check.mjs` (rule `denylist`), `agents/README.md` (rules for every agent) |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-016 Agent docs are in place; what stays open is listed here, not in a status line
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | PR #78 |
| decision | The entry page, the decisions log and six process briefs (docs, release and publish, test and CI triage, dependency audit, examples and field notes, adapter upkeep) are the agent documentation of this repository, merged in PRs #76, #77 and #78. Open items, each the owner's: publishing `create-cf-lite` 0.4.1 (set on `main`, not on the registry at the 2026-10-06 check); the dependency audit gate (D-007) lists high advisories under a production path (`cf-lite > @cloudflare/vite-plugin > miniflare`), so the next publish needs a fix or a written acceptance. No release surfaces file exists in this repository, so no release-check surfaces were added. |
| why | The result of this work is a record of what is true and what is open, so the next agent starts from it and not from chat. |
| scope | agent instructions, release |
| evidence | `agents/README.md`, `agents/dependency-audit.md` (history row of 2026-10-06), `docs/published.md` |
| status | active |
| lastChecked | 2026-10-06 by doc agent |

### D-017 Names are kept as technical names; a trademark disclaimer is published
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | doc README.md (disclaimer) |
| decision | The names `cf-lite`, `create-cf-lite` and `@cf-lite/*` stay as technical names. The README and the docs site footer carry a disclaimer: independent project, not affiliated with, sponsored by or endorsed by Cloudflare, Inc., Optimizely or Vercel Inc.; the third-party marks are used only to describe compatibility. Wording is descriptive ("for Cloudflare Workers", "Next.js-style routing", "migration from Next.js"), never "official". Logos and colours are untouched. No package or product is renamed; renaming is an owner decision. |
| why | Descriptive use of a third-party mark is acceptable; an embedded mark in a product name is not. `cf-lite` does not embed one, but no registry search (USPTO, TMview, WIPO) has been done, so the name is revisited before any public or commercial release. |
| scope | naming, README, docs site |
| evidence | trademark check research, 2026-10-06; `README.md`, `site/app/components/Shell.tsx` |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-018 Real deploys use the existing Workers-scoped token with prefixed, always-deleted workers; screen-reader pass is the owner's
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner answers, 2026-10-06 |
| decision | No new Cloudflare account or token. The nightly deploy smoke (`.github/workflows/deploy-smoke.yml`) uses the existing Workers-scoped token as a repo secret, deploys `examples/site` as `cfl-smoke-<run id>`, always deletes it (API answers 404) and sweeps `cfl-smoke-*` older than one day. One persistent demo worker, `cf-lite-a11y-demo` (`examples/a11y-demo`), serves the 30-minute screen-reader script ([a11y-screen-reader-test.md](a11y-screen-reader-test.md)), which the owner runs in person. The security contact in `SECURITY.md` is the address the owner gave for that purpose; GitHub private vulnerability reporting is enabled when the repository goes public. |
| why | The scratch-account gate in `rc-status.md` is met by prefixed temporary workers; a screen-reader pass needs a human with real assistive technology. |
| scope | CI, security policy, accessibility |
| evidence | green run `deploy-smoke` 37428007294: routes 200, rtt p50 71 ms, `api status ... 404`, sweep `total 0, stale 0`; a first run (37427799817) failed on `/about` 307 and still deleted its worker. `docs/a11y-screen-reader-test.md`. Screen-reader pass, 2026-10-06, OBSERVED-BY-HUMAN (no recording): owner reported the pass as OK; no per-step notes; reader and browser not recorded; repeat with notes before 1.0. |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-019 Tags `v0.4.0` and `create-cf-lite-v0.4.1` are created by an agent; LICENSE files are required only for public repositories
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The owner authorised the agent to create the tags itself, narrowing the tag part of D-006 for these two tags. Annotated tag `v0.4.0` is on the commit that built the published 0.4.0 packages (the last commit on `main` before the registry publish, `83d6908`; its `solid-js` peer range matches the published `@cf-lite/solid@0.4.0`). Annotated tag `create-cf-lite-v0.4.1` is on `4f6d34a` (the 0.4.1 bump). Scheme: `v<x.y.z>` for the lockstep packages, `<package>-v<x.y.z>` for a package released alone. Publishing, version bumps, 1.0 and rc tags stay the owner's. A LICENSE file is required when a repository or package becomes public (cf-lite already carries MIT). |
| why | A tag is how a reader finds the source of a published version; a registry release cannot be taken back, a tag can. |
| scope | release, tags |
| evidence | `docs/published.md` (Tags), `git rev-parse v0.4.0^{commit}`, `gh api repos/<repo>/git/ref/tags/v0.4.0` |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-020 The LICENSE copyright line names the holder the owner states
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The copyright line of every `LICENSE` file (root and `packages/*/LICENSE`) names the holder the owner states; a name is not guessed. The security contact is the address in `SECURITY.md`. |
| why | The legal holder is a fact only the owner can supply. |
| scope | licence files |
| evidence | `LICENSE`, `SECURITY.md` |
| status | superseded by D-023 |
| lastChecked | 2026-10-06 by maintainer |

### D-021 The tree is prepared for publication
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | Neutral product wording across docs, agent briefs and benchmark pages; field notes keep generic technical lessons only; raw benchmark dumps untracked; `@cf-lite/og-worker` private; `LICENSE` in every published package's `files`; `THIRD-PARTY-NOTICES.md`; a `public-hygiene` docs-check rule (generic detection plus an optional external term list, `CF_HYGIENE_TERMS_FILE`) with an allowlist; `scripts/set-repo-url.mjs` rewrites every repository link when the repository moves. |
| why | These steps are needed whichever way the repository is published and can be checked as ordinary reviewed changes. |
| scope | publication, docs, tooling |
| evidence | `scripts/public-hygiene-lib.mjs`, `scripts/set-repo-url.mjs`, `THIRD-PARTY-NOTICES.md` |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-022 The public candidate was cleaned after an independent review; sibling products are not named or depended on
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The public cf-lite does not name or depend on any private sibling product. `cf-lite init opti` was removed (it only delegated to a separate starter package that is not published; listed under "Removed" in the 0.4.2 changelog entry). Project-specific field notes were deleted and only generic technical lessons remain in `docs/field-notes.md`. The hygiene check detects generic shapes only (token and key shapes, home paths, internal hosts, private addresses, co-author trailers); project- and host-specific terms live in an optional external list read from `CF_HYGIENE_TERMS_FILE`, and `docs:check` prints which mode ran. `.github/CODEOWNERS` and the internal launch checklist are not part of the tree. |
| why | An independent review of the candidate bundle found sibling-product names in the CLI, docs and published `dist`, a denylist that itself spelled internal terms, and measurement wording that identified the setup. |
| scope | publication, docs, tooling |
| evidence | `CHANGELOG.md` (0.4.2, Removed), `scripts/public-hygiene-lib.mjs`, `packages/cf-lite/test/public-hygiene.test.ts`, `docs/field-notes.md`. Result on the rebuilt one-commit candidate, from a fresh clone with one `bun install`: gitleaks 0 findings (1 commit), `docs:check` 0 findings in both modes (generic; generic plus the external list), `llms:check` up to date, `typecheck` rc 0 (30 workspaces, 0 errors); the `npm pack` contents of the seven packages and the `dist` of `cf-lite` and of the React adapter contain none of the listed terms (the only match is the copyright holder in `LICENSE`). Follow-up: fake key, PEM and token shapes in tests are assembled at runtime (`packages/cf-lite/test/llm.test.ts`, `ask-provider.test.ts`, `sec-runtime.test.ts`), so no scanner-shaped literal is in source; gitleaks with default rules reports 0 findings on the tree. |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-023 Publication goes through a new repository `cf-lite/cf-lite` with one clean root commit; the licence holder is stated
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner statement (2026-10-06) |
| decision | The repository is published as the new repository `cf-lite/cf-lite` whose history is one root commit, "cf-lite 0.4.x: initial public history", authored by "cf-lite maintainers". The previous repository stays private as an archive and is not changed. The `LICENSE` copyright line (root and `packages/*/LICENSE`) names the owner as holder. The packages are prepared at `0.4.2` with `repository`, `bugs` and `homepage` pointing at the new URL; publishing them stays an owner action (D-006). CI runs on hosted runners only. |
| why | Publishing the old repository would expose its pull-request titles, comments and every old commit (GitHub keeps them reachable through `refs/pull/*` even after a rewrite); one clean commit avoids that. |
| scope | publication, licence, versions, CI |
| evidence | `LICENSE`, `packages/*/package.json`, `scripts/set-repo-url.mjs`, `docs/published.md` |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-024 Every commit on `main` carries the maintainers identity; the deploy smoke is off by default
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner instruction (2026-10-06) |
| decision | Every commit in the history of `cf-lite/cf-lite` has author and committer "cf-lite maintainers". A squash-merge made through the hosting UI stamped the account's profile name, so that commit was replaced by one with the same tree and the maintainers identity, and `main` is changed only by a direct `git push` from a clone configured with that identity (no merge through the web UI or API). The `deploy-smoke` workflow runs only when the repository variable `CF_SMOKE_ENABLED` is `true` (no Cloudflare secret or variable is set); whether a token may live in the CI of a public repository stays the owner's decision. |
| why | The history must not carry a personal name, and a workflow that fails on every night for missing credentials hides real failures. |
| scope | publication, CI |
| evidence | The replacement commit's tree id equals the replaced one; `deploy-smoke` dispatch on `main` ended `skipped` (job `smoke` skipped, not failed); `ci` dispatched three times in sequence on `main` ended `success` each (full job about 12.3 minutes each); `auth-e2e` (HTTP 500 once on the first hosted run) did not reproduce in those three runs, no fix is claimed. |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-025 The repository is opened public after the clpub6/clpub7b scan; the solid advisory is handled as D-008; no code of conduct
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | owner brief (task clpub7b, 2026-10-06) |
| decision | The repository is opened public after the independent scan (clpub6) and the follow-up pass (clpub7b). The `@cf-lite/solid` `seroval` advisory stays handled as in D-008. No `CODE_OF_CONDUCT` and no `CODEOWNERS` file. Issue templates (bug, feature) are added, blank issues stay allowed, and a contact link sends security reports to GitHub private vulnerability reporting. |
| why | The scan found no leak; the open items were stale npm-status wording and missing community files. |
| scope | publication, docs, `.github/ISSUE_TEMPLATE` |
| evidence | `docs/published.md`, `.github/ISSUE_TEMPLATE/config.yml`, D-008 |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

### D-026 0.4.2 of the seven packages is published from the public repository; provenance is not available
| field | value |
|---|---|
| date | 2026-10-06 |
| decided by | owner |
| source | this brief (task clpub9, standing owner authorisation 2026-10-06) |
| decision | 0.4.2 of `cf-lite`, `create-cf-lite` and `@cf-lite/preact|react|solid|svelte|vue` is published from the public repository at `ea6ef1a`, tag `v0.4.2`, no provenance flag (no OIDC where it was published). `@cf-lite/solid` ships with the `seroval` advisory handled as in D-008. Every other package stays unpublished. |
| why | The 0.4.0/0.4.1 metadata pointed at a private repository; 0.4.2 points at the public one and carries the `create-cf-lite` fix. |
| scope | npm, `docs/published.md`, tag |
| evidence | `docs/published.md` (`npm view` results of 2026-10-06), tag `v0.4.2` |
| status | active |
| lastChecked | 2026-10-06 by maintainer |

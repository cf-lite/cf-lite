---
version: 0.4.0
scope: agents
evidence: n/a
verifiedOn: 2026-10-06
owner: maintainer
---

# Agents start here

Entry page for any agent (or human) who works on this repository. cf-lite is an open source (MIT) Vite plugin and CLI for Cloudflare Workers apps, version 0.x ([D-005](../docs/DECISIONS.md#d-005-cf-lite-is-described-as-open-source-mit-version-0x)). This page is about **maintaining the repository**. If you are building an app **with** cf-lite, read [`AGENTS.md`](../AGENTS.md) (the Do and Don't list for app code) and [`llms.txt`](../llms.txt) instead.

Claude Code reads `CLAUDE.md`, Copilot CLI reads `AGENTS.md`; both lead here, so there is one text. Do not fork it.

## Read first, in this order

1. This page.
2. [`docs/DECISIONS.md`](../docs/DECISIONS.md): what was decided, by which role, with evidence. An `active` entry beats any doc that disagrees with it.
3. [`docs/stability.md`](../docs/stability.md) (tiers) and [`docs/published.md`](../docs/published.md) (what is on the registry).
4. [`docs/rc-status.md`](../docs/rc-status.md) and [`docs/roadmap-1.0.md`](../docs/roadmap-1.0.md): the gate audit and the plan. Both are history-plus-plan documents, not a status line; their headers say what is current.
5. The brief for your job (table below). If none fits, see "When unsure".

## Rules for every agent here

- One task is one branch from `origin/main` in a fresh worktree, one pull request. Merge only when CI is green (`gh run list --branch <branch>`).
- Synthetic fixtures only. Never write a secret, token, key or a URL with a query string into a file, log or PR text. Declare names in `.dev.vars.example`, never values.
- Product files (docs, `agents/**`, `AGENTS.md`, templates, examples) contain no infrastructure: no hosts, IPs, private-network names, VM ids, secret-store item names, orchestration tooling names, absolute home paths, client or project names (write "Project A/B"). `bun run docs:check` enforces a floor on the agent files; you enforce the rest.
- Evidence is honest. A claim labelled `VERIFIED` needs a committed recording or recorded command output. You may move a label down on your own, never up without the evidence in the same PR. "Not run" and "could not check" are valid answers; inventing evidence, a date or a version is the one unforgivable error.
- Never bump a version, create or push a tag, or publish to a registry. The owner authorises each of those, one at a time.
- Do not change code to make a doc true (flag it instead), and do not soften a gate to make a finding go away.
- Every process that can become repeatable gets a brief in `agents/` (see [`_TEMPLATE.md`](_TEMPLATE.md)). The agent that does it the first time writes the brief as part of the work.

## Gates before any PR

```bash
bun install --frozen-lockfile
bun run build
bun run test                # unit tests (inside workerd where needed)
bun run docs:check          # 0 findings: links, anchors, CFL ranges, decisions log, agent briefs
bun run llms:check          # llms.txt is generated; `bun run llms:gen` after editing docs/*.md
bun run size:check          # only when a module or the runtime changed
```

CI runs the same checks; `gh run list` shows the runs for a branch. Docs-only PRs run only the cheap docs lint.

## Which brief for which job

| Job | Brief | State |
|---|---|---|
| Keep the docs true; record a decision | [docs](docs.md) | written; no second agent has run it end to end |
| Prepare and ship a version: sweep, audit gate, tarball scan, smoke install; the publish is the owner's | [release-publish](release-publish.md) | scan and smoke install run on `main` tarballs, not on a release candidate |
| A test or CI job fails | [test-ci-triage](test-ci-triage.md) | written from practice, not re-run |
| Audit dependencies (critical/high in production blocks a release) | [dependency-audit](dependency-audit.md) | audit command run once, rest not run |
| Keep examples and field notes current | [examples-field-notes](examples-field-notes.md) | written from practice, not re-run |
| Adapter packages (`@cf-lite/*`) upkeep | [adapter-upkeep](adapter-upkeep.md) | written from practice, not re-run |
| Any other repeatable process | write a brief from [`_TEMPLATE.md`](_TEMPLATE.md) | see rules |

Processes that exist elsewhere but are not owned by this repository (usage scans of other products, vendored-tarball refresh, hosted-service probes) are **not repeatable here**: the owner decides where they live.

## Where truth lives

| Question | Source (never a number copied into prose) |
|---|---|
| What the CLI can do | `bunx cf-lite --help`, [`docs/dx.md`](../docs/dx.md) |
| Doctor codes | `packages/cf-lite/src/doctor.ts`, [`docs/doctor.md`](../docs/doctor.md) |
| Versions and what is published | `packages/*/package.json`, [`docs/published.md`](../docs/published.md), `npm view <pkg> version` on the day |
| What was decided | `docs/DECISIONS.md` |
| Stability tiers | [`docs/stability.md`](../docs/stability.md) |
| Size and speed budgets | `bench/budgets.json`, [`docs/performance-budgets.md`](../docs/performance-budgets.md) |
| Page index for LLMs | `llms.txt` (generated) |
| Which agent does what | this page |

## When unsure: stop and ask

Stop and ask the owner (one decision, the options, your recommendation, the evidence the repository gave) before:

- publishing, creating or pushing a tag, or bumping a version;
- credentials, keys, access-control, account or hostname changes;
- changing the repository's visibility, or any wording that says it is public;
- promoting a feature from experimental to stable, or declaring 1.0, or writing a date for any review (there is no fixed date; [D-002](../docs/DECISIONS.md#d-002-no-10-is-scheduled-the-pre-10-soak-review-date-is-not-fixed));
- anything touching a production instance;
- deleting history, or removing a page that other pages link to;
- any fact only the owner knows: names, scope, dates, public promises, comparisons with another product.

A general "keep going" never clears one of these. Only a specific answer to that exact decision does.

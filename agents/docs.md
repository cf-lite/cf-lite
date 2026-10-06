---
version: 0.4.0
scope: agents
evidence: unverified
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief: keep the documentation true (audit, update, record decisions)

## 1. Purpose
Make every doc in this repository say only what the repository itself can prove today, say where it cannot, and let the next agent start from [agents/README](README.md) instead of chat. You write and fix docs; you never decide product direction and never promote evidence. Not your job: code changes (except doc-tool fixes), releases, tags, publishing, deciding names or scope.

## 2. Trigger
- A PR changed behaviour, a CLI flag, a doctor code, a package name or a version.
- `bun run docs:check` or `bun run llms:check` reports any finding.
- The owner gave a new decision (it arrives in the task description as a dated statement).
- A release sweep ([release-publish](release-publish.md)) flags a stale doc.
- Periodic sweep: a brief or decision whose date is older than half of 90 days.

Do not run it to polish prose with no trigger.

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|
| Decisions to record: date, decided by (role), source kind, text | the maintainer who assigned the task | do **not** infer a decision from chat or older docs; ask |
| Default-branch worktree | `git fetch && git worktree add <dir> -b <branch> origin/main` | never work in a stale checkout |
| Gate commands | [agents/README](README.md) | stop |

## 4. Steps
Work in a fresh worktree from `origin/main`; `bun install --frozen-lockfile`. One concern per PR (audit fixes; one tree; a decisions entry), small enough to review.

### 4.1 Audit freshness (read-only first)
1. `git log -1 --format=%cs -- <file>` is **not** freshness. A page is fresh when you re-ran its claims today.
2. Run the gates and keep the output:
   ```bash
   bun run docs:check && bun run llms:check && bun run docs:snippets
   ```
   Expected: 0 findings. Rules in `scripts/docs-check.mjs` and `scripts/agent-docs-lib.mjs`: links and anchors, CFL ranges against `doctor.ts`, decisions log, entry page, agent briefs, denylist on agent files.
3. For each page you touch build a claim table: claim | kind (command, number, name, behaviour, decision, status) | how to re-check | result (still true, changed, cannot check).
   - Commands and flags: run `bunx cf-lite --help` and the subcommand's `--help`.
   - Numbers: never keep one in prose; point to the command or file that prints it (`bench/budgets.json`, `bun run size:check`). A measurement stays with date, n and evidence file.
   - Names, versions, "published": compare with `packages/*/package.json` and `npm view <pkg> version`; write a published/unpublished sentence only with the date of the check (see [`docs/published.md`](../docs/published.md)).
   - Behaviour on a real Cloudflare account: label by section 6; no recording, no `VERIFIED`.
   - Decisions: must have an entry in [DECISIONS](../docs/DECISIONS.md) or be removed.
4. Cross-doc check: `grep` the other pages for the same fact. One fact, one home, other pages link.
5. The audit output is a table in the PR body: page | verdict | action. Pages you could not check say so.

### 4.2 Update
1. Fix only what the audit marked changed; do not rewrite untouched sections.
2. Keep the structure of [`docs/README.md`](../docs/README.md). A new page is linked from there; a new brief is listed in [agents/README](README.md).
3. After editing any `docs/*.md`: `bun run llms:gen`, commit `llms.txt`. Never hand-edit it.
4. A superseded page is marked, not deleted (a header line saying what replaced it and when, as `docs/rc-status.md` does); nothing with value is removed.
5. User-visible wording changes get one line under `## Unreleased` in `CHANGELOG.md`; pure internal doc fixes do not.
6. Re-run the gates from 4.1 to 0 findings, then `bun run test`.

### 4.3 Decisions log
`docs/DECISIONS.md` is append-only. An entry is created only from (a) an owner statement quoted in the task, (b) a merged PR whose description records a decision, or (c) a doc already in the repository that states one. Field rules are at the top of that file; rule `decisions` enforces them.
- Decided by is a **role** (`owner`, `maintainer`, `product owner`), never a personal name.
- Never edit an old entry's decision text. A reversal is a new entry; the old one gets `status: superseded by D-nnn`.
- `evidence` is something a reader can open or run here; otherwise `none (owner statement only)`. Do not manufacture evidence.
- Re-check every `active` entry older than 90 days (`lastChecked`) and set `unverified` when the evidence is gone; flag it. Never delete silently.
- A contradiction between a doc and an active decision: the decision wins; fix the doc and cite the id. Two decisions that conflict: stop and ask.
- The result of a task that changes policy or process is recorded as an entry, not as a status line in a roadmap.

### 4.4 Product versus infrastructure
This is an open source repository: treat every sentence as read by strangers. Product text contains no hostnames, IPs, private-network names, VM ids, secret-store item names, orchestration tooling names, absolute home paths, client, project or component names (write "Project A/B"), nor hints about who or what wrote it. Where a procedure needs infrastructure say what is needed ("a scratch Cloudflare account and a scoped API token, supplied by the owner") never where it lives. The `denylist` rule is a floor and covers only `agents/**`, `AGENTS.md` and `docs/DECISIONS.md`; also scan the rest of what you touch and your PR text. Known: `docs/field-notes/` and a few older pages name internal projects and people; do not copy the pattern, and flag it to the owner rather than rewriting history silently ([examples-field-notes](examples-field-notes.md)).

Wording rules fixed by the owner: cf-lite is open source (MIT), version 0.x ([D-005](../docs/DECISIONS.md#d-005-cf-lite-is-described-as-open-source-mit-version-0x)); never claim the repository is public; never write a date for a 1.0 or a soak review ([D-002](../docs/DECISIONS.md#d-002-no-10-is-scheduled-the-pre-10-soak-review-date-is-not-fixed)); no comparison claims against Next.js beyond the gap list ([D-012](../docs/DECISIONS.md#d-012-no-positioning-claim-against-nextjs-yet)).

## 5. Outputs
Changed docs, regenerated `llms.txt`, `docs/DECISIONS.md` entries, a PR titled `docs: <concern>`. PR body: audit table, gate output before and after, "could not check" list, decisions recorded with their source.

## 6. Evidence rules
Labels: `VERIFIED` (committed recording or recorded command output) | `OBSERVED` (measured by an agent, with n, date, setup) | `OBSERVED-BY-HUMAN` | `GUESSED` / `UNVERIFIED`. You may move a label down on your own, up only when the evidence is in the same PR. "I could not check this" is a valid result and goes in the PR body.

## 7. Stop and ask (owner)
Any decision you would have to infer (names, scope, version policy, what is stable, what is public); two docs or decisions that disagree and the repository cannot arbitrate; a page that claims real-service behaviour nobody can re-probe now; removing a page other pages link to; any wording that promises something publicly (roadmap, support, replacement or compatibility claims, comparisons with another product); a date for any review; anything about publishing, tags, credentials, hostnames, accounts, repository visibility.

## 8. Forbidden
Inventing evidence or dates; copying numbers into prose; copying text from chat or private notes into the repository; hand-editing `llms.txt`; changing code to make a doc true (flag it instead); editing the denylist in `scripts/agent-docs-lib.mjs` to make a finding disappear; rewriting a decision entry; touching other repositories.

## 9. Hand-off
Final message: branch and PR, gate outputs before and after, audit table, decisions recorded (id and source), "could not check" list, at most five questions for the owner (each one decision with options), what the next doc agent starts with. If you stop midway: commit `handoff/docs-<date>.md` listing pages done and not done on your branch, and delete it in the final PR.

## 10. Where truth lives
| Question | Source |
|---|---|
| What the CLI can do | `bunx cf-lite --help`, [`docs/dx.md`](../docs/dx.md) |
| Doctor codes | `packages/cf-lite/src/doctor.ts` |
| Versions and what is published | `packages/*/package.json`, [`docs/published.md`](../docs/published.md), `npm view` |
| What was decided, when, by which role | `docs/DECISIONS.md` |
| Which agent does what | `agents/README.md` |

## 11. Definition of done
- [ ] `bun run docs:check`, `bun run llms:check`, `bun run docs:snippets` 0 findings (paste output)
- [ ] `bun run test` passes (paste summary)
- [ ] every decision a page mentions has an id; new decisions have a source and evidence or `none`
- [ ] `agents/README.md` current
- [ ] no infrastructure, client or personal-name leak in the diff or the PR text
- [ ] PR body complete (sections 5 and 9)

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
| 2026-10-06 | First version, adapted from the sibling repositories' doc briefs; used once to back-fill the decisions log and fix the status contradictions (PRs on this date). Gates re-run that day; no second agent has run it end to end, so `evidence: unverified` | doc agent | the doc agent needs a brief inside the repository |

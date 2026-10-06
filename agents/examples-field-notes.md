---
version: 0.4.0
scope: agents
evidence: unverified
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief: keep the example apps and the field notes current

## 1. Purpose
Every app under `examples/` builds and passes its e2e on the current `main`, each opt-in feature has an example that proves it, and real-use friction is recorded in [`docs/field-notes.md`](../docs/field-notes.md) with where it was fixed. Not your job: new framework features, deleting a note because it is old, publishing a note that names a client or project.

## 2. Trigger
A feature or adapter changed behaviour; an example fails in CI or `bun run test:e2e`; the owner reports friction from a real port; a new opt-in feature merged without an example.

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|
| What changed (PR, feature) or the friction report | task statement | ask |
| Whether the source is a real app | the maintainer who assigned the task | treat as synthetic; say so |
| Permission to describe a private app | the owner | describe it generically, no names |

## 4. Steps
Work in a fresh worktree from `origin/main`; `bun install --frozen-lockfile && bun run build`.
1. Find the examples the change touches: `ls examples/`; the wiring lives in `scripts/run-sites.mjs`, `scripts/build-sites.mjs`, `scripts/dev-ui-e2e.mjs`, `e2e/*.spec.ts` and the per-feature `scripts/*-e2e.mjs`.
2. Run what covers them:
   ```bash
   bun run typecheck && bun run test:e2e
   ```
   Add `bun run test:dev` and `bun run test:browser` when the change affects dev behaviour or the browser. Expected: pass. A failure goes to [test-ci-triage](test-ci-triage.md).
3. A new feature without an example: add `examples/site-<feature>` from the nearest sibling, wire it into the three places in step 1, add its e2e assertion about *which requests reach the Worker* ([CONTRIBUTING](../CONTRIBUTING.md) guidelines), and add a size baseline (`bun scripts/size-budget.mjs --update`, justify the JSON diff in the PR).
4. Scaffolds: `bun run test:e2e` includes `scripts/scaffold-e2e.mjs` (every `create-cf-lite --ui`); a template change needs it green.
5. Field notes: one entry per real port or real friction, newest first, with: date, what kind of app (a description, never a client or project name), what was fixed and in which version or PR, what worked unchanged, what is still open with what a fix would be. Numbers from a real system are quoted as counts only. Do not edit an old entry's findings; add a dated follow-up.
6. Field notes are public: keep only generic technical lessons (what broke, why, the fix). No project, client or person names, no hostnames, no counts that identify a system.
7. `bun run docs:check && bun run llms:check` (run `llms:gen` after editing docs).

## 5. Outputs
`examples/**`, wiring scripts, `bench/module-sizes.json` (new baselines), `docs/field-notes.md`, `CHANGELOG.md` for user-visible changes. PR title `examples: <what>` or `docs: field note <date>`. PR body: commands run with results, new baselines with the reason.

## 6. Evidence rules
A field-note claim "fixed" cites the test or PR; "works unchanged" cites the example or command that shows it; a real-account result is `OBSERVED` with date and setup, never `VERIFIED` without recorded output.

## 7. Stop and ask (owner)
Naming or describing a real client or internal project; scrubbing or deleting existing notes; deploying an example to a real Cloudflare account; any claim about production use; promoting a feature to stable because an example exists.

## 8. Forbidden
Real hostnames, account ids, tokens, client data in examples or notes; editing `.cf-lite/` generated output; weakening an e2e or budget to pass; deleting a note with value (mark it superseded instead).

## 9. Hand-off
Final message: examples touched, commands and results, baselines changed, notes added, what the owner decides.

## 10. Where truth lives
| Question | Source |
|---|---|
| Which examples exist and how they are wired | `examples/`, `scripts/run-sites.mjs`, `scripts/build-sites.mjs` |
| What an example proves | its `scripts/*-e2e.mjs` or `e2e/*.spec.ts` |
| Size baselines | `bench/module-sizes.json` |
| Friction history | [`docs/field-notes.md`](../docs/field-notes.md) |

## 11. Definition of done
- [ ] `bun run typecheck`, `bun run test:e2e` (and `test:dev`, `test:browser` when relevant) pass (paste)
- [ ] new example wired in the three places and has a size baseline
- [ ] note added with fix reference and no client or project names
- [ ] `docs:check` and `llms:check` at 0

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
| 2026-10-06 | First version from the repository's CONTRIBUTING guidelines and the existing field notes. Not run end to end | doc agent | example upkeep and note format lived in chat |

---
version: 0.4.0
scope: agents
evidence: unverified
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief: keep the framework adapter packages (`@cf-lite/*`) working and honest

## 1. Purpose
The five UI adapters (`@cf-lite/react`, `preact`, `solid`, `svelte`, `vue`; the htmx/Alpine preset is not a package) follow the contract in [`docs/adapters.md`](../docs/adapters.md), build, scaffold and render under workerd on the current `main`, keep their peer ranges accurate, and say what is experimental. Not your job: adding a UI to core (cf-lite stays UI-agnostic, [D-009](../docs/DECISIONS.md#d-009-cf-lite-stays-ui-agnostic-ui-adapters-are-opt-in)), publishing, or declaring a feature stable.

## 2. Trigger
A new major of a UI library or of Vite; a change to the `UiAdapter` contract in core; an adapter test, scaffold or example fails; an audit finding in an adapter's dependencies ([dependency-audit](dependency-audit.md)); a request for a new adapter (the owner decides first).

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|
| Which adapter and what changed (upstream release, contract change, failure) | task statement | ask |
| Whether a new adapter is wanted | the owner | stop; never start one unasked |

## 4. Steps
Work in a fresh worktree from `origin/main`; `bun install --frozen-lockfile && bun run build`.
1. Read the contract and the adapter's package: `docs/adapters.md`, `packages/<ui>/package.json` (`peerDependencies`: `cf-lite ^<train>`, the UI library, `vite`), `packages/<ui>/src/`.
2. Run the adapter-facing gates:
   ```bash
   bun run typecheck
   bun --bun vitest run packages/cf-lite/test/adapter.test.ts
   bun run test:e2e        # builds every adapter app and every `create-cf-lite --ui` scaffold under local workerd
   bun run test:dev        # dev SSR per adapter
   bun run test:browser    # shared Playwright suite, five adapter apps
   ```
   Expected: pass. A failure goes to [test-ci-triage](test-ci-triage.md) first.
3. Upstream bump: raise the UI library only within the declared peer range unless the owner agreed a new range; bump the adapter's `devDependencies`, rerun step 2 and `bun run size:check`. A peer-range change is a user-visible change: `CHANGELOG.md` line plus the adapter table in `README.md` and `docs/adapters.md`.
4. A transitive advisory: classify per [dependency-audit](dependency-audit.md). A consumer-side pin (the pattern of the Solid `seroval` override, [D-008](../docs/DECISIONS.md#d-008-solid-js-1x-pins-a-vulnerable-seroval-the-override-is-carried-by-the-consumer-app)) must be written by `cf-lite add <ui>` and `create-cf-lite --ui <ui>` and documented in `docs/adapters.md`, with the removal condition.
5. Contract change in core: update every adapter in the same PR or mark the unsupported ones in `docs/adapters.md` with the reason (for example Svelte has no `bind`, one-chunk streaming); never leave one silently broken.
6. Numbers: the per-adapter benchmark is regenerated with `node bench/adapters.mjs` and its page carries date and versions; never copy a size into prose elsewhere.
7. `bun run docs:check && bun run llms:check && bun run size:check`.

## 5. Outputs
`packages/<ui>/**`, `packages/cf-lite/src/adapter*.ts` for a contract change, scaffold templates, `docs/adapters.md`, `README.md` adapter table, `CHANGELOG.md`, `bench/module-sizes.json` when a baseline legitimately moves. PR title `adapter(<ui>): <what>`. PR body: gate outputs, peer-range and audit changes, size diff.

## 6. Evidence rules
"Works with <UI> <version>" is claimed only with the e2e and browser output on that version. Experimental features (islands, auto-islands, RSC) stay labelled experimental ([`docs/stability.md`](../docs/stability.md)); a label moves up only by the owner's decision.

## 7. Stop and ask (owner)
A new adapter or a dropped one; widening or narrowing a peer range across a major; a breaking change to the `UiAdapter` contract; promoting an adapter feature to stable; any version bump or publish ([release-publish](release-publish.md)); an advisory with no fix.

## 8. Forbidden
UI-specific code in core; hand-editing `.cf-lite/`; a floating `latest` in a peer range; weakening an e2e or the size budget; bumping the version of any package.

## 9. Hand-off
Final message: adapter(s) and versions tested, each gate with its output, peer or audit changes, size diff, flagged items.

## 10. Where truth lives
| Question | Source |
|---|---|
| The adapter contract | [`docs/adapters.md`](../docs/adapters.md), `packages/cf-lite/src/adapter.ts` |
| Supported UI versions | `peerDependencies` in `packages/<ui>/package.json` |
| What each adapter app proves | `examples/site*`, `scripts/run-sites.mjs`, `e2e/*.spec.ts` |
| Adapter sizes | `bench/RESULTS-adapters.md` (generated), `bench/module-sizes.json` |

## 11. Definition of done
- [ ] typecheck, adapter unit test, `test:e2e`, `test:dev`, `test:browser` pass (paste summaries)
- [ ] `size:check`, `docs:check`, `llms:check` at 0
- [ ] peer ranges and docs agree; audit state recorded in the PR
- [ ] no version bumped, nothing published

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
| 2026-10-06 | First version from the adapters doc, the package manifests, CONTRIBUTING and the Solid override work (PR #72). Not run end to end by a second agent | doc agent | adapter upkeep lived in chat |

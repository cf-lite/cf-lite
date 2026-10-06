# Bun-first toolchain: audit and migration plan

Status: implemented 2026-10-02 (the audit below is the pre-migration state; see "Implemented" at the end). Decision (owner, 2026-10-02, [D-010](DECISIONS.md#d-010-bun-first-toolchain)): Bun replaces Node as the developer / CI toolchain and as the `cfl` CLI runtime. Runtime targets do not change: line A runs on Cloudflare workerd, line B (production) on .NET.

## Method

Throwaway copies of cf-lite (`main` at c1f1d97, via `git archive`) and a separate CMS starter repository (a research branch plus untracked data and tarballs), Bun 1.4.0 against Node 24.20 / npm 11.19, wrangler 4.144-4.145, vitest 4.1, same registry cache. For the Bun runs `PATH` held **no `node`, `npm` or `npx`** (only `bun`/`bunx` and coreutils), so a script that silently needs Node fails. The vitest/typecheck runs used `bun --bun` (Bun's own runtime, not the `#!/usr/bin/env node` shebang). Reference: alveo (`ref/alveo`) does Bun this way: `bun.lock`, `bun install --frozen-lockfile` + `oven-sh/setup-bun` in CI, `bun run` for scripts, `bun src/x.ts` for TypeScript tools. It still ships `#!/usr/bin/env node` in its bin, sets up Node only for `npm publish --provenance`, and runs vitest (not `bun test`). Ideas only, no code copied.

## Compatibility matrix

| Item | Result | Detail |
|---|---|---|
| `bun install` (cf-lite workspaces, 513 pkgs; CMS starter, 109 pkgs) | works | Creates `bun.lock`. `bun pm untrusted`: 0 packages with lifecycle scripts, so no `trustedDependencies` needed (workerd/esbuild ship their binaries as optional deps). Bins of a workspace package whose `dist/` does not exist yet (`cfl`) are linked only by a second `bun install` after the build (npm needs `npm rebuild` for the same reason). |
| `tsc` build of packages | works with change | Root scripts such as `build`, `typecheck`, `test`, `perf:check`, `size:check` contain `npm run build -w pkg`. **Bun rewrites `npm run` inside scripts to `bun run`, which has no `-w`; the flag is appended to the script's own args and the script re-invokes itself forever (a fork bomb: about 1800 processes before it was killed).** Change: `bun run --filter <pkg> build` (also runs packages in parallel). Never leave an `npm run ... -w` in a script that Bun may execute. |
| `tsc --noEmit` per example (`typecheck`) | works with change | With `bun run --filter 'cf-lite-*' typecheck` (same fix). Bun `--filter` runs in parallel, so the time is not like for like. |
| vitest, 1181 unit tests (`bun --bun vitest run`) | works, 2 files blocked | 1160 pass. `storage-workerd.test.ts` and `webhook-workerd.test.ts` (15 tests) time out: they spawn `wrangler dev` with `process.execPath`, which is Bun (see wrangler dev below). |
| `@cloudflare/vitest-pool-workers` (`examples/demo`, `@cf-lite/testing`) | works | 9/9 under `bun run test`, 9.9 s (Node 9.1 s). It does not go through the miniflare HTTP proxy path that blocks `wrangler dev`. |
| `vite build` / `cfl build` (Vite 8 + `@cloudflare/vite-plugin`, prerender) | works | the demo and a CMS head app build identically (2.1 s vs 2.6 s per rebuild). |
| `wrangler deploy --dry-run`, `cfl deploy --dry-run`, `wrangler types`, `cfl prepare` | works | Dry-run bundles and prints bindings. |
| `cfl` commands `doctor`, `analyze`, `types --check`, `add ... --dry-run`, `init --dry-run`, `upgrade --dry-run` | works | Via `bun run cfl ...` / `bunx cfl`. `cli.ts` already spawns with `process.execPath` and already detects `bun.lock` for `add`. |
| `cfl` bin invoked directly (`node_modules/.bin/cfl`) | works with change | `#!/usr/bin/env node` fails when no `node` is on PATH. `bun run`/`bunx` inject a `node` alias that is Bun, so scripts work. Change: `#!/usr/bin/env bun` for the published bins (`cli.js`, `index.mjs`). |
| `docs:check`, `llms:check`, `docs:snippets`, `size-budget.mjs` | works | `bun scripts/x.mjs`. size-budget 80 s vs 73 s on Node. `bun run docs:check` runs because of the `node` alias; the scripts say `node scripts/...`, so switch them to `bun scripts/...` to make that explicit. |
| `cfl dev` / `vite dev` with `@cloudflare/vite-plugin` | **blocked** | Dev server dies at start: `TypeError: Unable to connect` from miniflare `fetchWorkerExportTypes`. Breaks `cfl export` (it boots a dev server), `dev-e2e`, `dev-ui-e2e`, `dev-middleware-e2e`, `rsc-dev-e2e`, `preview-e2e` (all spawn vite/wrangler under Bun). |
| `wrangler dev` (every `*-e2e.mjs`, `scaffold-e2e`, `run-sites`, Playwright `webServer`) | **blocked** | Prints `Ready on http://localhost:PORT`, then every request hangs with 0 bytes (curl timeout; same project on Node returns `hi` at once). Cause: miniflare's dispatcher relies on undici `Pool`/`dispatcher` that Bun's `fetch`/undici shim does not implement, so the ProxyWorker never gets its upstream. Upstream: [workers-sdk#15717](https://github.com/cloudflare/workers-sdk/issues/15717), [bun#42231](https://github.com/oven-sh/bun/issues/42231), [bun#16240](https://github.com/oven-sh/bun/issues/16240) (`getPlatformProxy`). `--ip 127.0.0.1` does not help. |
| Playwright runner + chromium (`bun --bun playwright test`) | works | A spec against a Bun-served page passed in 1.7 s, screenshot written. `playwright test --list` shows all 70 specs. The suite's own `webServer: npx wrangler dev ...` is blocked, as above. `npx` is not available without Node (use `bunx`). |
| `create-cf-lite` scaffold (`--no-install`) | works | The install step hard-codes `spawnSync("npm", ["install"])` (`index.mjs:50`, template text prints `npm run dev`). `add.ts`/`add-extras.ts` pick the package manager from lockfiles but default to npm. |
| Starter tarball install (`file:` tgz, CMS starter head app) | works | `bun install` of `cf-lite`, `@cf-lite/react`, `@optimizely/cms-sdk` from local `*.tgz` tarballs then `bun run build`, `bun run test` (32/32) pass. cf-lite is not on npm yet (registry 404), so scaffolded apps need the tarball path today. |
| CMS starter: `bun run parse`, `vitest run` (46 tests), `tsc --noEmit` | works | `node --experimental-strip-types tools/x.ts` runs through the `node` alias; native form is `bun tools/x.ts`. |
| CMS starter: `wrangler dev` (`npm run dev`), `tools/smoke.ts`, `testlab/**` (`npx wrangler dev`, `npx next`, `npx cf-lite`, lighthouse) | **blocked / needs change** | Same wrangler blocker; `npx` calls need `bunx`. Next.js reference stack and lighthouse are outside the Bun-first target. |
| CMS starter `vitest.spike*.config.ts` | n/a | Fails identically on Node (spike inputs not in the copy), not a Bun difference. |

Not run: `wrangler deploy` for real, `gh`/CI, the browser matrix (firefox, webkit), the lighthouse and Next.js reference stacks.

## Timings (warm package cache, same machine, one run each)

| Step | Node 24 / npm 11 | Bun 1.4.0 |
|---|---|---|
| install, cf-lite workspaces | `npm ci` 10.2 s | `bun install` 1.6 s |
| install, CMS starter | 5.0 s | 0.6 s |
| build packages | 18.2 s (`npm run build`) | 13.3 s (`--filter`, 9.0 + 4.3 s) |
| vitest, all 1181 tests | 16.2 s, all pass | 146 s, 15 fail (workerd-spawning files time out) |
| vitest, same minus those 2 files | 13.8 s | 11.3 s |
| typecheck, all packages and examples | 156 s (sequential, includes the build) | 20.9 s (parallel, build excluded) |
| demo pool-workers test | 9.1 s | 9.9 s |
| size budget | 72.6 s | 80.4 s |
| CMS starter vitest (46) | 3.9 s | 3.1 s |

Takeaway: install is about 6 to 8 times faster; run-time speed is a wash. The CI win is install and parallel `--filter`, not vitest or the bundler.

## Where Node must remain (minimal list)

Exactly one thing, until the upstream fix lands: **the process that runs Miniflare**, that is `wrangler dev`, `vite dev` with `@cloudflare/vite-plugin`, `getPlatformProxy`, and everything that spawns them (`cfl dev`, `cfl export`, the `*-e2e` scripts, Playwright `webServer`, `storage-workerd`/`webhook-workerd` tests). Reason: requests to Miniflare hang under Bun (issues above). The rest of the toolchain (install, scripts, tsc, vite build, vitest, vitest-pool-workers, Playwright runner, wrangler deploy/types, docs tooling, `cfl` build/doctor/analyze/add/init) runs on Bun with no Node on PATH. Nothing needs Node for the deployed artifacts: workerd and .NET are independent of the dev runtime.

Two options for that gap, to be decided by the owner:
1. **Hold at "Bun for everything but the dev server"**: keep the Miniflare-spawning scripts on Node (`#!/usr/bin/env node` in a thin launcher, or `spawn("node", ...)` where they use `process.execPath`) and say so in the requirements. Violates "no Node at all" only for those entry points.
2. **Wait**: keep CI on the e2e jobs as is and migrate only when workers-sdk#15717 / bun#42231 close. Recheck with each Bun and wrangler release (this audit: Bun 1.4.0, wrangler 4.144).

`engines.node >=22` in the published packages stays until the migration is fully done. Dependencies' own `node:` imports are fine: Bun implements them.

## Migration plan

Order is chosen so each step is reversible and CI stays green.

1. **Lockfile.** Commit `bun.lock` (text lockfile, Bun 1.4), delete `package-lock.json` in the same PR, add `"packageManager": "bun@1.4.0"` to the root `package.json`. Pin the Bun version in CI to the same value. Optional `bunfig.toml`: `[install] exact = false`; no `trustedDependencies` needed today (`bun pm untrusted` is clean), recheck on dependency bumps.
2. **Scripts.** In root `package.json`, replace every `npm run X -w a -w b` with `bun run --filter a --filter b X` (mandatory: the `npm run ... -w` form recurses forever under Bun), `node scripts/x.mjs` with `bun scripts/x.mjs`, `node --experimental-strip-types x.ts` with `bun x.ts` (CMS starter), `npx` with `bunx`. In the `scripts/*.mjs` e2e files keep `process.execPath` for tools that work under Bun (build, vite build) and use an explicit `node` binary only for the Miniflare spawns (see "Where Node must remain"). Add a guard test or `docs:check` rule that fails on `npm run .* -w` in any `package.json`.
3. **CI (`.github/workflows/ci.yml`).** Replace `actions/setup-node` + `cache: npm` + `npm ci` with `oven-sh/setup-bun` (pin to a commit SHA as alveo does, `bun-version: 1.4.0`) + `bun install --frozen-lockfile`; drop `npm rebuild` in favor of a second `bun install` after `bun run build` for the `cfl` bin link; `npx vitest` becomes `bun --bun vitest`; `npx playwright install` becomes `bunx playwright install --with-deps chromium`. While option 1 is in force, the e2e / dev-e2e / browser jobs keep `setup-node` next to `setup-bun`, and the weekly Node 22 job becomes the "Node-only e2e" job. Publishing stays `npm publish --provenance` (needs Node + npm for OIDC trusted publishing, same as alveo's `publish.yml`).
4. **Shebangs and bins.** Published bins (`packages/cf-lite/src/cli.ts` -> `dist/cli.js`, `create-cf-lite/index.mjs`) switch to `#!/usr/bin/env bun`; keep `chmod +x` in the build. Before that, confirm `cfl` does not use a Node-only API (the audited commands did not).
5. **Docs and requirements.** `docs/getting-started.md` ("You need Node 22+ ...") becomes "Bun 1.4+ (install: bun.sh); Node is only needed for the dev server until [issue links]". Update `docs/testing.md`, `docs/troubleshooting.md`, `docs/dx.md`, `CONTRIBUTING.md`, `AGENTS.md`/`llms.txt` command snippets (`npm run` -> `bun run`), `docs/performance-budgets.md` commands; run `bun scripts/docs-check.mjs` and `bun scripts/gen-llms.mjs` after.
6. **Starter and `cfl init` templates.** `create-cf-lite`: choose the package manager from `npm_config_user_agent` (Bun when launched by `bun create` / `bunx`), run `bun install`, and print `bun run dev`; `add.ts` / `add-extras.ts` default to `bun` instead of `npm` when no lockfile exists. Template `package.json` scripts stay tool-agnostic (`cf-lite dev`, `cf-lite build`), and `templates/ci/preview.yml` gets `setup-bun` + `bun install --frozen-lockfile` + `bunx cf-lite deploy`. Until cf-lite is on npm, the starter installs from the tarball (`file:` tgz works with `bun install`, verified on a CMS head app). CMS starter: add `bun.lock`, change `package.json` scripts and the `testlab/lib/stack.mjs` `npx` calls to `bunx`, vendor tarballs stay.
7. **Verify, then cut over.** Per repo, with `PATH` that has no `node`: `bun install --frozen-lockfile`, `bun run build`, `bun --bun vitest run`, `bun run docs:check`, the size budget, `bun run cfl doctor`; the Miniflare-spawning jobs on Node as per the decision above. Re-run this audit on each Bun minor to try to drop the exception.

## Reproduce

```sh
# scratch copy, no node on PATH
mkdir -p /tmp/b/bin && for t in bun bunx git bash sh env timeout cat ls grep sed tr head tail mkdir rm cp curl jq tar sort uniq awk ln; do ln -sf "$(command -v $t)" /tmp/b/bin/$t; done
PATH=/tmp/b/bin bun install
PATH=/tmp/b/bin bun run --filter cf-lite build && PATH=/tmp/b/bin bun run --filter '@cf-lite/*' build
PATH=/tmp/b/bin bun --bun vitest run --exclude '**/*-workerd.test.ts'
```

## Implemented (2026-10-02)

Done in one PR: `bun.lock` (package-lock.json removed), `packageManager: bun@1.4.0`, root scripts on `bun run --filter` / `bun scripts/x.mjs`, a `docs:check` guard against `npm run ... -w`, CI on `oven-sh/setup-bun` (pinned SHA) with `bun install --frozen-lockfile`, `cfl` / `create-cf-lite` shebangs `#!/usr/bin/env bun`, `create-cf-lite` and `cfl add` install with Bun by default (lockfile or the launcher wins), CI templates (`cfl add ci`) on setup-bun, docs.

Node deliberately kept (all behind the Miniflare blocker, plus one new finding):

- `cfl dev` and `cfl export` re-run themselves on `node` when started under Bun (`CFL_NO_NODE_HANDOFF=1` disables it); without Node they exit with a clear message.
- `test:e2e`, `test:dev`, `test:browser`, `perf:check` run `node scripts/*.mjs` / `playwright test` (the scripts spawn `wrangler dev` with `process.execPath`; Playwright `webServer` starts wrangler with `node`).
- The two `*-workerd.test.ts` files run on Node.
- **New:** `vitest --coverage` crashes under Bun (`@bcoe/v8-coverage` `mergeRangeTreeChildren` stack overflow), so the coverage ratchet runs on Node.
- `bench/` and `scripts/try-plugin2.mjs` (historical measurement scripts comparing against npm-based stacks) still call npm/npx.
- Publishing (when it exists) stays `npm publish --provenance`; `engines.node` stays.

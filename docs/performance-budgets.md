# Performance budgets and coverage ratchet

Gate 2.3 (Worker size, plus build time / cold start / request p50 below) and the coverage half of gate 2.6 in [rc-status.md](./rc-status.md).

## Worker size budget

`bench/module-sizes.json` holds gzip baselines for:

- `base`: an empty Worker bundled the way Workers see it (esbuild, minified, `cloudflare:*`/`node:*` external).
- `modules.<name>`: each `cf-lite/modules/<name>` entry, fully used.
- `examples.<dir>`: the built Worker of each `examples/*` app (same number as `cf-lite analyze`).

`bun scripts/size-budget.mjs` (CI step "Worker size budget") fails when a measurement exceeds
`baseline * 1.05 + 256 B`, or when a module/example has no baseline. A new module or example needs a baseline:
run `bun scripts/size-budget.mjs --update` and justify any increase in the PR (review the JSON diff).
`--modules-only` skips the example builds for a quick local check.

### Tree-shaking proof

`packages/cf-lite/test/size-budget.test.ts` bundles a Worker that imports every `cf-lite/modules/*` entry
without using it and asserts the output is byte-identical to an empty Worker: an unused module costs 0 bytes
(`"sideEffects": false`, roadmap principle 4). A module that gains a top-level side effect fails this test.

## Coverage ratchet

`bun run test:coverage` (v8 provider, runs on Node: V8 coverage merging crashes under Bun) writes `coverage/` (text summary, `json-summary`, `lcov`) for
`packages/*/src`. `vitest.config.ts` sets thresholds at the current level (2026-10-02, with `rsc.ts` / `rsc-client.ts` measured
again - fake `import.meta.viteRsc` + a DOM, see `rsc-route.test.ts` / `rsc-client.test.ts`: statements 86.43 %, branches 81.19 %,
functions 82.26 %, lines 90.08 %; thresholds 86/81/82/90; 2026-09-30 it was 85/80/80/88 and 73/68/71/76 at the start of WP-COVERAGE). CI runs
`vitest run --coverage`, so coverage cannot drop. **Target: 85 %** on every axis per roadmap 2.6 (statements and lines
are there; branches and functions are ~5 points short) - raise the thresholds whenever measured coverage grows; never
lower them without a written reason. Security-critical modules (`csrf`, `actions`, `csp`, `ratelimit`, `routeconf`,
`session`, `oauth`, `cache`, `isr`, `r2`, `head`) are each >= 85 % statements. Tests must import from `../src/...`, never
`../dist/...`: code loaded from `dist` is invisible to the report (this hid `actions`/`csrf`/`csp`/`ratelimit` at 0 %).
Not covered by unit tests: `cli.ts` (top-level script), `prerender.ts`/`vite.ts` build paths, the `@cf-lite/testing`
and `@cf-lite/playwright` packages (need workerd / a browser) and `head.applyHead` (real DOM) - they are exercised by
the e2e scripts and browser suite, which do not feed this report. `import.meta.env.DEV` is fixed to `true` under vitest, so
production-only branches of `ssr()` (shell cache, error-message redaction, `staticFirst`) are covered by the workerd e2e only.

## Build time / cold start / request p50 / size gate (local, not in GitHub CI)

`scripts/perf-budget.mjs` measures the reference examples (`demo`, `site`, `site-preact`, `site-forms`, `site-isr`, `site-islands`) under local
workerd and compares them with `bench/budgets.json` (committed baselines + per-metric tolerance `baseline * (1 + pct/100) + abs`). It is **deliberately
not a GitHub Actions job** (Actions minutes are limited); run it locally or from a scheduled job on a maintainer's machine.

| Metric | How it is measured | Tolerance |
|---|---|---|
| `buildSeconds` | median of 3 `cf-lite build` runs with `dist/` + `.cf-lite/` removed (deps installed) | +60 % + 3 s |
| `coldStartMs` | median wall time from spawning `wrangler dev` to the first non-5xx answer on `/` | +100 % + 800 ms |
| `p50Ms` | median of 300 sequential loopback requests after 50 warm-up requests (p95 is recorded, not gated) | +60 % + 0.5 ms |
| `workerGzipBytes` | `cf-lite analyze` gzip total | +5 % + 256 B (same as the size gate) |

Local numbers are proxies: workerd reports no per-request CPU time, so `p50Ms` is the loopback round trip (client and server share the host) and is **not** Worker CPU time.
Real CPU p50 / cold TTFB come from `--live --cpu`. The host is shared and noisy: medians, generous tolerances, and a failing metric is re-measured once (best of two) before the gate fails.

```bash
bun run perf:check                                 # build + measure + compare; exit 1 on regression (~2.5 min)
node scripts/perf-budget.mjs --only demo,site      # subset
node scripts/perf-budget.mjs --update              # rewrite baselines on an IDLE host; review the JSON diff, justify in the PR
```

Cron on a maintainer's machine (nightly, 03:17; log kept out of the repo, a non-zero exit is the alert signal):

```cron
17 3 * * * cd <checkout> && git pull -q --ff-only && bun run perf:check >> <state-dir>/cf-lite-perf.log 2>&1 || echo "cf-lite perf budget FAILED $(date -u +\%FT\%TZ)" >> <state-dir>/cf-lite-perf.alert
```

Do not run it while other heavy jobs share the host (the baseline was taken at load ~1-2 on 16 cores; a busy host inflates every metric).
Provenance of the baseline: `measuredOn` in `bench/budgets.json`. Unit tests of the comparison logic: `packages/cf-lite/test/perf-budget.test.ts`.

### Live mode (`--live`, optional)

`--live` additionally deploys **temporary** Workers named `cfl-perf-<example>-<rand>` to the account in `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` (export them first;
use a scratch account), measures the first request (cold) and 100 warm round trips over workers.dev, optionally (`--cpu`) the Worker CPU p50 from the GraphQL
analytics API (polls up to 6 min: analytics lag), then **always** runs `wrangler delete --name <n> --force` and records proof in `bench/results/perf-live-<ts>.json`:
`deleteExit`, the Workers API status for the script after deletion (must be 404 -> `deleted: true`) and the workers.dev URL status. If a Worker survives, the script prints its name
and exits 2. Only examples without resource bindings (no D1/KV/R2/DO/queues/AI...) are deployed. Status: implemented and unit-tested (name, URL parsing, binding guard); **not yet run against a real
account** (needs the scratch Cloudflare account listed in [rc-status.md](rc-status.md)).

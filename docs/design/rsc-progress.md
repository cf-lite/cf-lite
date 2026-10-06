# RSC progress / handoff (branch `feat/rsc`, worktree `~/projects/cf-lite-wt/rsc-impl`)

Next phase starts fresh from this file. ADR: `docs/design/rsc.md`. Spike reference: `spike/rsc` (`docs/design/rsc-spike.md` on that branch).

## Phase: rscA hardening done (branch `feat/rsc-hardening`, worktree `~/projects/cf-lite-wt/rsc-a`), 2026-10-02

### Done
1. **`cf-lite dev` e2e** `scripts/rsc-dev-e2e.mjs` (in `test:dev`): rsc route, loader + env + `getRequest()` ALS, 404/500, island hydration, server-component edit. Found + fixed: the browser never refreshed after a server-component edit (nothing listened to plugin-rsc's `rsc:update`); the generated `rsc-browser.tsx` now passes `onUpdate` and `startRsc` re-fetches the current page in place (client state kept).
2. **ISR on rsc, workerd (R2 + Queue)** `scripts/rsc-isr-e2e.mjs` (in `test:e2e`, overlay on a scratch copy of `site-rsc`, `wrangler dev` x2 sharing persisted R2): HTML MISS/HIT, `?__rsc` MISS/HIT (own entry, `text/x-component` kept), second colo HIT, one tag revalidation -> queue -> both entries regenerated, other id untouched, cookie requests BYPASS. Found + fixed: `isr` convention/queues convention only counted `render = "ssr"` pages, so an rsc-only ISR app had no queue consumer / revalidate endpoint / `isrOrigin()` and `.cf-lite/handlers` did not exist (build error). Unit test in `rsc.test.ts`.
3. **i18n + draft on rsc** `scripts/rsc-i18n-draft-e2e.mjs`: locale redirects (`/`, unprefixed rsc paths, cookie > Accept-Language), `params.locale`, translator + default-locale fallback, `<html lang>` + hreflang through `_layout.rsc.tsx` `i18nHead`, `content-language`, HTML/payload cached per locale; draft cookie => cache + ISR BYPASS (HTML and `?__rsc`), `no-store`, public copy never shows draft text, forged cookie = no powers + no-store, disable ends it. Found + fixed: the verified draft state was not forwarded to the rsc environment (only the Hono context had it): added `RscCtx.draft` -> `RscRequest.draft`, loader arg `draft`, `isDraft()` in `cf-lite/rsc`.
4. **Unit coverage without exclusions**: `vitest.config.ts` shim rewrites `import.meta.viteRsc` to `globalThis.__viteRsc` for `modules/rsc.ts`; `rsc-route.test.ts` (21 tests: page/flight/js:false/nonce/draft/404/redirect/500/boundary-fail/cache+isr wrap/actions incl. guard, redirect, CSRF, size), `rsc-client.test.ts` (11, happy-dom as root devDependency: soft nav, prefetch, fallbacks, popstate, server callback, HMR, viewport), +4 in `rsc-p2.test.ts` (draft, config, action runner, onError). Coverage 86.43 / 81.19 / 82.26 / 90.08, ratchet 86/81/82/90, `rsc.ts` 98%, `rsc-client.ts` 92%.
5. **Live bench** `bench/RESULTS-rsc-live.md` (+ `bench/live/rsc-*`, raw dumps not kept, see [../../bench/live/README.md](../../bench/live/README.md)): see that file. Temporary Workers `tmp-rsclive-{lite,ssr,vinext}` on `<account>.workers.dev`, deleted afterwards (proof in the results file).

### Evidence
* vitest 74 files / 978 tests pass, coverage ratchet green. `npm run test:e2e` all OK incl. `rsc e2e`, `rsc isr e2e`, `rsc i18n + draft e2e`; `test:dev` OK incl. `rsc dev e2e`; `typecheck` OK; `docs:check`, `docs:snippets` OK; `size:check` ok (`site-rsc` 133382 B vs baseline 133365).
* Opt-out byte-identity: `site`, `site-routes`, `site-i18n`, `site-isr-route`, `site-draft` built with this branch vs `origin/main` (separate worktree + npm ci): sha256 of sorted js/html/css/_headers/_redirects identical (9c13b2ed80e5c50f, d7c2559a8ea28350, 6acae8298aa78500, 7ce08d6650a7380b, 0c2ef07c10d23557).

### Decisions (unattended)
* Draft state is passed by value (`unknown`, the sealed-cookie `DraftState`), not re-verified in the rsc env: the Worker-side `draft()` middleware stays the single verifier.
* The e2e overlays (ISR, i18n+draft) copy `examples/site-rsc` to `e2e/.tmp` instead of adding workspace examples (no lockfile churn, `site-rsc` size baseline untouched).
* An unknown locale prefix (`/fr/page`) is answered by the assets layer (SPA fallback) because the Worker-first globs are per known locale: same as ssr routes, not rsc-specific; the test only asserts it is never rendered as locale `fr`.
* happy-dom added as root devDependency for `rsc-client.test.ts` (no other new deps).
* Coverage test for `cache` wrap rebuilds `cacheRoute` with `dev:false` (cache.ts bypasses everything when `import.meta.env.DEV`, always true in vitest).

### Open issues
* `rsc-client` size baseline noisy (bundles react-dom). Soft nav cannot start from a `hydrate = false` page. `head.script` not re-run on soft nav. No `cf-lite add rsc` template.
* Dev HMR refreshes the whole current page payload on any server module change (no per-module granularity); client-component edits go through normal Vite HMR (not covered by e2e).

### Exact next steps
1. `cf-lite add rsc` template; per-module granularity is optional.
2. Keep: size gate, `rsc-pins.test.ts`, advisory re-check (ADR section 7) before any release.

## Phase: P4 done (hardening, measurement, docs, Opti proof, review), 2026-10-01

### Done (ADR section 12)
* Bench `bench/RESULTS-rsc.md` + `bench/rsc-bench.mjs` + raw `bench/results/rsc.json`: rsc vs ssr vs vinext, local workerd (Worker 133 KB vs 287 KB gzip, client JS 78.6 vs 135 KB, CPU proxy 7.2-8.4 vs 14.8 ms, TTFB 37 ms vs ssr 176+ with slow data).
* doctor `CFL014-016` (+ plugin-rsc floor in `CFL015`), CSP nonce on bootstrap, inline Flight and `head.script`, `docs/rsc.md` (linked from `docs/README.md`), CHANGELOG entry.
* Opti proof (in the separate CMS starter repository): an RSC sample app, unmodified SDK `react/server` `OptimizelyComponent` on this branch vs a mock CMS incl. preview/edit; its README compares it with a head app using the `./core` path.
* Independent cross-vendor review (author Claude, reviewer from another model vendor; no code execution of attacks beyond its own repro): **no RCE/Flight-decoding/action/CSRF/ALS finding.** Findings and dispositions:
  1. cache poisoning: `cacheKey.keepParams` allowlist without `__rsc` merges HTML and Flight entries (MEDIUM, CONFIRMED by repro in review) -> FIXED (`keepRscParam` in `rsc-action.ts`, applied to `cacheKey`/`cache`/`isr` in `rsc.ts`; unit test + e2e `/rsc-key`).
  2. `head.script` without CSP nonce (CONFIRMED) -> FIXED (`headElements(hd, nonce)`, e2e `/rsc-csp` checks the head script runs under the strict CSP).
  3. failed post-action re-render returned 200 text/plain (CONFIRMED by reading) -> FIXED (500 via the error boundary path).
  4. doctor did not enforce plugin-rsc >= 0.5.26 -> FIXED (+ test).
  Nothing skipped.

### Evidence
* vitest 72 files / 941 tests pass (P3: 71/933). `scripts/rsc-e2e.mjs` OK (adds nonce CSP, head script, cacheKey cases). `size:check` ok (hand-updated baselines: `site-rsc` 133365, `rsc-action` 1337, `rsc-server` 11971). `docs:check` OK. Opt-out byte-identity: P4 touches only `doctor.ts` and `modules/rsc*.ts` (no scan/generate/vite changes), so the P3 A/B hashes still hold.
* Opti e2e (in the CMS starter repository): 6 groups pass + comparison numbers.

### Decisions (unattended)
* Nonce: reuse `security()`'s `cspNonce`; nonce'd responses bypass cache/isr (already core behaviour), so no new cache logic.
* `__rsc` is a reserved cache-key param: forced into `keepParams`, removed from `ignoreParams`, instead of rejecting such configs.
* No live (workers.dev) benchmark: nothing deployed; documented as local-workerd method.

### Open issues
* TTFB gap vs vinext at ms > 0 (37 vs 27 ms) is a launcher artifact (bisected: a plain Hono streaming route shows it, no React; vinext uses vite-plugin 2.0.0-beta). Resolved as "not an rsc issue"; only a live `workers.dev` comparison would settle absolute TTFB.
* Dev-mode (`cf-lite dev`) e2e, ISR workerd e2e for an rsc route, `cf-lite add rsc` template, i18n/draft interplay still untested. Soft nav cannot start from a `hydrate = false` page. `rsc-client` size baseline noisy (bundles react-dom).
* `npm run typecheck` at the repo root cannot run in this worktree (`.bin/cf-lite` link missing); CI covers it.

### Exact next steps
1. (optional) live `workers.dev` run of rsc/ssr/vinext if absolute TTFB matters (needs a deploy: not allowed in P4).
2. `cf-lite dev` e2e (HMR, getRequest ALS, soft nav, actions) and ISR e2e with R2 + queue bindings on an rsc route.
3. Keep: size gate, `rsc-pins.test.ts`, advisory re-check (ADR section 7) before any release; bump pins only when vinext moves.

## Phase: P3 done (client side), 2026-10-01

### Done (commit 1219656 + docs commit; ADR section 11 describes the design)
* `modules/rsc-client.ts` (browser runtime, started by generated `rsc-browser.tsx`): soft nav between rsc routes (fetch `?__rsc`, transition swap, pushState/popstate), hover + `data-prefetch="viewport"` prefetch, scroll restore, full-load fallback for non-rsc/foreign/failed.
* `export const hydrate = false` on an rsc page = zero client JS (no bootstrap, no inline payload, no client boundary); scan flag `rscNoJs`, `rscRoute({ js: false })`.
* Per-route island chunks verified (plugin-rsc already splits per client module).
* Form-based server actions: `modules/rsc-action.ts` (CSRF, content type, body limit, id parsing, no decodeReply/decodeAction), `rscActionRoute` (`.post` on every rsc route), `createRsc.action/config` (allowlist `serverActions`, `actionGuard`, `actionMaxBytes`), `rscActions` build plugin (`"use server"` only in `app/actions/**` / `*.actions.ts`; replaces `rscNoActions`).
* Example `examples/site-rsc`: rsc-form (+ actions/guestbook, islands/toggle), rsc-pure, rsc-other, rsc-tall; layout nav links.

### Evidence
* vitest 71 files / 933 tests pass (P2: 70/928; new `rsc-action.test.ts` 4 tests + P3 generation/actions-plugin tests). `scripts/rsc-e2e.mjs`: OK (workerd preview + Playwright: zero-JS, chunk split, soft nav with marker surviving, prefetch, viewport prefetch, scroll restore, in-place action with island state kept, ~30 hostile requests). `size:check` ok (baselines by hand: `site-rsc` 127826 -> 131412, `rsc-server` 11954, new `rsc-action` 1194, `rsc-client` 198044 = bundled with react-dom/client, informational). `docs:check` OK. `tsc` on site-rsc clean (root `npm run typecheck` could not run in this worktree: `.bin/cf-lite` link missing, environmental).
* Byte-identical opt-out re-verified A/B vs origin/main src (sha256 of sorted dist js/json/html, definition differs from P1 so numbers differ): site 73189a5daff24b7b, site-routes ef12ad3fabe9a21f, site-i18n 4ef85d155e741b4d - identical on both.

### Decisions (unattended)
* No `decodeReply`/`decodeAction`: own FormData parsing + `$ACTION_ID_` only; bound actions and programmatic calls unsupported (keeps the CVE surface closed).
* Allowlist is two-layer (file location at build, `serverActions` per route at runtime); export is `serverActions` because `actions` already means ssr actions in scan.
* Zero-JS is a per-route static opt (`hydrate = false`), not runtime inference (the boundary client component and Suspense'd islands make runtime detection unsound before bootstrap is emitted).
* Server action callback must not await the commit (React holds the form transition until the callback returns: deadlock found and fixed).
* Removed `rscNoActions` (superseded); old test replaced.

### Open issues
* No doctor checks, dev-mode (`cf-lite dev`) e2e, CSP nonce, docs page, `cf-lite add rsc`, ISR workerd e2e (carried from P2).
* Soft nav cannot start from a `hydrate = false` page; `<head>` scripts added via `head.script` are not re-run on soft nav; a soft-nav response is not Cache-Control aware beyond the 30 s prefetch TTL.
* Programmatic server-function calls and returned values are unsupported by design; no optimistic UI/`useActionState` round-trip (returns ignored).
* `rsc-client` size baseline is noisy (bundles react-dom); consider excluding it from the module budget.

### Exact next steps (P4)
1. `doctor`: pinned deps, `nodejs_compat`, CSP warning for inline Flight; nonce injection.
2. Dev-mode e2e (`cf-lite dev`): HMR, getRequest ALS, soft nav + actions under dev.
3. ISR e2e with R2+queue on an rsc route; docs page `docs/rsc.md` + `cf-lite add rsc`.
4. Decide whether to exclude `rsc-client` from `size-budget.mjs` module list; keep pins/advisory re-check (ADR section 7).

## Phase: P2 done (data, caching, streaming), 2026-10-01

### Done (commit 58fe329 + docs commit on top; ADR section 10 describes the design)
* `cf-lite/rsc` (`modules/rsc-server.ts`, export `./rsc`): `createRsc`, `getRequest`/`getEnv` (AsyncLocalStorage request context), `notFound`/`redirect`, head -> React elements, loader support.
* `*.rsc.tsx` conventions in `scan.ts` (`rscLayouts`, `rscError`, `rscNotFound` only on rsc pages); generated `rsc-entry.tsx` (createRsc) + `rsc-boundary.tsx` ("use client" error/not-found/redirect degrade).
* `modules/rsc.ts`: shell-error recovery -> real 404/3xx/500, boundary pages, `cache`/`isr` wrapping via lazy `config(path)`; `?__rsc` gets same policy/tag.
* Example `examples/site-rsc`: rsc-data (loader+env+cache tags+head+Suspense), nested/deep (nested layouts), rsc-nf, rsc-loader-nf, rsc-redirect, rsc-err, rsc-late (post-flush), KV tag ledger + purge endpoint (test token in `vars`, fixture only).
* Tests: `rsc-p2.test.ts` (12: scan conventions, digests, createRsc ctx/loader/layout/head/modes, cache+tag purge over HTML+payload); `scripts/rsc-e2e.mjs` extended (streaming order, ctx, head, layouts, HIT/MISS + tag/path purge on HTML and `?__rsc`, 404/302/500, post-flush degrade in a browser). Root `typecheck` now includes site-rsc.

### Evidence
* vitest 70 files / 928 tests pass (P1: 69/916). `rsc-e2e`: OK. `size:check`: ok (baseline updated by hand: `site-rsc` 114616 -> 127826 because cache+isr+head code is now in the rsc app; new modules `rsc-server` 11744, `rsc-digest` 533). `docs:check` OK. `tsc` on site-rsc clean.
* Byte-identical opt-out re-verified A/B against origin/main `packages/cf-lite/src`: site 12927d41d3250abb, site-routes b169a6f1eee6d054, site-i18n 43109fea6da0f31d (same as P1).

### Decisions (unattended)
* `_error.rsc.tsx` must be a client component to act as the in-page boundary (needs runtime digest); a server one is still used for the 500 shell page. `_not-found.rsc.tsx` is rendered server-side and passed as an element.
* Cache/ISR config is read in the rsc env and handed to the unchanged `cacheRoute`/`isrRoute` (no edits to cache.ts/isr.ts). ISR itself (R2/queue) is covered by its own tests; only the cache + tags path has an rsc-specific test/e2e.
* Boundary wraps the whole page: an error inside Suspense replaces the page content client-side (users can add their own "use client" boundaries lower down).

### Open issues
* ISR on an rsc route has no workerd e2e (needs R2 + queue bindings); cache stale-if-error is not a feature of `cache.ts` (only ISR has `maxStale`).
* Inline Flight scripts still without CSP nonce; `i18n`/`draft` on rsc untested; no dev-mode (`cf-lite dev`) e2e; `doctor` has no RSC checks; no docs page.
* getRequest() relies on AsyncLocalStorage surviving Flight's scheduling: works in workerd preview (e2e), not verified in `cf-lite dev`.

### Exact next steps (P3)
1. `doctor`: pinned deps present, `nodejs_compat` (now REQUIRED by getRequest), CSP warning for inline Flight scripts; CSP nonce on inject.
2. Dev-mode e2e (`cf-lite dev`) incl. HMR sanity and getRequest ALS.
3. ISR e2e with R2 + queue bindings on an rsc route; decide whether `cache` needs stale-if-error.
4. docs page (docs/rsc.md) + `cf-lite add rsc`; CI wiring of rsc-e2e (already in `test:e2e`).
5. Keep: size gate, `rsc-pins.test.ts`, advisory re-check (ADR section 7).

## Earlier: P1 done (ADR + build foundation), 2026-10-01

### Done
* ADR `docs/design/rsc.md` (API, env layout, scope, opt-out guarantee, "follow vinext" upgrade policy, security baseline with cited advisories).
* Spike ported onto origin/main (7343511) by diff-apply of `packages/ scripts/` + `examples/site-rsc-lite` (renamed `examples/site-rsc`, Optimizely route/dep removed: Opti stays in the separate CMS starter repository). Standalone `examples/site-rsc` spike variants were NOT ported.
* Exact pins: `@vitejs/plugin-rsc 0.5.35`, `react`/`react-dom`/`react-server-dom-webpack 19.3.0`, `rsc-html-stream 0.0.8`; optional peers of `cf-lite`; friendly error if the plugin is missing.
* `"use server"` rejected at build time (`rscNoActions`).
* Tests: `rsc.test.ts` (4), `rsc-pins.test.ts` (4), `scripts/rsc-e2e.mjs` (workerd preview + Playwright hydration, SPA/static/ssr/api still fine; added to `test:e2e`). Size baseline `site-rsc` 114,616 B in `bench/module-sizes.json`.

### Evidence
* vitest: 69 files / 916 tests pass (was 67/908 on main + spike). `size:check`: ok for all examples. `rsc-e2e`: OK. `docs:check`: OK. `e2e.mjs`: OK.
* Byte-identical opt-out: sha256 of sorted `dist/**` (js/json/html) of examples built with this branch vs with origin/main `packages/cf-lite/src`: identical for site, site-routes, site-i18n:
  site 12927d41d3250abb
  site-routes b169a6f1eee6d054
  site-i18n 43109fea6da0f31d

### Decisions (unattended; revisit if wrong)
* Layouts for rsc routes = new `_layout.rsc.tsx` (existing client-style `_layout.tsx` not applied). `head` export reused. `notFound/redirect` from `cf-lite/rsc` as sentinels; post-flush degradation documented.
* Floor for react is 19.2.8 / any 19.3+ (vinext's `^19.2.6` alone is vulnerable to CVE-2026-44907).
* Server actions, soft nav, static prerender, nonce-CSP: out of scope.
* Dropped the standalone variant A/B/C spike example; `examples/site-rsc` has only index(static), about(static), rsc, ssr(control), api.

### Open issues
* Layouts/head/error/notFound/redirect are specified but NOT implemented (rsc-entry.tsx still renders a hardcoded `<html>` shell).
* Inline Flight scripts have no CSP nonce; `isr`/`cache`/`draft`/`i18n` on rsc routes untested.
* `site-rsc` is not in the root `typecheck` script list and has no `cf-lite dev` e2e yet. `doctor` has no RSC check.
* `size-budget.mjs --update` rewrites every baseline (existing drift of ~20 B on main); only the `site-rsc` line was added by hand.

### Exact next steps (P2)
1. `pages.ts` rscFiles: resolve `_layout.rsc.tsx` chain (scan.ts PageRoute needs `rscLayouts`), compose around page; unit tests on generated entry.
2. `head`: resolve in rsc entry (object|fn), render into document head; test via workerd e2e (title/meta present).
3. `cf-lite/rsc` module exporting `notFound`, `redirect`; entry catches before flush -> 404/3xx; error boundary; e2e statuses.
4. `doctor` checks: pinned deps present, `nodejs_compat`, CSP warning; add `site-rsc` to root typecheck script; dev-mode e2e.
5. Keep: size gate, `rsc-pins.test.ts`, re-run advisory query (ADR section 7) before any release.

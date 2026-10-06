# cf-lite field notes

Gaps and friction found by real use. Fixed ones say where; open ones say what a fix would be.

## 2026-09-30 — first port: a gated dashboard Worker

A fully-gated, API-heavy dashboard (SSO gate, 4 JSON API groups, `/ingest` with its own Bearer auth, one vanilla-JS HTML page,
2 D1 bindings, no React, no crons in the Worker). Ported from a hand-rolled `fetch()` router + a 32 KB HTML-in-a-string module.

**Fixed in cf-lite (0.2.1 / 0.2.2)**

* `cf-lite/modules/sso` only had `requireSso()` (401 JSON). A page gate needs "redirect the browser, and bounce stale-but-valid
  cookies through `/refresh`". Added `readSso(req, env)` and `ssoLoginUrl(url, env, refresh)` (0.2.1, `test/modules.test.ts`).
* `cf-lite build` always copied the SPA shell to `/_shell.tpl`, even with no `render = "ssr"` route — 32 KB dead asset in every
  deploy. Now only emitted when an ssr route exists (0.2.2, `test/prerender.test.ts`).

**Worked without changes (worth documenting as a pattern)**

* *Gated site*: `assets.run_worker_first: ["/*"]` in `wrangler.toml/jsonc` — the plugin concatenates its own globs, so this just works.
  The assets layer then has nothing public; the Worker gates and serves the page with `env.ASSETS.fetch(new URL("/", req.url))`
  (add `ASSETS: Fetcher` to your `Env`; the binding exists once `run_worker_first` is set). cf-lite's premise — static traffic never
  touches the Worker — is inverted for such an app; that is inherent to "everything is private", not a cf-lite defect.
* `server/api/<name>.ts` (one Hono sub-app per file) mapped cleanly onto `/api/<name>` routes with path params.
  Non-`/api` routes (`/health`, `/ingest`, `/login`, `/auth/*`, `/`) live in the user-owned `server/worker.ts`, as designed.
* Wrangler **environments** (`[env.preview]` + `CLOUDFLARE_ENV=preview cf-lite build`) produce a separate Worker from the same source.
  `wrangler.toml` (not only `.jsonc`) is read by the plugin.

**Friction, not fixed (open)**

1. **Sticky deploy redirect.** `cf-lite build` writes `.wrangler/deploy/config.json` pointing at `dist/<worker>/wrangler.json`, which is
   the config for whichever `CLOUDFLARE_ENV` was used at build time. A bare `wrangler deploy` afterwards (e.g. a deploy wrapper
   that does not build) deploys *that* env's Worker. Rule: always `cf-lite build` with the intended env immediately before deploying.
   Possible fix: `cf-lite deploy --env <name>` that sets `CLOUDFLARE_ENV` for the build and passes the env to wrangler, and prints the
   Worker name it is about to deploy.
2. **React/react-dom/vite are hard requirements even for an app with no React** (peer deps + the always-on `react()` plugin). The Worker
   bundle is unaffected (nothing imports them), but `node_modules` carries ~8 MB of react + react-dom (measured) that nothing uses. Possible fix: `cfLite({ renderer: "none" })` for
   API + static-HTML apps.
3. **Vite rewrites inline `<style>` in `index.html`** (lightningcss: `--lightningcss-light` toggles that rewrite `color-scheme` /
   `prefers-color-scheme` handling). Not a cf-lite bug, but a trap when porting an existing single-file page; `build.cssMinify: false`
   keeps the page byte-identical. Inline classic `<script>` is untouched.
4. **Worker bundle is not minified** by the Vite path (hono + your code ship as written). Old wrangler/esbuild path did not minify
   either, so this is parity, not regression — but `build.minify` for the Worker environment would be a free gzip win.
5. **No e2e/test-login module.** The "test-only login bypass, off unless a secret exists" pattern (an e2e-login helper) was
   re-implemented by hand in two of the ported apps. Candidate `cf-lite/modules/e2e-login`; left alone until a third app needs it.
6. **Hono sub-app mounting and 404 shape.** `server/api/cost.ts` with `.all("/:name")` answers `/api/cost` and `/api/cost/` with Hono's
   default 404; an app that promised JSON 404s under a prefix must add a `notFound` handler at the root. Only matters for byte-exact ports.
7. `.cf-lite/app.ts` mounts user API routes under one `Hono` with global `Env` — fine — but there is no hook to put middleware *before*
   `/api/*` from the generated app; the user-owned `server/worker.ts` wrapping `app` as a sub-route (`root.route("/", app)`) is the
   workaround and worked well. Worth stating in the README as the intended place for gates.

**Porting hazard (mine, worth a line for the next person):** converting a `String.raw\`…\`` page module to `index.html` by
`bun -e 'import {PAGE}…'` silently turned every non-ASCII character into a literal `\uXXXX` (bun transpiles the template's *raw* text).
Extract from the source file's text instead, then `cmp` against what production serves.


## Resolutions in 0.3 (2026-09-30)

Numbers refer to the "Friction, not fixed" list above.

1. **Sticky deploy redirect — fixed.** `cf-lite deploy [--env <name>]` always does a fresh build for the env named (no `--env` = default env; an inherited `CLOUDFLARE_ENV` is *cleared*), prints
   `deploying Worker: <name> (CLOUDFLARE_ENV=<x|unset>)`, and only then runs `wrangler deploy`. `cf-lite build` prints the same `built Worker:` line so the env is visible.
   Evidence: `CLOUDFLARE_ENV=leaked cf-lite deploy --dry-run` -> `deploying Worker: cf-lite-site (CLOUDFLARE_ENV=unset)`; `cf-lite build --env preview` -> `built Worker: scaffold-env-preview (CLOUDFLARE_ENV=preview)`.
   A bare `wrangler deploy` after a build is still whatever that build produced - the rule "deploy through `cf-lite deploy`" is now the supported path (a deploy wrapper should call it).
2. **React hard requirement — fixed.** `renderer: "none"` is the default; `react`/`react-dom` are no longer dependencies of `cf-lite` (they live in `@cf-lite/react`). The scaffolded `none` app depends on `cf-lite` + `hono` only (asserted in `scripts/scaffold-e2e.mjs`).
3. **Vite rewrites inline `<style>` — documentation only** (Vite/lightningcss behaviour, not cf-lite's). Workaround unchanged: `build.cssMinify: false` keeps the page byte-identical.
4. **Worker not minified — fixed.** `build.minify: true` is set for every Worker environment unless you set it yourself (`cfLite({ minifyWorker: false })` opts out). Measured (exact bytes): API-only Worker 14.9 -> 7.2 KiB gzip, React SSR app 108.6 -> 73.5, Preact 29.0 -> 17.5 (`bench/RESULTS.md` addendum). `scripts/site-e2e.mjs` asserts the bundle is minified.
5. **No e2e-login module — added.** `cf-lite/modules/e2e-login`: `app.route("/__e2e", e2eLogin({ issue }))`; inert (404) unless the Worker has `E2E_LOGIN_SECRET`, constant-time secret check, your `issue()` sets the session (unit-tested, `test/adapter.test.ts`). Built before a third app needed it because the ask was explicit; the session-issuing part is necessarily app-specific.
6. **Hono sub-app 404 shape — documentation only.** Add a root `notFound` handler in your own `server/worker.ts` if you promise JSON 404s.
7. **No hook before `/api/*` — documented as the intended design.** Gates/middleware go in the user-owned `server/worker.ts` (`root.use(gate); root.route("/", app)`); README says so now.

**What that first app needs to move from vendored 0.2.2 to 0.3** (not done):
* `vite.config.ts`: nothing required - `cfLite()` now means `renderer: "none"`, which is what it already is functionally. Drop `react`, `react-dom`, `@vitejs/plugin-react`'s transitive need and any `@types/react` from its `package.json` (saves the ~8 MB noted in item 2).
* If it imports anything from `cf-lite/client` (it should not - no React): none to change. `cf-lite/vite`'s `renderer:` string options are gone (it never set one).
* Re-vendor the new `packages/cf-lite` (0.3.0; new files `adapter.ts`, `add.ts`, `client.ts`, `modules/e2e-login.ts`; removed `core.tsx`, `mount.tsx`, `compose.ts`, `renderer.ts`, `preact-server.ts`, `render-static.ts`). `.cf-lite/meta.json` now has `{"adapter": null}`.
* Re-run its build and diff the Worker: expect it to shrink (minify) and to keep `assets.run_worker_first: ["/*"]` behaviour; re-check the byte-identical page (`cmp`) since nothing in index.html handling changed, and use `cf-lite deploy --env <name>` in its deploy wrapper.


## 2026-09-30 — second port: an API-only Worker + D1 + RPC `WorkerEntrypoint`, ported on 0.4.0

Port done (old-vs-new API diff: 73 requests, 0 diffs; RPC diff over a service binding: 24 calls, 0 diffs; steering e2e 22/22).
**Worked without changes:** named exports from `server/worker.ts` (`export class AppRpc extends WorkerEntrypoint`) are passed through
the Vite build and the service-binding entrypoint works as-is; `server/api/*.ts` sub-apps + a `root.use("/api/*", gate)` in the user-owned
worker reproduced a hand-rolled router's method/SSO/CSRF ordering exactly; `cf-lite/modules/sso` replaced the shared verifier; `cf-lite deploy`
with no `--env` cleared a leaked env as documented.

**Gaps, in order of how much they hurt:**

1. **An API-only app cannot `cf-lite build`/`deploy` without an `index.html`.** `prerender()` throws `dist/client/index.html missing` even
   when `renderer` is none and there are no pages. Workaround: a stub `index.html` + `assets.run_worker_first = ["/*"]` so the asset is
   never served. Fix: skip prerender when there are no static pages (and let the plugin run with no client build), or scaffold the stub.
2. **`wrangler.toml` `[[routes]]` (custom_domain) is inherited by `[env.*]`, so `cf-lite deploy --env preview` stole the production custom
   domain** (the production custom domain answered from the preview Worker for ~2 min and one client request got a 401). Wrangler behaviour, but
   `cf-lite deploy --env X` is the tool that made it a one-liner and it prints the domain only *after* attaching it. Fix: `cf-lite deploy --env`
   should refuse (or require `--allow-routes`) when the resolved env config still contains `routes`/`custom_domain` inherited from the top
   level, and print the routes it is about to attach during the pre-deploy "deploying Worker:" line. Workaround: `routes = []` in every env block.
3. **The sticky `.wrangler/deploy/config.json` redirect also breaks `wrangler dev` and `wrangler d1 migrations apply`, not only bare `wrangler deploy`.**
   After a `cf-lite deploy --env preview`, a local `wrangler dev` bound the *preview's* D1 id while `d1 migrations apply <db>` migrated a
   different local DB -> "no such table" 500s in a test harness that had passed before. Fix: `cf-lite dev`/`cf-lite build` should be the documented
   entry for local runs, or the redirect file should be removed/rewritten after `cf-lite deploy`.
4. **`cf-lite/modules/sso` requires `SSO_ISSUER` (0.4.0) and fails closed with reason "SSO_ISSUER not configured"** - correct, but a consumer that
   upgrades from 0.3's hard-coded issuer and forgets the var just sees 401s. The first app (still on 0.3.0) will need `SSO_ISSUER`/`SSO_AUDIENCE`
   vars when it moves to 0.4; worth a line in the CHANGELOG "upgrade from 0.3" section.
5. Hono path params: `/:id{.+}/commands` vs `/:id{.+}` order and trailing-slash matching needed explicit parity tests (old `(.+)` regex 404'd
   `/api/sessions/<id>/` the same way, but only by luck of ordering) - no framework change needed, just a reminder that a byte-exact port needs a
   route-level diff harness (`workers/<name>/test/parity.ts` in the consumer repo is a reusable shape: same D1, two Workers, normalized diff).
6. **Size:** API-only Worker grew 6.3 -> 12.0 KiB gzip (hono + generated app); that is the price of the router, not a regression.

## Lessons from moving existing Workers onto cf-lite (0.4.0, 2026-09-30)

Three hand-written Workers (a gated dashboard, an API-only Worker with RPC, a Preact PWA with a Durable Object, hibernating WebSockets, cron and service bindings) were moved from a hand-rolled `vite build` + `wrangler deploy` to `cf-lite build` / `cf-lite deploy` and compared with the old code on throwaway `workers.dev` previews. Only generic findings are kept here.

**Worked as documented:** the matcher goes to `assets.run_worker_first` and concatenates with hand-written globs; routes registered on `root` before `root.route("/", app)` bypass the middleware; exporting a Durable Object class, a `scheduled` handler or a `WorkerEntrypoint` from `server/worker.ts` needs nothing from cf-lite and `durable_objects`, `migrations`, `triggers.crons`, `services` and `d1_databases` survive into `dist/<worker>/wrangler.json`; `cf-lite/modules/sso` replaced a hand-written verifier with three vars. Worker size on the same source: 214.65 KiB (55.44 KiB gzip) to 123.33 KiB (38.79 KiB gzip), because Vite 8 minifies the server environment.

**Gaps and traps** (fixed ones are in the changelog):

1. A matcher without negatives failed strict `tsc` (typed `mwExclude`: fixed).
2. `@cf-lite/testing` skips the compatibility-date clamp for `wrangler.toml` (set `compatibilityDate` in `cfLiteTest()`, pass `wrangler: "./wrangler.toml"`) and cannot boot an app with service bindings (derive a test config without `services`, `routes`, `env`).
3. Tests that import the Worker run under vitest in workerd; tests using `bun:test` stay a separate run.
4. Routes registered on `root` before `app` bypass the middleware, including a gated page registered there out of habit; such pages belong in `notFound()`, which runs after the gate.
5. Middleware that sets context variables cannot be typed against the generated app (`Variables` missing, TS2345): cast the default export; handlers keep their own typed `Hono<{ Bindings; Variables }>`.
6. An API-only app needs a minimal `index.html` to build (see [troubleshooting.md](troubleshooting.md)).
7. Wrangler environments inherit `[[routes]]` and `triggers.crons`: a preview deployed with `--env` took over a custom domain for about two minutes. Set `routes = []` (and `crons = []`) in every `[env.*]` block.
8. The sticky `.wrangler/deploy/config.json` redirect also affects `wrangler dev` and `wrangler d1 migrations apply`, not only a bare `wrangler deploy`.
9. A multi-environment Vite build moves the client output to `dist/client`: a post-build plugin must use `applyToEnvironment` and `this.environment.config.build.outDir`.
10. The client entry must be `<root>/index.html` (a custom Vite `root` has to move it and set `publicDir`); `Env` must be global for the generated app; TypeScript 6 rejects side-effect CSS imports without `declare module "*.css"`.
11. `wrangler versions upload --preview-alias` on a Worker without preview URLs yields a 404 page and no error; a preview of a Worker with write-only secrets proves the wiring, not the secret-gated paths.
12. A byte-exact port needs a route-level diff harness (same D1, two Workers, normalized diff); Hono path-param order and trailing-slash matching need explicit parity tests.

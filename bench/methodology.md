## Read this before quoting any number

**What was run.** `bench/run.sh` → rsync to the benchmark runner (8 vCPU Xeon E5-2696 v4, idle) → `bench/measure.mjs <variant>` for each:
`cf-lite`, `cf-lite-wrangler` (same app, other launcher), `vinext`, `next-opennext`, plus two **control** variants,
`bare-vite` / `bare-wrangler` (a ~10-line Worker with no framework and no Hono serving the same three routes).
Nothing is deployed; everything runs under local workerd.

**v0.2 additions.** `cf-lite-ssr` / `cf-lite-ssr-preact` are one app (`apps/cf-lite-ssr`: root `_layout`, `head` exports, static `/about`,
an SSR route `/posts/:id` with a loader, `/api/hello`, `_redirects`) built twice — `renderer: "react"` and `renderer: "preact"` (env `CF_LITE_RENDERER`).
They exist to measure what the SSR renderer costs in the Worker (the main `cf-lite` app has no SSR route, so it never bundles a renderer). The extra latency row
`ssr` is `GET /posts/7` (Worker + layouts + head + 20-item list, streamed). They are measured by the same harness, same host, same run as everything else.

**The app** (same in every variant): `/go/github` redirect, `/api/hello` JSON, `/about` static content page.
Redirect: `_redirects` (cf-lite) vs `redirects()` in `next.config.mjs` (vinext, Next). Content page: `render = "static"` (cf-lite)
vs `force-static` App Router page (vinext, Next).

**Metrics.**
* *build*: `npm run build` (cf-lite: vite build + prerender; vinext: `vite build`; Next: `opennextjs-cloudflare build`), 3 runs,
  build outputs deleted between runs (no `.next`/vite cache), dependencies already installed, install time reported separately.
* *Worker code*: cf-lite/bare: the built Worker `index.js`; vinext: every `.js/.mjs/.json` in `.cloudflare/output/v0/workers/default/bundle`;
  Next: files produced by `wrangler deploy --dry-run --outdir` (wrangler's own bundling; its reported "Total Upload" gzip is listed too).
  gzip = `zlib` level 9 per file, summed.
* *content page JS*: fetch the page HTML from the running server, download every `<script src>` / modulepreload `.js`, gzip each, plus inline `<script>` bodies.
* *latency*: Node `fetch` (keep-alive) on loopback, 200 warm-up requests, then 3000 sequential requests (c=1, p50/p95/p99), then 3000 requests at c=16 (req/s). One latency run per route per variant.

**Caveats (these matter).**
1. **The local launchers have a ~15.5 ms floor for any request that enters the Worker** (see bare-* rows: 15.6–15.9 ms p50, 64 req/s at c=16 for a Worker
   that returns a constant). That is the local `vite preview` / `wrangler dev` dispatch path, not workerd and not production — real Workers have no such floor.
   So absolute latencies and req/s for Worker-handled routes are launcher-bound; compare only **(a)** assets-served vs Worker-served and **(b)** the delta-over-floor table.
   Deltas of ≲1–2 ms are within noise (single run; p95 spread is 1–2 ms).
2. The "redirect ≈ 3–4 ms vs ≈ 16–19 ms" gap in cf-lite's favour is real in the sense that cf-lite's redirect and static page are answered by the assets layer *without entering the Worker*, while
   vinext/Next enter the Worker (and therefore pay the launcher floor plus their own routing). In production the absolute gap will be much smaller than 13 ms, but the asset path still costs no Worker
   invocation (no CPU time, no request billed to Workers) — that, not milliseconds, is the point.
3. **Not the same capability.** The cf-lite content page is prerendered and ships **zero JS** by construction (`hydrate` is opt-in). vinext/Next content pages ship the React + router client
   runtime for hydration (5–6 JS files). If a cf-lite page opts into `hydrate = true` the client cost is React + the tiny router ≈ 70 KiB gzip (the demo's entry chunk).
4. cf-lite's Worker here has **no SSR route**, so `react-dom/server` isn't in it (14.9 KiB gz). The demo app, which has an SSR page + a Durable Object, is 111 KiB gz.
5. vinext is 1.0.0 on `@cloudflare/vite-plugin` 2.0.0-beta + `cf` CLI; Next 16.3.7 + `@opennextjs/cloudflare` 1.20.7. Versions float (caret); re-run before quoting.
6. Single host, client and server share the 8 vCPUs; single run for latency. Treat as indicative, not a rigorous statistical comparison. No confidence intervals.
7. Incident during benchmarking (recorded for honesty): the first Next variant used `"build": "opennextjs-cloudflare build"` in package.json, which OpenNext re-invokes → fork recursion on the benchmark runner (load ≈ 80 for a few minutes).
   All processes were killed by exact PID, `build` now maps to `next build`, and `measure.mjs` has a 900 s build timeout. The `redirect-service` repo on this host is already Hono (not Next), so it was not used as a benchmark subject.
8. (v0.2) **React vs preact SSR**: the Worker-size numbers (gzip/raw, from the built file) are exact. The ssr-route latency/throughput rows are launcher-bound like every other Worker-handled
   route (floor ~15.5 ms, see caveat 1): 17.4 vs 17.2 ms p50 and 48 vs 57 req/s are single runs inside that noise and are **not** evidence that preact renders faster. Expected real-world gain is
   cold-start/parse time (smaller script), not steady-state render time; not measured here. The `cf-lite-ssr` layout does not import `Link`; separately, `examples/site` (layout with `Link`) measured 211 KiB gzip in the Worker before the v0.2 `mount`/`sideEffects` split and 111 KiB after (not in this table).

# Benchmark results

Host: Intel(R) Xeon(R) CPU E5-2696 v4 @ 2.20GHz x8, Node v24.21.0, 2026-09-30T04:59:31.439Z

| metric | cf-lite | cf-lite-wrangler | vinext | next-opennext | bare-vite | bare-wrangler | cf-lite-ssr | cf-lite-ssr-preact |
|---|---|---|---|---|---|---|---|---|
| status | ok | ok | ok | ok | ok | ok | ok | ok |
| install (s) | 11.8 | 7.6 | 20.4 | 25.9 | 10.8 | 10.8 | 12.5 | 12.9 |
| build median (s) [runs] | 4.2 [4.2, 4.1, 4.3] | 4.1 [4.0, 4.1, 4.1] | 6.8 [7.2, 6.8, 6.7] | 20.6 [20.6, 20.5, 20.6] | 1.8 [1.8, 1.8, 1.8] | 1.8 [1.8, 1.8, 1.8] | 4.2 [4.7, 4.2, 4.1] | 4.0 [4.6, 3.9, 4.0] |
| Worker code, gzip | 14.9 KiB | 14.9 KiB | 280.9 KiB | 907.8 KiB | 0.3 KiB | 0.3 KiB | 108.6 KiB | 29.0 KiB |
| Worker code, raw | 54.9 KiB | 54.9 KiB | 869.7 KiB | 4386.7 KiB | 0.5 KiB | 0.5 KiB | 536.2 KiB | 95.9 KiB |
| wrangler dry-run upload gzip | – | – | – | 914.57 KiB | – | – | – | – |
| content page: JS files / gzip | 0 / 0.0 KiB | 0 / 0.0 KiB | 5 / 133.3 KiB | 6 / 169.8 KiB | 0 / 0.0 KiB | 0 / 0.0 KiB | 0 / 0.0 KiB | 0 / 0.0 KiB |
| content page: HTML (raw) | 0.3 KiB | 0.3 KiB | 5.2 KiB | 5.1 KiB | 0.1 KiB | 0.1 KiB | 0.4 KiB | 0.4 KiB |
| redirect p50 / p95 / p99 (ms), c=1 | 3.357 / 4.507 / 8.436 (HTTP 302) | 4.002 / 5.388 / 9.053 (HTTP 302) | 19.448 / 24.236 / 34.242 (HTTP 307) | 16.921 / 19.156 / 29.526 (HTTP 307) | 15.91 / 19.629 / 29.785 (HTTP 302) | 15.584 / 16.563 / 24.965 (HTTP 302) | 3.368 / 4.421 / 8.416 (HTTP 302) | 3.33 / 4.456 / 7.469 (HTTP 302) |
| redirect req/s, c=16 | 471 | 569 | 57 | 58 | 64 | 64 | 495 | 513 |
| api p50 / p95 / p99 (ms), c=1 | 16.614 / 19.508 / 30.358 (HTTP 200) | 16.312 / 18.552 / 34.815 (HTTP 200) | 19.451 / 21.775 / 38.489 (HTTP 200) | 18.336 / 20.583 / 39.488 (HTTP 200) | 15.968 / 18.709 / 32.085 (HTTP 200) | 15.618 / 17.609 / 32.729 (HTTP 200) | 16.575 / 18.713 / 31.047 (HTTP 200) | 16.695 / 19.003 / 30.942 (HTTP 200) |
| api req/s, c=16 | 45 | 43 | 37 | 39 | 63 | 64 | 45 | 45 |
| content p50 / p95 / p99 (ms), c=1 | 3.59 / 4.514 / 8.93 (HTTP 200) | 4.54 / 5.6 / 9.613 (HTTP 200) | 19.481 / 21.856 / 40.292 (HTTP 200) | 49.744 / 57.323 / 68.471 (HTTP 200) | 15.965 / 18.175 / 30.578 (HTTP 200) | 15.653 / 16.696 / 31.866 (HTTP 200) | 3.563 / 4.241 / 9.832 (HTTP 200) | 3.629 / 4.147 / 9.107 (HTTP 200) |
| content req/s, c=16 | 489 | 418 | 38 | 38 | 63 | 63 | 471 | 460 |
| ssr p50 / p95 / p99 (ms), c=1 | – | – | – | – | – | – | 17.384 / 19.516 / 27.444 (HTTP 200) | 17.23 / 19.028 / 31.526 (HTTP 200) |
| ssr req/s, c=16 | – | – | – | – | – | – | 48 | 57 |

## p50 latency above the control floor (ms)

Variant p50 minus the p50 of the bare Worker (no framework, no Hono) served by the *same launcher* on the same route. **Negative = the request never entered the Worker** (assets layer answered it, faster than the floor). bare-vite = floor for cf-lite/vinext (`vite preview`); bare-wrangler = floor for cf-lite-wrangler/next-opennext (`wrangler dev`).

| variant | redirect | api | content |
|---|---|---|---|
| cf-lite | -12.6 | 0.6 | -12.4 |
| cf-lite-wrangler | -11.6 | 0.7 | -11.1 |
| vinext | 3.5 | 3.5 | 3.5 |
| next-opennext | 1.3 | 2.7 | 34.1 |

## SSR renderer: react vs preact (same app: layouts + head + SSR route)

| metric | react | preact | change |
|---|---|---|---|
| Worker code, gzip | 108.6 KiB | 29.0 KiB | 73% smaller |
| Worker code, raw | 536.2 KiB | 95.9 KiB | 82% smaller |
| build median (s) | 4.2 | 4.0 | |
| ssr route p50 / p99 (ms), c=1 | 17.384 / 27.444 | 17.23 / 31.526 | launcher floor ~15 ms applies |
| ssr route req/s, c=16 | 48 | 57 | |

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



## v0.3 addendum (2026-09-30): minified Worker, UI adapters

The tables above are the v0.2 run (unminified Worker, react bundled in core) and were **not re-run**. After 0.3 (Worker minified by default, UI framework moved into `@cf-lite/*` adapters)
a 1-run local `APPS="cf-lite cf-lite-ssr cf-lite-ssr-preact" RUNS=1 BENCH_REQS=300 BENCH_HOST=local bash bench/run.sh` gave these **exact byte counts** (latency from that run is not quoted: 300 requests, launcher-floor-bound, one run):

| Worker code | v0.2 gzip / raw | v0.3 gzip / raw |
|---|---|---|
| `cf-lite` (API + static, no SSR route) | 14.9 / 54.9 KiB | 7.2 / 17.8 KiB |
| `cf-lite-ssr` (react) | 108.6 / 536.2 KiB | 73.5 / 236.4 KiB |
| `cf-lite-ssr-preact` | 29.0 / 95.9 KiB | 17.5 / 48.2 KiB |

Preact is now `@cf-lite/preact` (native preact + `react`→`preact/compat` aliases through `@preact/preset-vite`, so it also gets HMR) instead of the alias-only mode. Per-adapter numbers for react/preact/vue/svelte: [`RESULTS-adapters.md`](RESULTS-adapters.md).

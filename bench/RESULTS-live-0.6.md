# Live benchmark re-run, cf-lite at current main (package 0.4.0, commit 4519d7a) — 2026-10-01

Re-run of `RESULTS-live.md` (first run, cf-lite **0.1.0**, 2026-09-30) with the same method on the same test Cloudflare account's `workers.dev`, one client (**client 1**, HKG colo for all 4650 measured requests),
plus one extra variant. Workers are `bench-bare`, `bench-cflite`, `bench-cflite-full`, `bench-vinext`, `bench-next`; **deleted after the run** with `live/teardown-v06.sh` (404 confirmed).
Scripts: `live/{build-v06.sh,deploy-v06.sh,run-v06.sh,warm-v06.py,cpu-v06.py,cpu-analytics-v06.sh,cold-v06.py,cold-run-v06.sh,analyze-v06.py,variants-v06.json,teardown-v06.sh}`, app `apps/cf-lite-full`, raw data `results-live/v06-*`.
Note: the repo's package version is **0.4.0** (the task called it "0.6"); there is no git tag, `main` @ `4519d7a` is what was packed (`npm pack -w cf-lite -w @cf-lite/react`).

| worker | what it is |
|---|---|
| `bench-cflite` | same 3-route app as 0.1.0 (`_redirects` + prerendered `/about/` on the assets layer, `/api/*` Worker-first Hono), cf-lite **current main** |
| `bench-cflite-full` | **new** — the same app as a "realistic" cf-lite app: `logging()` (request id + access line) + `security({preset:"strict"})` (+ `_headers` CSP for static pages, generated) + `session()` (sealed AES-GCM cookie) in `server/worker.ts`; `server/middleware.ts` gate on `/api/:path*` (401 for `/api/private/*` without a session cookie); `server/error.ts` -> `.onError`; wrangler `observability` enabled (head_sampling 1). Extra route `/api/visit` writes session state (seals a fresh cookie each call). Redirect and `/about/` still never reach the Worker. |
| `bench-vinext` / `bench-next` | rebuilt from the same installed deps as the 0.1.0 run (vinext 1.0.0, Next 16.3.7 + opennext 1.20.7) |
| `bench-bare` | control, 10-line Worker |

## Headline
1. **Worker size** (gzip): cf-lite **7.4 KiB** (was 14.9 KiB at 0.1.0; raw 17.8 KiB vs 54.9), **full app 12.0 KiB** (+4.7 KiB for gate + sessions + security headers + logging/error handler), vinext 280 KiB, Next 914.6 KiB upload. bare 0.3 KiB.
2. **Warm latency, delta over bare p50** (client 1, interleaved, n=300): cflite redirect/api/content **-0.5 / +0.1 / +4.6 ms** (0.1.0: +0.2 / +0.6 / +8.1); **full -> +0.4 / +1.4 / +5.5**; session-writing route `/api/visit` +1.5 ms. So the modules cost **~1.3 ms p50 on API requests, 0 on redirect/static** (they do not enter the Worker; the static page gets its security headers from `_headers`). vinext +2.0 / +3.8 / +4.0, Next +1.5 / +4.6 / +16.9.
3. **Worker CPU p50** (analytics, bursts of 150): cflite api **0.33 ms** (0.1.0: 0.28), **full api 0.54 ms** (+0.2 ms for the module stack; `/api/visit` 0.43 — below the plain api route, i.e. the difference between those two is noise-level), redirect/static **0 invocations** for both. vinext 0.82 / 2.54 / 1.67, Next 0.73 / 2.40 / **7.50** ms (content p99 62 ms). CPU p99 of cflite/full api (1.8 / 2.2 ms) is dominated by a few outliers over 150 samples.
4. **Cold start after a fresh deploy** (first − second request, n = 5, client 1): bare +2, **cflite +22 (0.1.0: +21), full +24**, vinext +85 (+97), Next +289 (+261). The module stack adds ~2 ms on first request, within noise, i.e. a 12 KiB Worker cold-starts like a 7 KiB one; heavy frameworks are still 4–13x worse.
5. **Build time** (`npm run build`, no cache, deps installed, a build machine, 3 runs; vinext/Next 1 run): cflite **2.7 s median** (0.1.0: 4.2), full 2.7 s, bare 1.7 s, vinext 6.6 s, Next 21.3 s. Both cf-lite builds are *faster* than at 0.1.0 (was 4.2 s) — not investigated why.
6. What did **not** change from the 0.1.0 conclusions: cf-lite ties bare on redirect/api, and its prerendered `/about/` still costs +4.6…+5.5 ms over a Worker-returned string (asset read hypothesis unchanged; smaller than the +7…+8 ms seen at 0.1.0, one day apart, single client — treat the difference as noise-level, not an improvement).

## Comparison with the 0.1.0 live run (client 1, HKG)

| metric | cf-lite 0.1.0 | cf-lite main (0.4.0) | cf-lite-full main | vinext | next |
|---|---|---|---|---|---|
| Worker gzip | 14.9 KiB | **7.4 KiB** (wrangler upload 7.25) | **12.0 KiB** (11.99) | 280 KiB (0.1.0 run: 280.9) | 914.6 KiB upload |
| Worker raw | 54.9 KiB | 17.8 KiB | 30.2 KiB | 869.7 KiB | 4386.7 KiB |
| build s (median) | 4.2 | 2.7 | 2.7 | 6.6 (n=1) | 21.3 (n=1) |
| warm p50 delta vs bare: redirect | +0.2 | -0.5 | +0.4 | +2.0 | +1.5 |
| warm p50 delta: api | +0.6 | +0.1 | +1.4 | +3.8 | +4.6 |
| warm p50 delta: content | +8.1 | +4.6 | +5.5 | +4.0 | +16.9 |
| CPU p50 api (ms) | 0.28 | 0.33 | 0.54 | 2.54 (0.1.0 run: 3.57) | 2.40 (2.98) |
| CPU p50 content (ms) | 0 invocations | 0 invocations | 0 invocations | 1.67 (1.94) | 7.50 (9.63) |
| cold start first−second (deploy, n=5) | +21 | +22 | +24 | +85 (+97) | +289 (+261) |

0.1.0 numbers are client 1 / first-run cells of `RESULTS-live.md` (warm2 delta table, CPU table, cold deploy table); size/build numbers from `RESULTS.md` (local run on a build machine). vinext/Next values in parentheses are from the 0.1.0 run; their different values today are run-to-run / day-to-day variation (same artifacts) and tell you how large "noise" is on this setup: **~±20-30 % on CPU, ±1 ms on warm deltas, ±30 ms on cold deltas.**

## Methodology (differences from RESULTS-live.md)
* Same as the v0.3 addendum (`warm-v06.py` = `warm-v03.py` with the new variant list): c=1 keep-alive, variants x routes interleaved, reconnect every 10 rounds, 10 warm-up rounds then **300 samples per cell**, first request of each fresh connection dropped from the `redirect` cells, single client **client 1**; CPU = one minute-aligned burst of 150 per (variant, route) read from `workersInvocationsAdaptive`; cold = 5 redeploys per variant (`--message cold-N`), probe immediately.
* **Not repeated:** the ≥16-min *idle* cold rounds (time box), the four extra client hosts, and the first run's second warm run. Single day, single client, single colo.
* Builds on a build machine (8 vCPU, idle, load ≤ 1.8 after every build) by `live/build-v06.sh`: `timeout -k 10 900` per build and the 1-min-load > 40 guard (never triggered). cf-lite from freshly built + `npm pack`ed tarballs of this checkout; vinext/Next/bare from the existing `bench/work` dirs (deps unchanged since 0.1.0). Build time = wall time of `npm run build` (`cf-lite build`) / `opennextjs-cloudflare build`, outputs deleted between runs; install time not included.
* Realistic variant details: the strict security preset is applied both ways (generated `_headers` for static pages, `security()` middleware for Worker responses; `x-content-type-options`, CSP etc. verified with `curl -I` on `/api/hello` and `/about/`). `SESSION_SECRETS` is a throwaway random value generated at build time (never printed, not committed). The gate allows `/api/hello` through (it only rejects `/api/private/*`), so the api route measures the full middleware path without a rejection. Logging writes one JSON line per request (observability sampling 1.0) — its cost is included in CPU/latency.
* Content path: `/about/` for cf-lite variants (assets layer 307s `/about` -> `/about/`), `/about` for the others; redirect status 302 (cf-lite, bare) vs 307.

## Caveats
1. One client, one colo (HKG), one day. Deltas below ~1.5 ms and CPU differences below ~0.15 ms are inside the noise (`/api/visit` CPU 0.43 < `/api/hello` CPU 0.54 on the same Worker shows it).
2. The 300-sample p99 is ≈ the 3 worst requests; indicative only.
3. Cold start n = 5, deploy-only; the vinext probe set has a 37 ms first request (probably an already-warm isolate), median 117 ms. Whether Cloudflare had a warm isolate elsewhere is not observable.
4. vinext/Next build time n = 1 (they are only controls here). Node 24.21, same host as the 0.1.0 local bench.
5. Not the same capability: the cf-lite content page is prerendered with zero JS; vinext/Next ship a React client runtime. cf-lite here has no SSR route (an SSR route adds react-dom/server, see `RESULTS-live.md` v0.3 addendum: 17–74 KiB).
6. `bench-cflite-full` reaches the gate only for `/api/*`; gating more paths (`matcher` including pages) would move those routes from "0 invocations" to Worker-served — that is the real cost knob, not the module bytes.

## State left behind
None: the five bench workers were deleted (all 404). No custom domains / DNS. Re-run: `live/build-v06.sh` on the build host, rsync outputs to `~/cf-lite-live`, `live/deploy-v06.sh <variant>` x5, `live/run-v06.sh`.

## Data (generated by `python3 bench/live/analyze-v06.py`)

### Warm TTFB (ms), probing client, p50 / p95 / p99 (colos: {'HKG': 4650})

| variant | redirect | api | content | session |
|---|---|---|---|---|
| bare | 28.4 / 33.1 / 34.9 (n=270, HTTP 302, err 0) | 28.3 / 32.5 / 35.7 (n=300, HTTP 200, err 0) | 28.7 / 33.5 / 36.7 (n=300, HTTP 200, err 0) | – |
| cflite | 27.9 / 32.2 / 36.7 (n=270, HTTP 302, err 0) | 28.4 / 33.6 / 44.0 (n=300, HTTP 200, err 0) | 33.4 / 40.7 / 46.0 (n=300, HTTP 200, err 0) | – |
| full | 28.9 / 33.5 / 38.5 (n=270, HTTP 302, err 0) | 29.7 / 34.8 / 44.5 (n=300, HTTP 200, err 0) | 34.2 / 41.8 / 52.8 (n=300, HTTP 200, err 0) | 29.8 / 34.6 / 38.2 (n=300, HTTP 200, err 0) |
| vinext | 30.5 / 36.2 / 42.7 (n=270, HTTP 307, err 0) | 32.1 / 40.2 / 50.7 (n=300, HTTP 200, err 0) | 32.7 / 40.5 / 94.8 (n=300, HTTP 200, err 0) | – |
| next | 29.9 / 35.5 / 39.0 (n=270, HTTP 307, err 0) | 32.9 / 39.8 / 115.3 (n=300, HTTP 200, err 0) | 45.6 / 57.6 / 149.2 (n=300, HTTP 200, err 0) | – |

### Delta over `bare` control, p50 (ms) (session row vs bare `api`)

| variant | redirect | api | content | session |
|---|---|---|---|---|
| cflite | -0.5 | +0.1 | +4.6 | – |
| full | +0.4 | +1.4 | +5.5 | +1.5 |
| vinext | +2.0 | +3.8 | +4.0 | – |
| next | +1.5 | +4.6 | +16.9 | – |

### Cold start after fresh deploy: first `/api/hello` on a new connection vs immediate 2nd request (ms TTFB)

| variant | n | first median [min..max] | second median | first-second median | colos |
|---|---|---|---|---|---|
| bare | 5 | 34 [29..37] | 31 | +2 | {'HKG': 5} |
| cflite | 5 | 49 [41..56] | 29 | +22 | {'HKG': 5} |
| full | 5 | 55 [47..63] | 31 | +24 | {'HKG': 5} |
| vinext | 5 | 117 [37..141] | 32 | +85 | {'HKG': 5} |
| next | 5 | 326 [241..370] | 38 | +289 | {'HKG': 5} |

First-request TTFB / second-request TTFB per probe (ms), in order:

- bare: 37/35, 29/28, 30/28, 34/31, 35/31
- cflite: 49/27, 56/33, 54/30, 41/28, 47/29
- full: 47/31, 57/33, 55/31, 63/33, 49/28
- vinext: 100/31, 37/32, 117/31, 141/42, 138/35
- next: 337/38, 370/37, 268/32, 326/38, 241/39

### Worker CPU time per request (Workers analytics, one minute-aligned burst per cell from the probing client)

| variant | route | requests sent | Worker invocations | CPU p50 (ms) | CPU p99 (ms) | wall p50 (ms) |
|---|---|---|---|---|---|---|
| bare | redirect | 150 | 150 | 0.14 | 0.27 | 0.26 |
| bare | api | 150 | 150 | 0.27 | 0.36 | 0.54 |
| bare | content | 150 | 150 | 0.28 | 0.38 | 0.48 |
| cflite | redirect | 150 | 0 (no Worker invocation row) | – | – | – |
| cflite | api | 150 | 150 | 0.33 | 1.78 | 0.56 |
| cflite | content | 150 | 0 (no Worker invocation row) | – | – | – |
| full | redirect | 150 | 0 (no Worker invocation row) | – | – | – |
| full | api | 150 | 150 | 0.54 | 2.19 | 0.94 |
| full | content | 150 | 0 (no Worker invocation row) | – | – | – |
| full | session | 150 | 149 | 0.43 | 2.26 | 0.72 |
| vinext | redirect | 150 | 150 | 0.82 | 2.11 | 1.04 |
| vinext | api | 150 | 140 | 2.54 | 6.12 | 3.10 |
| vinext | content | 150 | 150 | 1.67 | 3.81 | 2.01 |
| next | redirect | 150 | 150 | 0.73 | 3.24 | 1.02 |
| next | api | 150 | 150 | 2.40 | 6.22 | 2.66 |
| next | content | 150 | 150 | 7.50 | 62.00 | 7.99 |

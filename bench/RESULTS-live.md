# Live benchmark (real network, workers.dev) — 2026-09-30

Same three-route app as `RESULTS.md` (redirect `/go/github`, JSON `/api/hello`, content page `/about`) deployed as four real Workers on a test
Cloudflare account's `workers.dev` and measured from five client hosts. **The four workers were deleted after the run** (`live/teardown.sh`); scripts, raw JSONL and the schedule are kept so it can be re-run.

| worker | what it is | Worker code (gz) |
|---|---|---|
| `bench-cflite` | cf-lite app (`_redirects` + prerendered `/about/` served by the assets layer, `/api/*` run_worker_first, Hono) — cf-lite 0.1.0 as installed in the earlier local bench | 14.9 KiB |
| `bench-vinext` | vinext 1.0.0 (`cf deploy --prebuilt`) | 280.9 KiB |
| `bench-next` | Next 16.3.7 + `@opennextjs/cloudflare` 1.20.7 (`wrangler deploy`) | 914.6 KiB upload |
| `bench-bare` | control: 10-line Worker, no framework, no assets, all three routes answered by the Worker | 0.3 KiB |

Content route paths: `/about/` for cf-lite (the assets layer 307s `/about` → `/about/`), `/about` for the others. Redirect status: 302 (cf-lite, bare) vs 307 (vinext, Next) as in the local bench.

## Headline (read the caveats below before quoting)

1. **`bench-bare` is the floor** — every cell is reported as a delta over it, so client↔edge RTT (27–33 ms from the HKG-routed hosts) cancels. Four hosts that all reach the **HKG** colo agree with each other to ~1–2 ms (table "Delta over bare", warm2).
2. **Redirect / API (p50 over bare):** cf-lite ≈ **0 to +0.7 ms** (redirect never enters the Worker; `/api` is Hono in a 15 KiB Worker); vinext **+2.4…+4.1 / +4.6…+5.5 ms**; Next **+1.3…+3.1 / +4.5…+6.0 ms**.
3. **Content page — cf-lite is NOT the fastest on the real network.** cf-lite's prerendered asset `/about/` costs **+7…+8 ms** over bare, vinext **+4.5…+5.9**, Next **+16.7…+17.8** (+ fat tail: Next content p99 155–260 ms vs ≈ 60–100 ms for the rest). The local bench's "−12 ms for cf-lite" was the local launcher's floor, exactly as RESULTS.md caveat 1/2 warned; it does not reproduce in production. Hypothesis for the +7 ms (not verified): the redirect is answered from the assets *manifest* while `/about/` has to read the asset body from storage (note the two cf-lite routes differ by ≈ 8 ms while both skip the Worker).
4. **Worker CPU (Workers analytics, per-route burst):** cf-lite `/api` **0.28 ms** p50 (≈ bare 0.22), and **0 Worker invocations** for redirect and content (200/200 answered by assets — no CPU, no Workers request billed). vinext 1.0 / 3.6 / 1.9 ms p50 (redirect/api/content); Next 0.65 / 3.0 / **9.6 ms** p50 (content p99 98.8 ms).
5. **Cold start** (first request on a fresh connection to a freshly deployed / ≥16-min-idle Worker, api route, TTFB minus the immediate second request on the same connection): bare **+5 ms** (this is the new-connection effect, not a cold start), cf-lite **+21 (deploy) / +25 (idle) ms**, vinext **+97 / +119 ms**, Next **+261 / +357 ms** (single probes up to 657 ms). n = 5 per cell.
   Every idle/deploy probe of cf-lite, vinext and Next was clearly slower than its own second request, so all probes looked cold (whether Cloudflare had a warm isolate elsewhere in the colo is not observable from the client); bare's gap stayed at the new-connection level.

**Bottom line:** in production the cf-lite advantage is **not raw latency on a warm path** (it ties bare on redirect/API, and is a few ms *behind* vinext on a static content page) — it is **(a) zero Worker CPU/invocations for redirects and static pages, (b) ≈ 10× lower CPU on the dynamic API path than the heavy frameworks (0.28 vs 3.0–3.6 ms p50), and (c) cold starts ≈ 5–14× smaller** (≈ +20 ms vs +100–120 / +260–360 ms) because the Worker is 15 KiB instead of 280–910 KiB.

## Methodology

* **Build** on a build machine (8 vCPU, idle) with `live/build-remote.sh`: `timeout -k 10 900` per build and a load guard (aborts the build if 1-min load > 40; observed load after each build ≤ 1.8, no fork recursion — `build` for Next maps to `next build`, OpenNext is invoked once via `npx opennextjs-cloudflare build`). Output rsynced to client 1, deployed with `wrangler deploy` (`--name bench-…`) / `deploy --prebuilt` (vinext's `cf` CLI) through thin wrappers. No new tokens, no custom domains, no DNS change.
* **Clients** (each reached over SSH): client 1, client 2, client 3, client 4 (all HKG colo), client 5 (a cloud VM; colo varies per connection: HKG/SIN/NRT/KIX). `live/warm.py` (python3 stdlib `http.client`, HTTPS/HTTP 1.1 keep-alive): c = 1, 50 ms sleep between requests, variants × routes interleaved round-robin in time (drift hits all variants equally), 10 warm-up rounds then **300 measured requests per (host, variant, route)**. TTFB = request sent → response headers received. No cache busting: the workers.dev edge cache is not involved (Workers/assets responses, `cf-cache-status` absent).
* **Two warm runs.** `warm` = one connection per variant for the whole run. `warm2` (**primary**) = drop and re-open every variant's connection every 10 rounds (30 connections per variant) — the first run showed per-connection placement (a given connection can sit on a slower edge server/path) producing consistent ±5–10 ms offsets for one variant on one host (e.g. cf-lite +8.8 ms on client 3 in run 1, −0.6 ms in run 2), and on client 5 a whole connection on SIN/KIX (bare stuck at 91 ms vs others 13–53 ms). The first request on each fresh connection (TCP+TLS inside the timer; `http.client` connects lazily) is excluded from `warm2` redirect cells (n = 270); in `warm` it only occurs once in warm-up.
* **Cold start** (`live/cold-run.sh`, client 1 only — probing from several hosts would warm the same colo): *fresh deploy*: 5 × per variant `deploy (new version, --message cold-N)` then immediately probe; *idle*: 5 rounds, each after ≥ 16 min (960 s sleep) with zero traffic to any bench worker, all four variants probed back-to-back. A probe opens a new connection (connect+TLS not timed), sends `/api/hello` (first request = cold candidate), then an immediate second `/api/hello` on the same connection (warm reference), then redirect and content. The "cold cost" is first − second; `bare` shows what a no-op Worker gives under the same procedure (≈ +5 ms, new-connection effect).
* **Worker CPU** (`live/cpu-run.py` + `live/cpu-analytics.sh`): Workers GraphQL `workersInvocationsAdaptive` has no route dimension, so every (variant, route) got its own 200-request burst inside one wall-clock minute and CPU quantiles are read per `datetimeMinute`. `wrangler tail` was not used (no CPU field in its events, and it only samples). The API returns `scriptName: __unknown__`; bursts were mapped by minute via `results-live/cpu-schedule.json`. Units in the API are µs. Numbers are from sampled adaptive data (`sum.requests` ≈ 198–200 of 200 sent).

## Caveats

1. **Single day, single account, single region.** Four of five clients are in one region and land on HKG; results are for that colo and an unloaded account on `workers.dev`. No claim about other colos or about paid-plan/custom-domain routing.
2. **client 5 is not comparable across variants.** Each variant's connection may land on a different colo (run 1: 1800 of 3600 requests SIN, 900 HKG, 900 KIX), so its per-variant absolute numbers and deltas mostly measure routing, not the workers. It is kept in the raw data and tables for completeness; conclusions above use the four HKG hosts only.
3. **Inter-host agreement is ~1–2 ms on medians but p95/p99 differ** (other tenants on the VMs, shared uplinks). The 300-sample p99 of each cell is ≈ the 3 worst requests — treat p99 as indicative.
4. **Cold starts: n = 5 per cell from one client** — enough to show order of magnitude (20 / 100 / 300 ms), not a distribution. Cloudflare may serve the first request from any isolate already running in that colo; we cannot observe that directly. The second request after a cold one is sometimes also slow (deploy-1 vinext 128 ms, deploy-2 next 470 ms), i.e. cold cost can span two requests (multiple isolates / version rollout) and `first − second` under-counts those.
5. **Not the same capability** (same as RESULTS.md caveat 3): the cf-lite content page is prerendered, zero JS; vinext/Next pages ship a React client runtime and are served through a Worker. cf-lite here has no SSR route.
6. cf-lite in this bench is the 0.1.0 tarball installed into `bench/work/cf-lite` by the earlier local run (the repo has since moved to 0.2.x); the Worker is identical in size (14.96 KiB gz uploaded).
7. **Routine hygiene:** exact PIDs only were started/killed by this session; no process of others touched. Workers deleted afterwards (404 confirmed).


## Raw tables (warm2, primary)

#### Warm TTFB (ms) p50 / p95 / p99, n per cell, keep-alive, c=1

**client 5** (colos: {'HKG': 1334, 'NRT': 899, 'SIN': 1247})

| variant | redirect | api | content |
|---|---|---|---|
| bare | 37.5 / 83.7 / 89.3 (n=270, HTTP 302, err 0) | 36.9 / 83.8 / 88.9 (n=300, HTTP 200, err 0) | 37.9 / 84.7 / 94.9 (n=300, HTTP 200, err 0) |
| cflite | 44.1 / 86.8 / 96.4 (n=270, HTTP 302, err 0) | 46.0 / 88.1 / 104.2 (n=300, HTTP 200, err 0) | 53.3 / 96.9 / 108.1 (n=300, HTTP 200, err 0) |
| vinext | 50.4 / 93.9 / 101.7 (n=270, HTTP 307, err 0) | 53.8 / 100.8 / 118.0 (n=300, HTTP 200, err 0) | 55.1 / 106.1 / 194.5 (n=300, HTTP 200, err 0) |
| next | 44.8 / 89.0 / 97.1 (n=270, HTTP 307, err 0) | 49.0 / 119.3 / 296.3 (n=300, HTTP 200, err 0) | 63.4 / 128.2 / 264.2 (n=300, HTTP 200, err 0) |

**client 1** (colos: {'HKG': 3480})

| variant | redirect | api | content |
|---|---|---|---|
| bare | 31.6 / 43.0 / 67.4 (n=270, HTTP 302, err 0) | 31.5 / 41.9 / 64.2 (n=300, HTTP 200, err 0) | 31.8 / 42.5 / 67.2 (n=300, HTTP 200, err 0) |
| cflite | 31.8 / 40.0 / 54.4 (n=270, HTTP 302, err 0) | 32.2 / 41.6 / 53.3 (n=300, HTTP 200, err 0) | 39.9 / 53.0 / 73.8 (n=300, HTTP 200, err 0) |
| vinext | 33.7 / 42.3 / 47.4 (n=270, HTTP 307, err 0) | 36.1 / 46.6 / 65.5 (n=300, HTTP 200, err 0) | 36.7 / 48.4 / 85.5 (n=300, HTTP 200, err 0) |
| next | 32.8 / 43.0 / 160.9 (n=270, HTTP 307, err 0) | 36.0 / 48.1 / 232.3 (n=300, HTTP 200, err 0) | 48.5 / 80.6 / 154.4 (n=300, HTTP 200, err 0) |

**client 2** (colos: {'HKG': 3480})

| variant | redirect | api | content |
|---|---|---|---|
| bare | 30.1 / 37.5 / 45.1 (n=270, HTTP 302, err 0) | 30.1 / 36.1 / 52.9 (n=300, HTTP 200, err 0) | 30.4 / 38.0 / 46.5 (n=300, HTTP 200, err 0) |
| cflite | 29.8 / 40.0 / 49.4 (n=270, HTTP 302, err 0) | 30.8 / 40.8 / 48.0 (n=300, HTTP 200, err 0) | 38.1 / 53.2 / 61.5 (n=300, HTTP 200, err 0) |
| vinext | 34.0 / 45.4 / 55.3 (n=270, HTTP 307, err 0) | 35.7 / 45.7 / 72.9 (n=300, HTTP 200, err 0) | 36.2 / 46.1 / 58.5 (n=300, HTTP 200, err 0) |
| next | 33.0 / 43.3 / 166.7 (n=270, HTTP 307, err 0) | 36.2 / 49.3 / 219.3 (n=300, HTTP 200, err 0) | 48.0 / 72.8 / 259.6 (n=300, HTTP 200, err 0) |

**client 3** (colos: {'HKG': 3480})

| variant | redirect | api | content |
|---|---|---|---|
| bare | 31.0 / 38.3 / 40.4 (n=270, HTTP 302, err 0) | 30.8 / 39.1 / 43.6 (n=300, HTTP 200, err 0) | 31.5 / 39.2 / 44.7 (n=300, HTTP 200, err 0) |
| cflite | 30.4 / 37.6 / 43.3 (n=270, HTTP 302, err 0) | 31.1 / 38.6 / 44.0 (n=300, HTTP 200, err 0) | 38.6 / 51.1 / 69.0 (n=300, HTTP 200, err 0) |
| vinext | 33.8 / 45.5 / 54.2 (n=270, HTTP 307, err 0) | 36.1 / 46.9 / 60.3 (n=300, HTTP 200, err 0) | 36.0 / 46.4 / 95.8 (n=300, HTTP 200, err 0) |
| next | 33.2 / 42.9 / 202.4 (n=270, HTTP 307, err 0) | 36.6 / 56.1 / 285.1 (n=300, HTTP 200, err 0) | 49.0 / 71.5 / 179.9 (n=300, HTTP 200, err 0) |

**client 4** (colos: {'HKG': 3480})

| variant | redirect | api | content |
|---|---|---|---|
| bare | 30.9 / 38.8 / 44.3 (n=270, HTTP 302, err 0) | 31.0 / 38.5 / 47.9 (n=300, HTTP 200, err 0) | 31.2 / 38.9 / 42.6 (n=300, HTTP 200, err 0) |
| cflite | 29.9 / 39.4 / 47.5 (n=270, HTTP 302, err 0) | 31.4 / 40.9 / 53.8 (n=300, HTTP 200, err 0) | 38.5 / 57.6 / 105.9 (n=300, HTTP 200, err 0) |
| vinext | 34.0 / 44.2 / 50.6 (n=270, HTTP 307, err 0) | 35.8 / 48.0 / 63.6 (n=300, HTTP 200, err 0) | 36.5 / 47.0 / 65.3 (n=300, HTTP 200, err 0) |
| next | 33.3 / 44.7 / 56.3 (n=270, HTTP 307, err 0) | 36.7 / 52.7 / 292.7 (n=300, HTTP 200, err 0) | 49.0 / 69.5 / 187.2 (n=300, HTTP 200, err 0) |

#### Delta over `bare` control, p50 (ms), per host (network RTT cancels)

| host | variant | redirect | api | content |
|---|---|---|---|---|
| client 5 | cflite | +6.6 | +9.1 | +15.4 |
| client 5 | vinext | +13.0 | +16.9 | +17.2 |
| client 5 | next | +7.4 | +12.1 | +25.5 |
| client 1 | cflite | +0.2 | +0.6 | +8.1 |
| client 1 | vinext | +2.1 | +4.6 | +4.9 |
| client 1 | next | +1.2 | +4.5 | +16.7 |
| client 2 | cflite | -0.3 | +0.7 | +7.7 |
| client 2 | vinext | +3.9 | +5.5 | +5.9 |
| client 2 | next | +2.9 | +6.0 | +17.6 |
| client 3 | cflite | -0.5 | +0.2 | +7.1 |
| client 3 | vinext | +2.8 | +5.3 | +4.5 |
| client 3 | next | +2.2 | +5.8 | +17.5 |
| client 4 | cflite | -1.0 | +0.4 | +7.3 |
| client 4 | vinext | +3.0 | +4.8 | +5.3 |
| client 4 | next | +2.4 | +5.7 | +17.8 |

#### Cold start: first api request on a new connection vs immediate 2nd request on same connection (ms TTFB)

**deploy** (n probes per variant; first / second / first-second; connect+TLS median)

| variant | n | first median [min..max] | second median | first−second median | colos |
|---|---|---|---|---|---|
| bare | 5 | 33 [31..49] | 30 | +5 | {'HKG': 5} |
| cflite | 5 | 56 [48..70] | 34 | +21 | {'HKG': 5} |
| vinext | 5 | 138 [125..176] | 37 | +97 | {'HKG': 5} |
| next | 5 | 299 [280..542] | 42 | +261 | {'HKG': 5} |

**idle** (n probes per variant; first / second / first-second; connect+TLS median)

| variant | n | first median [min..max] | second median | first−second median | colos |
|---|---|---|---|---|---|
| bare | 5 | 33 [27..64] | 27 | +5 | {'HKG': 5} |
| cflite | 5 | 56 [48..141] | 33 | +25 | {'HKG': 5} |
| vinext | 5 | 156 [118..189] | 37 | +119 | {'HKG': 5} |
| next | 5 | 395 [281..657] | 38 | +357 | {'HKG': 5} |

Raw per-probe first-request TTFB (ms):

- deploy/bare: 49/33, 33/28, 46/28, 31/31, 33/30
- deploy/cflite: 56/35, 48/30, 53/32, 70/34, 60/34
- deploy/vinext: 138/128, 176/37, 172/37, 125/41, 133/36
- deploy/next: 299/37, 510/470, 542/46, 280/42, 298/35
- idle/bare: 33/27, 33/28, 64/29, 27/26, 31/27
- idle/cflite: 52/33, 48/29, 77/44, 56/32, 141/37
- idle/vinext: 189/45, 118/33, 156/37, 124/39, 157/34
- idle/next: 292/38, 281/37, 657/45, 395/38, 475/38

#### Worker CPU time per request (Workers analytics GraphQL, one minute-aligned burst of 200 requests per cell, from client 1)

| variant | route | Worker invocations / 200 | CPU p50 (ms) | CPU p99 (ms) | wall p50 (ms) |
|---|---|---|---|---|---|
| bare | redirect | 200 | 0.36 | 0.55 | 0.72 |
| bare | api | 189 | 0.22 | 0.64 | 0.42 |
| bare | content | 200 | 0.46 | 0.81 | 0.80 |
| cflite | redirect | 0 (no Worker invocation row) | – | – | – |
| cflite | api | 200 | 0.28 | 0.57 | 0.49 |
| cflite | content | 0 (no Worker invocation row) | – | – | – |
| vinext | redirect | 198 | 1.05 | 4.47 | 1.43 |
| vinext | api | 200 | 3.57 | 11.57 | 4.41 |
| vinext | content | 200 | 1.94 | 5.62 | 2.38 |
| next | redirect | 200 | 0.65 | 3.63 | 0.86 |
| next | api | 200 | 2.98 | 9.52 | 3.39 |
| next | content | 199 | 9.63 | 98.85 | 10.18 |


## Appendix: run 1 (single connection per variant) — delta over bare

Shows the per-connection placement noise (compare with warm2 above; e.g. client 3 cf-lite). Raw data is not kept in the repository ([live/README.md](live/README.md)).

#### Delta over `bare` control, p50 (ms), per host (network RTT cancels)

| host | variant | redirect | api | content |
|---|---|---|---|---|
| client 5 | cflite | -78.0 | -76.3 | -68.0 |
| client 5 | vinext | -38.7 | -36.2 | -35.1 |
| client 5 | next | -78.3 | -76.2 | -65.1 |
| client 1 | cflite | -1.3 | +1.0 | +7.4 |
| client 1 | vinext | +5.8 | +8.8 | +9.1 |
| client 1 | next | +9.1 | +13.0 | +30.3 |
| client 2 | cflite | -2.5 | -0.8 | +5.8 |
| client 2 | vinext | -0.8 | +0.6 | +1.0 |
| client 2 | next | +1.1 | +4.5 | +15.6 |
| client 3 | cflite | +8.8 | +11.1 | +22.2 |
| client 3 | vinext | +6.4 | +7.8 | +8.1 |
| client 3 | next | +5.4 | +7.9 | +16.9 |
| client 4 | cflite | +2.7 | +4.7 | +14.1 |
| client 4 | vinext | +4.7 | +6.2 | +7.0 |
| client 4 | next | +6.8 | +10.2 | +21.9 |


## Files

`live/{warm.py,cold.py,cold-run.sh,cpu-run.py,cpu-analytics.sh,analyze.py,variants.json,build-remote.sh,deploy.sh,teardown.sh}` · raw dumps (per-request samples, not kept in the repository; see [live/README.md](live/README.md)). Regenerate tables: `python3 bench/live/analyze.py warm2`.


---

# v0.3 addendum — demo + one site per UI adapter (live, 2026-09-30)

cf-lite **0.3.0** deployed with `cf-lite deploy` (`--name cflite-site-<ui>` for the four `examples/site*` apps, `cf-lite-demo` for `examples/demo`) on the same
test account's `workers.dev`; `bench-bare` (same 10-line control Worker as above, redeployed) is the floor. Method, clients and statistics are identical to the section above
(`live/warm-v03.py`: c = 1, keep-alive, interleaved, reconnect every 10 rounds, 300 samples/cell; `live/cpu-v03.py` + `live/cpu-analytics-v03.sh`: one minute-aligned burst of 150 per cell;
`live/cold-v03.py` + `live/cold-run-v03.sh`). **Differences from the first run:** one client only (**client 1**, HKG colo; the other hosts were not repeated), routes are
`redirect` (`/go/github`, demo + bare only - the site apps have no `_redirects`), `api` (`/api/hello`), `static` (`/about/`, prerendered, zero JS) and `ssr`
(`/posts/1` demo, `/blog/hello` sites; bare answers a fixed HTML string for every non-redirect, non-api path), cold start = **fresh deploy only, n = 5** (the ≥16-min idle rounds were not repeated).
vinext/Next were **not** re-measured; numbers for them are in the section above.

## Verified live before measuring
All five returned the expected results (`curl`): pages `/`, `/about/`, `/app/dashboard/` 200; SSR `/blog/hello` 200 with the loader-derived `<title>hello — site blog</title>` in the
streamed HTML (demo `/posts/1` 200); `/api/hello` 200 JSON; unknown navigation path 404 (SPA fallback shell); demo `/go/github` 302 -> github, `/old-about` 301 -> `/about`.
(Site apps have no redirect route; redirect is demo-only.) Worker upload gzip: demo 74.1, react 74.2, preact 18.5, vue 37.9, svelte 17.2 KiB.

## Headline (n and caveats below)
1. **Warm path:** `api` is within ±1.1 ms of the bare Worker for every adapter (react +1.1, preact +0.4, vue −0.7, svelte +0.9, demo +0.9) — the UI choice costs nothing on API requests; demo `redirect` +0.2.
2. **Static page (`/about/`, asset, zero Worker)** is **+6…+10 ms** over bare (vue +6.2, demo +7.3, preact/svelte +8.5/+8.7, react +10.0) — the same offset as cf-lite 0.1 in the first run (+7…+8); still unexplained (hypothesis unchanged: asset body read vs. Worker string), and differences between adapters here are within run-to-run noise (same static asset shape in all five).
3. **SSR route:** +1.6…+2.9 ms p50 over bare's trivial string response (svelte +1.6, preact +1.9, demo +2.2, vue +2.5, react +2.9). Worker CPU p50 **0.88 ms (preact) / 1.15 (react) / 1.13 (demo) / 1.27 (svelte) / 1.90 (vue)**, p99 3.5–5.6 ms. For reference from the first run, Next's content page was 9.6 ms p50 CPU; vinext's 1.9 ms — not re-measured today and not the same page, so treat as context, not a same-day comparison.
4. **Worker CPU, non-SSR:** `redirect` and `static` routes: **0 Worker invocations** for every cf-lite site (answered by the assets layer). `api`: 0.27–0.53 ms p50 (bare 0.22).
5. **Cold start after a fresh deploy (first − second request, n = 5):** bare +6 ms, **svelte +27, preact +29, vue +34, react +38, demo +45** (demo includes a 434 ms outlier probe: 434/165 ms; median unaffected). The cold cost grows with Worker size (17 → 74 KiB gz), as hypothesised, but is **higher than the +21 ms measured for the 0.1 API-only Worker (14.9 KiB)** — SSR adapters and the demo's Durable Object binding make the Worker larger/more complex than that app. Still well below the +97 (vinext) / +261 ms (Next) measured in the first run (not repeated today).

## Caveats specific to this run
* **One client (client 1, HKG), one day, one account.** No cross-host agreement check this time; the first run's ~1–2 ms inter-host agreement on medians is the only evidence of that.
* **Cold start: n = 5, fresh-deploy only.** One deploy failed during the run (`vue` deploy-3, `wrangler` error), so that probe hit an previous version (76/35 ms) — the vue row is effectively n = 4 fresh + 1 not-fresh. An earlier attempt at the cold phase was discarded because `wrangler` was not on PATH for the example directories (only the bare control deployed; all others were probed without a new deploy) — the numbers here are from the re-run.
* **`static` and `ssr` are not like-for-like with bare** (bare answers a fixed string from the Worker for both); the deltas measure "asset read" and "SSR render + streaming" vs. "hello string", which is the intended comparison but not a framework-vs-framework one.
* CPU quantiles from sampled adaptive analytics; invocations ≈ requests sent (svelte `api` 135/150, vue `ssr` 142/150, demo `ssr` 147/150 — sampling, not errors: all probe statuses were 2xx/3xx).
* Workers deleted after the run: the four `cflite-site-*` workers and `bench-bare`; **`cf-lite-demo` stays deployed.**

## Data

### Warm TTFB (ms), client 1, p50 / p95 / p99 (colos: {'HKG': 5820})

| variant | redirect | api | static | ssr |
|---|---|---|---|---|
| bare | 30.5 / 37.5 / 45.5 (n=270, HTTP 302, err 0) | 30.6 / 36.9 / 47.4 (n=300, HTTP 200, err 0) | 30.9 / 38.9 / 42.0 (n=300, HTTP 200, err 0) | 30.8 / 38.0 / 44.9 (n=300, HTTP 200, err 0) |
| demo | 30.7 / 38.8 / 49.7 (n=270, HTTP 302, err 0) | 31.5 / 43.2 / 75.4 (n=300, HTTP 200, err 0) | 38.1 / 48.9 / 70.7 (n=300, HTTP 200, err 0) | 33.0 / 49.0 / 80.3 (n=300, HTTP 200, err 0) |
| react | – | 31.7 / 39.4 / 45.5 (n=270, HTTP 200, err 0) | 40.9 / 57.8 / 86.5 (n=300, HTTP 200, err 0) | 33.7 / 48.9 / 75.8 (n=300, HTTP 200, err 0) |
| preact | – | 30.9 / 38.7 / 50.0 (n=270, HTTP 200, err 0) | 39.6 / 55.1 / 65.7 (n=300, HTTP 200, err 0) | 32.7 / 44.7 / 56.6 (n=300, HTTP 200, err 0) |
| vue | – | 29.9 / 37.6 / 41.0 (n=270, HTTP 200, err 0) | 37.1 / 52.5 / 85.4 (n=300, HTTP 200, err 0) | 33.3 / 47.3 / 65.9 (n=300, HTTP 200, err 0) |
| svelte | – | 31.5 / 38.7 / 47.6 (n=270, HTTP 200, err 0) | 39.4 / 52.0 / 69.9 (n=300, HTTP 200, err 0) | 32.4 / 40.8 / 49.2 (n=300, HTTP 200, err 0) |

### Delta over `bare` control, p50 (ms)

| variant | redirect | api | static | ssr |
|---|---|---|---|---|
| demo | +0.2 | +0.9 | +7.3 | +2.2 |
| react | – | +1.1 | +10.0 | +2.9 |
| preact | – | +0.4 | +8.7 | +1.9 |
| vue | – | -0.7 | +6.2 | +2.5 |
| svelte | – | +0.9 | +8.5 | +1.6 |

### Cold start after fresh deploy: first `/api/hello` on a new connection vs immediate 2nd request (ms TTFB)

| variant | n | first median [min..max] | second median | first-second median | colos |
|---|---|---|---|---|---|
| bare | 5 | 39 [30..52] | 32 | +6 | {'HKG': 5} |
| demo | 5 | 77 [64..434] | 32 | +45 | {'HKG': 5} |
| react | 5 | 69 [59..80] | 31 | +38 | {'HKG': 5} |
| preact | 5 | 58 [39..71] | 31 | +29 | {'HKG': 5} |
| vue | 5 | 67 [57..152] | 33 | +34 | {'HKG': 5} |
| svelte | 5 | 60 [36..74] | 34 | +27 | {'HKG': 5} |

First-request TTFB / second-request TTFB per probe (ms), in order:

- bare: 52/32, 40/28, 39/34, 38/32, 30/27
- demo: 76/31, 64/32, 100/36, 434/165, 77/32
- react: 80/31, 69/31, 77/32, 65/32, 59/30
- preact: 39/33, 71/32, 58/31, 57/28, 59/27
- vue: 152/33, 57/30, 76/35, 67/33, 66/34
- svelte: 36/36, 60/34, 74/34, 66/33, 54/30

### Worker CPU time per request (Workers analytics, one minute-aligned burst per cell from client 1)

| variant | route | requests sent | Worker invocations | CPU p50 (ms) | CPU p99 (ms) | wall p50 (ms) |
|---|---|---|---|---|---|---|
| bare | redirect | 150 | 150 | 0.18 | 0.30 | 0.36 |
| bare | api | 150 | 150 | 0.22 | 0.38 | 0.40 |
| bare | static | 150 | 150 | 0.43 | 0.72 | 0.79 |
| bare | ssr | 150 | 150 | 0.48 | 0.69 | 0.83 |
| demo | redirect | 150 | 0 (no Worker invocation row) | – | – | – |
| demo | api | 150 | 150 | 0.53 | 0.93 | 0.99 |
| demo | static | 150 | 0 (no Worker invocation row) | – | – | – |
| demo | ssr | 150 | 147 | 1.13 | 3.46 | 1.50 |
| react | api | 150 | 150 | 0.27 | 2.10 | 0.48 |
| react | static | 150 | 0 (no Worker invocation row) | – | – | – |
| react | ssr | 150 | 150 | 1.15 | 4.30 | 1.57 |
| preact | api | 150 | 150 | 0.38 | 0.61 | 0.70 |
| preact | static | 150 | 0 (no Worker invocation row) | – | – | – |
| preact | ssr | 150 | 150 | 0.88 | 3.84 | 1.22 |
| vue | api | 150 | 150 | 0.28 | 0.84 | 0.48 |
| vue | static | 150 | 0 (no Worker invocation row) | – | – | – |
| vue | ssr | 150 | 142 | 1.90 | 5.55 | 2.56 |
| svelte | api | 150 | 135 | 0.28 | 0.60 | 0.44 |
| svelte | static | 150 | 0 (no Worker invocation row) | – | – | – |
| svelte | ssr | 150 | 150 | 1.27 | 4.61 | 1.78 |

## Files (v0.3 addendum)
`live/{variants-v03.json,warm-v03.py,cpu-v03.py,cpu-analytics-v03.sh,cold-v03.py,cold-run-v03.sh,run-v03.sh,analyze-v03.py}` · raw dumps (not kept in the repository; see [live/README.md](live/README.md)). Regenerate tables: `python3 bench/live/analyze-v03.py`.

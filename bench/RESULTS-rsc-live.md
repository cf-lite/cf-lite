# RSC live benchmark (real network, workers.dev) — 2026-10-02

The page of `RESULTS-rsc.md` (header, 3-item list, `"use client"` counter island, one slow part behind `<Suspense>`, `?ms=N` = sleep) on three **temporary** Workers on a test
account's `<account>.workers.dev` (no custom domain, no DNS), measured from **client 1** (HKG colo for every request). **All three Workers were deleted afterwards; proof at the bottom.**
This is the live counterpart of the local-workerd `RESULTS-rsc.md` (cf-lite at `feat/rsc-hardening`, Node 24; commit of the run: see PR).

| worker | what it is | Worker upload (gz) | startup |
|---|---|---|---|
| `tmp-rsclive-lite` | **`examples/site-rsc` as is** (spa/static/ssr/rsc routes, cache/isr/actions/layouts; ≈ 20 routes) → `/rsc?ms=N` | 121.25 KiB | 5 ms |
| `tmp-rsclive-ssr` | same example with every `render = "rsc"` route removed (only `/ssr?ms=N`: loader awaits the slow part, no streaming) | 76.47 KiB | 4 ms |
| `tmp-rsclive-vinext` | vinext 1.0.0 + plugin-rsc 0.5.35 + React 19.3.0, one App Router page with identical markup (`force-dynamic`) → `/rsc?ms=N` | 261.30 KiB | 16 ms |

Note the asymmetry: the cf-lite rsc Worker carries the **whole example app**, vinext only its one route. The cf-lite number is therefore an upper bound for "one rsc route".

## Results

### Warm TTFB / total (ms; c = 1 keep-alive, targets × ms interleaved round-robin, 50 ms spacing, reconnect every 10 rounds, first request per connection dropped; n = 135–150 per cell, 0 errors)
| ms | target | n | TTFB p50 / p95 / p99 | total p50 / p95 | HTML bytes |
|---|---|---|---|---|---|
| 0 | cf-lite ssr | 135 | 31.0 / 36.8 / 40.2 | 31.1 / 36.8 | 690 |
| 0 | cf-lite rsc | 135 | 33.5 / 40.9 / 43.5 | 33.7 / 41.4 | 4,836 |
| 0 | vinext | 135 | 37.4 / 44.0 / 48.6 | 37.9 / 45.5 | 7,093 |
| 150 | cf-lite ssr | 150 | 180.6 / 185.6 / 187.3 | 180.7 / 185.6 | 694 |
| 150 | cf-lite rsc | 150 | **33.8 / 38.8 / 41.6** | 183.1 / 187.8 | 4,840 |
| 150 | vinext | 150 | **37.2 / 45.4 / 50.6** | 186.4 / 195.3 | 7,250 |
| 400 | cf-lite ssr | 150 | 430.5 / 435.7 / 441.0 | 430.7 / 435.7 | 694 |
| 400 | cf-lite rsc | 150 | **33.9 / 40.4 / 42.4** | 432.5 / 437.7 | 4,840 |
| 400 | vinext | 150 | **37.2 / 43.5 / 46.9** | 435.2 / 441.6 | 7,250 |

### Worker CPU per request (Workers GraphQL analytics `workersInvocationsAdaptive`, one minute-aligned burst of 150 requests per cell, 150/150 captured except vinext@150 = 149)
| ms | target | CPU p50 | p75 | p99 | wall p50 |
|---|---|---|---|---|---|
| 0 | cf-lite ssr | 1.11 ms | 1.51 | 4.17 | 1.5 ms |
| 0 | cf-lite rsc | 3.46 ms | 4.48 | 10.99 | 4.2 ms |
| 0 | vinext | 8.21 ms | 9.64 | 21.08 | 9.3 ms |
| 150 | cf-lite ssr | 1.35 ms | 1.51 | 5.97 | 151.4 ms |
| 150 | cf-lite rsc | 2.46 ms | 3.22 | 6.14 | 152.4 ms |
| 150 | vinext | 9.05 ms | 10.72 | 23.13 | 158.0 ms |

### Client JS the page references (gzip)
| page | external JS files | external gzip | inline gzip (bootstrap + Flight) |
|---|---|---|---|
| cf-lite ssr + island | 2 | 70,647 B | 100 B |
| cf-lite rsc + island | 8 | 78,638 B | 1,182 B |
| vinext | 6 | 135,177 B | 2,184 B |

### Cold start (`/rsc?ms=0` or `/ssr?ms=0` on a **new connection**; cost = first request − the immediate second request on the same connection, TTFB)
| phase | target | n | first p50 | second p50 | cold cost p50 | min..max |
|---|---|---|---|---|---|---|
| fresh deploy | cf-lite ssr | 5 | 73 | 30 | 43 ms | 3..56 |
| fresh deploy | cf-lite rsc | 5 | 79 | 33 | 46 ms | 4..99 |
| fresh deploy | vinext | 5 | 189 | 41 | 141 ms | 9..174 |
| ≥ 16 min idle | cf-lite ssr | 3 | 86 | 30 | 51 ms | 43..66 |
| ≥ 16 min idle | cf-lite rsc | 3 | 76 | 31 | 44 ms | 43..53 |
| ≥ 16 min idle | vinext | 3 | 178 | 43 | 134 ms | 110..149 |

## Reading
1. **Streaming works on the real network**: with a slow part the cf-lite rsc first byte is ~34 ms whatever `ms` is (ssr: 181 / 431 ms), total time equals ssr + ~2 ms. Same for vinext (37 ms).
2. **cf-lite rsc is ~3.4 ms (≈ 9 %) faster than vinext on TTFB at p50, and has a tighter p95** (38.8–40.9 vs 43.5–45.4). This settles the open question of `RESULTS-rsc.md`: the local "10–15 ms gap in vinext's favour" was a launcher artifact; live, the order is the other way round. The gap is small, one client host, one colo: read it as "no disadvantage", not as a large win.
3. **rsc vs ssr on the same cf-lite Worker code**: +2.5 ms TTFB at ms = 0 (Flight serialize + parse + inline payload), +2.3 ms Worker CPU p50 (3.46 vs 1.11 at ms = 0; 2.46 vs 1.35 at ms = 150). HTML is ~7× larger (4.8 KB vs 0.7 KB: inlined payload; gzip ~1.2 KB).
4. **CPU: cf-lite rsc 2.5–3.5 ms vs vinext 8.2–9.1 ms p50 (2.6–3.7× less)**; p99 11 vs 21–23 ms. The first burst (ms = 0) is higher than the second for cf-lite rsc (3.46 vs 2.46): it also includes isolate warm-up of a freshly started Worker, so use the ms = 150 row as the steady state.
5. **Cold start**: cf-lite rsc ≈ cf-lite ssr (+44–46 ms), vinext ≈ +134–141 ms (3×), consistent with its 261 KiB vs 121 KiB Worker. An rsc route does not add a measurable cold-start cost over ssr on this example (121 vs 76 KiB, 5 vs 4 ms startup).
6. **Size**: the whole `site-rsc` example Worker (121 KiB gz upload) is 2.2× smaller than vinext's one-route Worker (261 KiB); client JS 78.6 vs 135.2 KB (1.7×). Opting out of rsc keeps the Worker at 76 KiB (this ssr variant) — and non-rsc apps are byte-identical to main.

## Method
* Scripts: `bench/live/rsc-live.py` (warm / cpu / cold / size), `rsc-live.sh` (driver), `cpu-analytics-rsc.sh`, `analyze-rsc-live.py`, `rsc-teardown.sh` + `rsc-teardown-verify.sh`. Raw: `bench/results-live/rsc-live-{warm.jsonl,cold.jsonl,cpu-schedule.json,cpu-analytics-raw.json,size.json,analysis.txt,teardown-proof.txt}`.
* Builds: `cf-lite build` of two scratch copies of `examples/site-rsc` (worker `console.log` removed, KV binding removed, no middleware), vinext app rebuilt from the P4 bench app (`/tmp/p4-vinext`, renamed Worker). Deployed with `wrangler deploy` wrappers (account token supplied through the environment; no custom domain, no DNS).
* Warm: python3 stdlib `http.client`, HTTPS keep-alive, TTFB = request sent → headers received, `accept-encoding: identity`; 5 warm-up rounds, 150 measured rounds. No cache involved (no `cache`/`isr` export on the measured pages).
* CPU: the analytics API has no route dimension and reports `scriptName: __unknown__`, so each (target, ms) got its own minute-aligned burst and CPU quantiles are read per `datetimeMinute` (µs → ms), as in `RESULTS-live.md`. Data is sampled adaptive data.
* Cold: *fresh deploy* = redeploy (new version) then probe immediately, 5 rounds × 3 targets (deploys are rebuilds for cf-lite, `--prebuilt` for vinext); *idle* = 3 rounds after ≥ 16 min with zero traffic to any of the three Workers.

## Caveats
1. One client host (client 1), one colo (HKG: every response carried `-HKG`), one afternoon, unloaded account, `workers.dev`. No claim about other colos, paid plans or custom domains.
2. Cold: n = 5 (deploy) / 3 (idle) per cell: orders of magnitude (≈ 45 vs ≈ 140 ms), not a distribution. The second request after a cold one can also be slow (`first − second` under-counts).
3. Not the same app size (see top): cf-lite rsc = whole example; vinext = one route. Not the same framework scope either (vinext implements the Next App Router surface).
4. CPU p99 is the ≈ 2 worst of 150; the ms = 0 cf-lite rsc burst includes warm-up (reading 4).
5. The client-side machine also ran unit tests / e2e builds during part of the idle phase (not during warm or CPU bursts); probe deltas are first − second on the same connection, so client load cancels to first order.

## Teardown proof
`wrangler delete` for `tmp-rsclive-lite`, `tmp-rsclive-ssr`, `tmp-rsclive-vinext`, then (the output is summarised here; the raw file is not kept in the repository):
```
$ wrangler deployments list --name tmp-rsclive-lite     -> "This Worker does not exist on your account. [code: 10007]"   workers.dev: 404
$ wrangler deployments list --name tmp-rsclive-ssr      -> "This Worker does not exist on your account. [code: 10007]"   workers.dev: 404
$ wrangler deployments list --name tmp-rsclive-vinext   -> "This Worker does not exist on your account. [code: 10007]"   workers.dev: 404
Workers API script list: success, 28 scripts in the account, none named tmp-rsclive*
```

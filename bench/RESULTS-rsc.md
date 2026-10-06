# RSC benchmark: cf-lite `render="rsc"` vs cf-lite `render="ssr"` vs vinext — 2026-10-01

Same page in all three: header, a 3-item list (async server component), a `"use client"` counter island, and one slow part behind `<Suspense>`
(`?ms=N` sleeps N ms). cf-lite `rsc`/`ssr`: `examples/site-rsc` routes `/rsc` and `/ssr` (the ssr one awaits the slow data in its `loader`, so nothing streams).
vinext: `bench/apps/vinext` deps (vinext 1.0.0, `@vitejs/plugin-rsc` 0.5.35, react 19.3.0) + an App Router `app/rsc/page.tsx` with the identical markup (`force-dynamic`).
Raw output: `bench/results/rsc.json`. Script: `node bench/rsc-bench.mjs <cf-lite-app-dir> <vinext-app-dir> 300` (builds are done beforehand).
cf-lite at feat/rsc (P4), Node 24, local workerd via `vite preview` for both, one host (a development machine), nothing else running except editor-side file writes.

## Method (and how it differs from `RESULTS-live-0.6.md`)
This is the **local workerd** method of `methodology.md`, not the live `workers.dev` method of `RESULTS-live-0.6.md` (no deploy was allowed/needed). **The live run followed on 2026-10-02: `RESULTS-rsc-live.md` (it reverses the TTFB comparison with vinext: live, cf-lite rsc is ~3 ms faster, the local gap was the launcher).** Consequences, read before quoting:
* Wall time includes the ~15-25 ms local launcher floor (see methodology caveat 1). Compare rows to each other, not to production latencies.
* **CPU is not isolate CPU.** workerd does not report it locally. I sample `utime+stime` of the workerd process(es) under the launcher around batches of 50 sequential requests
  (`/proc`, 10 ms ticks), and report p50/p95 **over batch means** (6 batches of 50 per cell). It includes workerd's own dispatch work for the request, not only user code.
  Use the *differences* between rows (same launcher, same host); live Workers analytics numbers would be lower. n = 300 requests per cell, 40 warm-up, c = 1 keep-alive, targets interleaved per `ms` level.
* Worker size = gzip level 9 of every module in the deployable Worker (cf-lite: `dist/ssr/**` incl. the rsc child environment; vinext: its `bundle/` dir). The cf-lite number is the **whole example app** (ssr + rsc routes, cache, isr, actions, layouts), not a minimal rsc app.
* Client JS = gzip of every `<script src>` / modulepreload file the HTML references (what the browser downloads for that page), plus inline `<script>` bodies (bootstrap + inlined Flight payload).

## Results

### Worker size (gzip)
| | raw | gzip |
|---|---|---|
| cf-lite `examples/site-rsc` (all modes: spa/static/ssr/rsc + cache/isr/actions + nonce CSP) | 412,009 B | **133,347 B** |
| vinext (same page, 1 route) | 892,731 B | **286,925 B** |
| cf-lite app **without** any rsc route (opt-out, `examples/site`-class) | see `bench/module-sizes.json` | unchanged vs `main` (byte-identical `dist`, `size:check` green) |

The RSC runtime costs about +36 KB gzip on a small app when the first rsc route appears (spike measurement, `docs/design/rsc-spike.md`; the P2-P4 features - layouts, head, cache/isr wrappers, actions, nonce/CSP middleware in the example - grew `site-rsc` from 114,616 to 133,347 B). Apps that do not opt in pay nothing.

### Client JS for the page (gzip)
| page | external JS files | external gzip | inline gzip (bootstrap + Flight) | HTML |
|---|---|---|---|---|
| cf-lite `render="ssr"` + island | 3 | 71,461 B | 101 B | 974 B |
| cf-lite `render="rsc"` + island | 8 | 78,560 B | 1,194 B | 4,820 B |
| vinext | 6 | 135,265 B | 2,198 B | 7,089 B |
| cf-lite `render="rsc"`, `hydrate = false` | 0 | **0** | 0 | (no JS requests: e2e asserts it) |

### Latency and CPU (local workerd, c = 1; ms = sleep of the Suspense'd part)
| ms | target | TTFB p50 / p95 | total p50 / p95 | CPU ms/req p50 / p95 (workerd process) |
|---|---|---|---|---|
| 0 | cf-lite ssr | 18.1 / 19.7 | 18.8 / 20.3 | 4.4 / 4.4 |
| 0 | cf-lite rsc | 22.5 / 25.8 | 25.9 / 29.2 | 7.2 / 7.4 |
| 0 | vinext | 30.5 / 34.2 | 33.7 / 37.1 | 14.8 / 16.6 |
| 150 | cf-lite ssr | 176.4 / 178.6 | 177.1 / 179.2 | 5.6 / 5.6 |
| 150 | cf-lite rsc | **37.1 / 40.0** | 186.7 / 189.7 | 8.4 / 8.6 |
| 150 | vinext | **27.1 / 30.7** | 182.8 / 186.1 | 14.8 / 16.4 |
| 400 | cf-lite ssr | 427.2 / 429.9 | 427.9 / 430.7 | 6.2 / 6.8 |
| 400 | cf-lite rsc | **37.3 / 40.0** | 437.1 / 439.6 | 8.4 / 8.8 |
| 400 | vinext | **27.9 / 30.8** | 433.7 / 436.7 | 14.8 / 19.4 |

(Second run, 2026-10-01 18:51 UTC. A first run the same day, with the example Worker's per-request `console.log("[worker]", ...)` still in place, was ~8 ms slower on every cf-lite row at ms = 0 (rsc 29.6 TTFB / 7.6 CPU) because logging to stdout in `vite preview` is that expensive; the log line was removed for this build only, the committed example keeps it for its e2e. Raw: `bench/results/rsc.json` is the second run.)

## Reading
1. **Streaming works as designed**: with slow data cf-lite rsc's first byte is ~37 ms regardless of the slow part (ssr: slow part + floor, 176 / 427 ms). The user sees the shell 140-390 ms earlier.
2. **CPU**: rsc costs about +2.8 ms per request over ssr (Flight serialize + tee + parse + inline payload; the spike measured +7 ms wall) and is **about half of vinext's** here (7.2-8.4 vs 14.8 ms). Worker 2.2x smaller, client JS 1.7x smaller (vinext ships its own router + React runtime).
3. **The 10-15 ms "TTFB gap" to vinext at ms = 150 is a launcher artifact, not an rsc cost.** It appears on a plain Hono route that enqueues a first chunk and then `await`s a 150 ms timer (a temporary `/api/zzstream` route, not committed; TTFB 17.0 ms at 0 ms vs 32.6 ms at 150 ms, no React involved) and disappears for vinext, which runs under a different launcher
   (`@cloudflare/vite-plugin` 2.0.0-beta vs 1.62.2 for cf-lite). So the TTFB comparison with vinext at ms > 0 is biased against cf-lite by roughly that amount; the ssr -> rsc comparison on the same launcher is not. Live Workers were not measured.
4. HTML grows ~5x vs ssr (4.8 KB vs 1 KB: the inlined Flight payload duplicates the data); gzip makes the inline part ~1.2 KB. Cache/ISR store this HTML once (HTML + inline payload are one entry; `?__rsc` is a second key).

## Caveats
Single host, single day, local workerd, c = 1; CPU is a process-level proxy (see Method); the cf-lite size is the whole example app; vinext was not tuned (default config, `force-dynamic`);
vinext/React versions float on caret ranges in `bench/apps/vinext/package.json` - re-run before quoting. No live (`workers.dev`) run was done: nothing was deployed.

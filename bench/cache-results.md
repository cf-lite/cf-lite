# Cache bench (local workerd)

2026-09-30 - Intel(R) Xeon(R) CPU E5-2696 v4 @ 2.20GHz, 16 cores, node v24.20.0, 300 sequential requests per row (a third of that for the +50 ms I/O rows), page = demo `/cached-fn/:id` (React SSR, 400 rows).

| case | TTFB p50 (ms) | TTFB p95 (ms) | total p50 (ms) | workerd CPU / request (ms) |
|---|---|---|---|---|
| floor | 16.77 | 18.00 | 23.93 | 6.83 |
| uncached | 26.64 | 29.58 | 27.51 | 12.03 |
| miss | 35.44 | 44.91 | 37.56 | 14.70 |
| hit | 24.34 | 30.47 | 24.98 | 8.17 |
| uncached +50ms I/O | 78.74 | 86.77 | 79.69 | 12.90 |
| miss +50ms I/O | 87.42 | 93.52 | 89.48 | 16.40 |
| hit +50ms I/O | 24.38 | 28.50 | 25.09 | 8.60 |

"floor" = `/api/hello` (a trivial Worker route: the dev-loop + HTTP floor every row pays). "uncached" = same page, cache() returns false. "miss" = render + `caches.default.put` (+ a tag-ledger read is skipped: nothing stored yet). "hit" = `cache.match` + ledger check (KV binding, memoised per isolate) + no render.
CPU is user+sys time of the local workerd processes per request, which includes the HTTP/proxy work of wrangler's dev loop; read it as a ratio, not as Workers billed CPU. The first block has no I/O in the loader; the +50 ms block adds one awaited 50 ms call, which is where a cache hit pays off (hit cost stays flat). The local Cache API is miniflare's SQLite-backed emulation - a hit costs ~8 ms over the floor here, far more than a real colo cache read.

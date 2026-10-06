# ISR "durable static" (R2 + Queue)

`cf-lite/modules/isr` is the second ISR tier from the roadmap (§1.2). Tier (a) is `export const cache` (Cache API, per colo, see [caching.md](caching.md)).
Tier (b), this module, writes the regenerated HTML to **R2** so every colo serves the same copy, and rebuilds pages in the background via a
**Queue**. Workers static assets stay immutable per deploy (by design); no redeploy is needed to change a page.

```ts
// server/api/pages.ts (any Hono route, including the SSR catch-all)
import { isr, isrRevalidate, revalidateTag } from "cf-lite/modules/isr";
export default new Hono<{ Bindings: Env }>()
  .get("/posts/:id", isr({ maxAge: 300, swr: 3600, tags: (c) => ["posts", `post:${c.req.param("id")}`] }), renderPost)
  .post("/revalidate", isrRevalidate());               // POST + Authorization: Bearer $ISR_REVALIDATE_TOKEN {tags, paths}

// server/queues/isr.ts  (queue named "isr")
import app from "../../.cf-lite/app";
export default isrConsumer({ render: (req, env, ctx) => app.fetch(req, env, ctx) });

// after an edit (action, webhook, queue, cron):
await revalidateTag(env, `post:${id}`);      // or revalidatePath(env, "/posts/42")
```

Bindings: `ISR_BUCKET` (R2), `ISR_QUEUE` (producer, queue `isr`, consumer in the same Worker), optional `CF_CACHE_TAGS`/`CF_CACHE_DB`
(tag ledger shared with the cache module), secret `ISR_REVALIDATE_TOKEN` (falls back to `CACHE_PURGE_TOKEN`). See `examples/site-isr/wrangler.jsonc`.

## As a route convention: `export const isr`

For page routes you do not write any Hono glue. In an `render = "ssr"` page:

```tsx
// app/routes/posts/[id].tsx
export const render = "ssr";
export const isr = { maxAge: 300, swr: 3600, tags: (c) => ["posts", `post:${c.req.param("id")}`] };   // same policy object as isr({...})
export async function loader(c) { ... }
export default function Post({ data }) { ... }
```

`cf-lite` generates into the Worker (`.cf-lite/app.ts` / `.cf-lite/handlers.ts`):

* the page's GET handler wrapped with `isrRoute(mod, handler)` (POST actions are never cached; with `export const cache` too, the Cache API tier wraps the R2 tier);
* `isrOrigin()` middleware and `POST /api/_isr/revalidate` (`isrRevalidate()`, bearer `ISR_REVALIDATE_TOKEN`, 503 until set);
* the queue `isr` consumer in `handlers.queue` (spread `handlers` in `server/worker.ts`). A hand-written `server/queues/isr.ts` replaces the generated one; other `server/queues/*` files are merged.
* build-time warnings when wrangler lacks the `ISR_BUCKET` R2 binding, the `ISR_QUEUE` producer, or the `isr` queue consumer.

Invalidate from anywhere with `revalidateTag(env, "post:42")` / `revalidatePath`. The policy is read at startup (`maxAge <= 0` throws), so it must be a plain object literal; `export const isr` on a non-ssr page is a build error. The `isr` export is stripped from the client bundle.
Reference: `examples/site-isr-route` + `scripts/isr-route-e2e.mjs` (two workerd processes sharing one R2). The hand-written middleware form above stays supported for non-page handlers.

## Behaviour

| stored copy | response | side effect |
|---|---|---|
| none | render inline, `x-cf-lite-isr: MISS` | store in R2 (`waitUntil`) |
| age < `maxAge`, tags not purged | `HIT` from R2 | none |
| `maxAge` <= age < `maxAge+swr`, or a tag purged after it was rendered | `STALE` from R2 | one `ISR_QUEUE` message per key per isolate (no queue: re-render via `waitUntil` once a consumer is registered) |
| older than `maxAge+swr` (up to `maxStale`, default 7 d) | render inline; **if it fails (5xx/throw) the stored copy is served** | store on success |
| older than `maxStale` | render inline | store |

* **Regeneration failure keeps the last good copy**: the consumer only writes after a cacheable 200; errors retry with backoff (10 s x2, max 10 min, 5 attempts) and then log and give up; the stored object is never touched.
* **Dedupe**: each message carries the revalidation time `at`; the consumer skips it when the stored copy is already newer. Concurrent regenerations never replace a newer copy with an older render.
* **Bypass**: non-GET, `Authorization`, the SSO cookie, the session module's `session` / `__Host-session` (or `authCookies`), a per-request `security()` CSP nonce (`csp-nonce`), `Set-Cookie`/`no-store`/`private` responses, non-200 - never stored, never served from R2.
* **Keys**: pathname + hash of the normalised query (tracking params dropped, same rules as the cache module). `_isr/<path>`; tag index objects `_isr-tags/<tag>/<id>` (empty, metadata = path).
* **Security**: the consumer re-renders in-process with a one-shot random nonce header; a client-supplied header is ignored, so no one can force a store or skip the R2 read. Revalidate endpoint compares the bearer token in constant time and is **503 (closed)** when no token is set.
* `revalidateTag` purges the shared tag ledger too (when bound), so a Cache API tier in front (`export const cache`) is invalidated; without `ISR_QUEUE` it deletes the R2 entries instead (next request renders fresh).
* Put `isrOrigin()` (middleware) before `isr()` routes, or set `SITE_URL`, so the consumer knows the origin it should render.

## Cost model (Cloudflare list prices, *verify current*)

Per page: render = 1 Class A (`put`) + 1 per *new* tag (index) on first store, 1 Class B (`get`) per uncached request (R2 reads are cheap; put the Cache API in front to cut them).
`revalidateTag` = 1 Class A list per 1000 entries + 1 Queue write per page; the consumer adds 1 queue read/delete (3 queue operations per message total) and 1-2 Class A (`head` is Class B). Example: editing a tag covering 1000 pages ~ 1 list + 1000 messages (~3000 queue ops) + ~1000 renders + ~1000 R2 puts. Egress from R2 is free; Worker CPU is the render.

## Limits / not done

* Regeneration re-renders through the app's own `fetch`, so only routes guarded by `isr()` regenerate; pages are not pre-warmed after deploy (first hit renders).
* Tag index objects are not garbage collected when a page stops carrying a tag (harmless: one extra regeneration). Stored entries are never expired; set an R2 lifecycle rule on `_isr/` if the key space is unbounded.
* R2 is strongly consistent for read-after-write; the tag ledger (KV) is eventually consistent (~60 s) but only affects *when* a purge is noticed on the read path, the queue path does not depend on it.
* The "scratch-account smoke" acceptance item needs a real Cloudflare account (R2 plan requirements are not re-verified here; Queues itself works on Workers Free, 10k operations/day and 24 h retention, verified 2026-09-30 from developers.cloudflare.com/queues/platform/pricing - at ~3 operations per page, a Free plan regenerates roughly 3,000 pages a day): **flagged for the owner**; local proof is two `wrangler dev` processes sharing one persisted R2 (`scripts/isr-e2e.mjs`).

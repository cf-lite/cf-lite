# Edge caching for SSR routes

`export const cache` on a `render = "ssr"` page caches the rendered HTML in the Workers **Cache API** (`caches.default`), with
stale-while-revalidate, global tag purge, and an automatic bypass for signed-in users. It is opt-in per route and costs nothing
for routes that don't export it (the wrapper is only imported by the generated app when at least one route does).

```tsx
// app/routes/posts/[id].tsx
export const render = "ssr";
export const cache = { maxAge: 60, swr: 600, tags: ["posts"] };

// or decided after the loader ran - params + loader data in, policy out; return false to not cache this response
export const cache = ({ params, data }) =>
  data ? { maxAge: 60, swr: 600, tags: ["posts", `post:${params.id}`] } : false;
```

## Options

Policy (object form, or the function's return value):

| option | default | meaning |
|---|---|---|
| `maxAge` | required, > 0 | seconds a stored copy is fresh (`x-cf-lite-cache: HIT`) |
| `swr` | 0 | extra seconds the stale copy is still served (`STALE`) while one background re-render refreshes it |
| `tags` | `[]` | purge tags: max 16, 1-128 chars, no control chars/commas. Every entry also gets `path:<pathname>` |
| `browserMaxAge` | 0 | `max-age` sent to browsers. Client header is `public, max-age=<browserMaxAge>, s-maxage=<maxAge>, stale-while-revalidate=<swr>` |
| `cacheControl` | generated | replace the client-facing `Cache-Control` entirely |

Key / bypass options. In the object form put them inline; with the function form put them in a second export, `export const cacheKey = {...}`
(they are needed *before* the loader runs, when the function can't be called yet):

| option | default | meaning |
|---|---|---|
| `vary` | none | request headers that become part of the key (`["accept-language"]`). Headers not listed never affect the key |
| `ignoreParams` | - | extra query params to drop; `utm_*` prefix globs work. Built in: `utm_*`, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `yclid`, `twclid`, `ttclid`, `igshid`, `_ga`, `_gl`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `vero_id` |
| `keepParams` | - | allow-list: only these params are in the key, everything else is dropped |
| `allowAuthenticated` | false | cache/serve even when an auth cookie or `Authorization` header is present. Only for pages identical for everyone |
| `authCookies` | - | extra cookie names that mean "signed in" (the SSO cookie - `SSO_COOKIE_NAME`, default `sso` - and the session module's `session` / `__Host-session` are always ones; a custom session `cookieName` must be listed here) |

Keys are the URL with the hash removed, ignored params dropped and the remaining params sorted, so `/p?b=2&a=1&utm_source=x` and
`/p?a=1&b=2` share an entry. Cookies are never part of the key.

## Request flow

1. Dev server, non-GET (incl. HEAD), or signed-in request -> **BYPASS**: not read, not written, `Cache-Control: private, no-cache` for the signed-in case.
2. `cache.match(key)`. Metadata (render start time, `maxAge`, `swr`, tags) lives on the entry, so a lookup needs no config.
3. Fresh and no tag purged since it was rendered -> **HIT**. In the `swr` window -> **STALE**: serve it, then `ctx.waitUntil` one re-render
   (deduplicated per key per isolate). Otherwise -> **MISS**: render, answer, and store via `waitUntil` (teed, so TTFB is not delayed).
4. Not stored: non-200, `Set-Cookie`, `Cache-Control: private|no-store` or `Vary: *` from the page, a function form returning `false`/throwing.
   Lifetime is capped at 7 days. Every response carries `x-cf-lite-cache: HIT|STALE|MISS|BYPASS` (+ `x-cf-lite-cache-why` on BYPASS, `Age` on HIT/STALE).

Revalidation re-runs the loader and renderer with the original request's Hono `Context`. Keep pages that opt into the cache independent of
cookies and of request headers that are not in `vary`.

## Purging

Tag purge needs a ledger, because entries cannot be enumerated (and `cache.delete` only touches the colo it runs in). Bind **one** of:

```jsonc
// wrangler.jsonc
"kv_namespaces": [{ "binding": "CF_CACHE_TAGS" }],                                  // default, cheap
"d1_databases": [{ "binding": "CF_CACHE_DB", "database_name": "my-db" }],           // table cf_lite_cache_tags is created on first use
```

(`CF_CACHE_STORE=kv|d1` picks one if both are bound.) A purge writes `tag -> purged-at` to the ledger - one O(1) write, no enumeration. On every
hit the entry's tags are looked up (memoised 3 s per isolate; a purge in the same isolate refreshes it at once) and the entry is served only if
no tag was purged *after its render started*. So purges take effect in **every colo**, with the ledger's propagation delay:

* **D1**: read-your-writes at the primary; other isolates see a purge within the 3 s memo.
* **KV**: eventually consistent; reads are edge-cached (`cacheTtl` 30 s, the minimum) - expect ~30-60 s, occasionally longer, and note that
  a *never-purged* tag is negatively cached too. KV allows 1 write/s per key: repeated purges of one tag inside a second can be rejected (429).
  Need sub-second global purges? Use D1.
* If the ledger read fails, the entry is **not** served (the page renders fresh). No ledger bound: caching still works by `maxAge`/`swr`, tags
  can't be purged, and `purgeTags` throws.

From your own code (API routes, webhooks):

```ts
import { purgeTags, purgePaths } from "cf-lite/modules/cache";

app.post("/webhooks/cms", async (c) => {
  // verify the webhook signature first - this is a public URL
  await purgeTags(c.env, ["posts", `post:${id}`]);   // every entry carrying either tag
  await purgePaths(c.env, ["/posts/42"]);            // every variant (query strings, `vary`) of that pathname
  return c.json({ ok: true });
});
```

### Read-your-writes: `updateTag` and `refresh()`

`purgeTags` is `revalidateTag`: right for webhooks and cron. For a **user's own write** (Next.js `updateTag`) the ledger's delay matters: the writer is redirected back to the page and must not see the stale copy that another colo
still holds. `updateTag(c, tags)` purges like `purgeTags` **and** sets a 60 s `__cfl_upd=<time>` cookie (HttpOnly, SameSite=Lax, Secure on https) on the response; a request carrying a fresh one bypasses `cacheRoute` and `isrRoute`
(`x-cf-lite-cache-why: updated`, `cache-control: private, no-cache`, nothing read or written), so the writer renders from the source of truth while everyone else converges through the ledger.

```ts
import { updateTag, updatePath } from "cf-lite/modules/cache";

export const actions = {
  save: async (form, c) => {
    await savePost(c.env, form);
    await updateTag(c, ["posts", `post:${form.get("id")}`]);   // or updatePath(c, "/posts/42")
    // returning nothing = 303 back to the page; it is rendered fresh for this user
  },
};
```

In an RSC server action use `updateTag` from `cf-lite/modules/rsc-update` (its own module so RSC apps that do not call it do not carry the cache code; same behaviour, the cookie is attached to the action's response, also when the action then calls `redirect()`). Needs the tag ledger bound; without one it throws.
The cookie is presence + age only (no signature): the worst a forged one can do is make its own sender skip the cache.

`refresh()` (Next.js `router.refresh()`) from `cf-lite/client`: re-fetches the current page's server data without losing client state. An RSC page re-requests its Flight payload in place, an SPA route (client-only, no server data) is a no-op,
a server-rendered document falls back to `location.reload()`. (Server actions already return fresh output: an action response is never cached, so there is no server-side `refresh()`.)

Protected endpoint for CI/CMS: mount `cachePurge()` yourself (nothing is exposed by default):

```ts
// server/api/cache.ts  ->  POST /api/cache/purge
import { Hono } from "hono";
import { cachePurge } from "cf-lite/modules/cache";
export default new Hono<{ Bindings: Env }>().post("/purge", cachePurge());
```

```bash
wrangler secret put CACHE_PURGE_TOKEN
curl -X POST https://example.com/api/cache/purge -H "authorization: Bearer $CACHE_PURGE_TOKEN" \
  -H "content-type: application/json" -d '{"tags":["posts"],"paths":["/posts/42"]}'
```

It answers 503 when `CACHE_PURGE_TOKEN` is unset (fails closed), 401 on a missing/wrong bearer (constant-time compare), 400 on bad input.

Clock note: "purged after the render started" compares timestamps taken in different colos. Skew of milliseconds can, at worst, let an entry
rendered within the same few ms as the purge survive one purge (purge again) - a purge is not a transaction.

## Limits - read before relying on it

* A request whose context carries a `security()` CSP nonce is never cached (`x-cf-lite-cache-why: csp-nonce`): the HTML is stamped per request and a stored copy would replay a stale nonce that no longer matches the new policy. Use static/hash CSP or ISR-less pages if you need edge caching of those routes.

* **The Cache API is per-colo, not global.** An entry exists only in the data centre that rendered it; a colo with no entry renders itself (your
  loader/D1 gets one call per colo per `maxAge`, not one per `maxAge` worldwide). There is no tiered cache for `cache.put`. Hit ratio is
  therefore lower than a global CDN's for low-traffic pages, and cold colos always miss.
* **Custom domains only.** Cloudflare documents `cache` operations as functional only on routes/custom domains; on `*.workers.dev` they do nothing, so
  every request is a MISS there. Test caching on a real zone.
* **`cache.delete` is local** and we don't rely on it; invalidation is the ledger described above. The ledger is the only thing that's global.
* **No stampede protection across isolates.** Revalidation is deduplicated inside one isolate only; N isolates in a colo may revalidate in parallel.
  A MISS has no request coalescing at all - a popular page expiring under load renders once per concurrent request until the first `put` lands.
* **`stale-while-revalidate` / `stale-if-error` are not honoured by the Cache API** - `swr` here is implemented by cf-lite, only for this wrapper.
* Hits cost a `cache.match` and (when tags exist and a ledger is bound) a memoised ledger read; a hit on a cold isolate pays one KV/D1 read.
* Entries are limited by the Cache API's own caps (per-object size limit, eviction under pressure - an entry can vanish before `maxAge+swr`).
* Client `Cache-Control: no-cache` request headers are deliberately **not** honoured (they would let anyone force origin renders).
* The wrapper never sees what the page leaks: if your loader personalises on something other than the SSO cookie / `Authorization`
  (a custom session cookie, a header), add it to `authCookies` or don't cache that route.

### When to use Cloudflare's own caching instead

| need | use |
|---|---|
| a globally shared cache / high hit ratio on low-traffic pages, tiered caching | Cloudflare's zone CDN cache (**Cache Rules** with "Eligible for cache") in front of the Worker, or `fetch()` to an origin so tiered cache applies. Note static assets served by Workers are already CDN-cached |
| global purge by tag / prefix / hostname / everything / URL | the zone **purge API**. As of 2026-09 Cloudflare lists purge by tag/prefix/host on every plan (rate-limited: Free 5 req/min, Pro 5/s, Business 10/s, Enterprise 50/s - check the current limits page). Whether zone purges also evict `caches.default` entries is not documented; don't rely on it - use the cf-lite ledger for Cache-API entries |
| cache key built from cookies/headers/query with fine control | Cache Rules **custom cache key** (**Enterprise**) |
| survive cold caches / long-tail content | **Cache Reserve** (paid add-on) |
| very high-traffic page where per-colo caching is enough | this module |
| per-user pages | neither; keep `BYPASS` (or cache fragments/data in KV/D1 instead of the page) |

Enterprise-only / paid features above are labelled as of the Cloudflare docs checked 2026-09-30; plan availability changes - confirm on your account.

## Verification

* `packages/cf-lite/test/cache.test.ts` - key normalisation, tag validation, KV + D1 ledgers (D1 against real SQL), the full state machine against a
  fake Cache API, bypass rules, purge endpoint (auth/fail-closed/validation).
* `scripts/cache-e2e.mjs` (part of `bun run test:e2e`) - under local workerd: miss -> hit -> stale -> background revalidate -> expired miss, tracking
  params, tag purge, path purge, function form, auth bypass, purge endpoint auth; run once with the ledger in KV and once in D1.
* `bench/cache.mjs` - TTFB/CPU hit vs miss vs uncached, results in `bench/cache-results.md`.

# CMS webhooks (publish -> purge / regenerate)

> Optional module `cf-lite/modules/webhook`. Design and trade-offs: [design/cms-webhook.md](design/cms-webhook.md). Status: round 1, API may change before 1.0.

A CMS tells the Worker "content X was published". The Worker verifies the call, queues it and answers 200; a queue consumer purges every page
that rendered X ([caching](caching.md) tag ledger) and, for ISR pages, queues regeneration ([ISR](isr.md)).

Fast path: `bunx cf-lite add webhook [--provider generic|optimizely]` writes the two files below, adds the `WEBHOOK_QUEUE` producer + `cms-webhook` consumer to `wrangler.jsonc` (idempotent) and prints the secret/KV steps. The receiver is then `POST /api/webhooks/cms`.

```ts
// server/api/webhooks.ts
import { Hono } from "hono";
import { genericAdapter, webhookReceiver } from "cf-lite/modules/webhook";
export default new Hono<{ Bindings: Env }>().post("/cms", webhookReceiver({ adapter: genericAdapter() }));

// server/queues/cms-webhook.ts   (export const queue = "cms-webhook"; export const binding = "WEBHOOK_QUEUE"; the generated dispatcher routes it)
import { webhookConsumer } from "cf-lite/modules/webhook";
export default webhookConsumer({ resolve: (ev) => ({ paths: ev.id ? [`/blog/${ev.id}`] : [] }) }); // resolve() optional

// a loader: record what the page rendered
import { trackContent, contentTags } from "cf-lite/modules/webhook";
export const loader = async (c) => { const post = await getPost(c); trackContent(c, "post", post.id); return post; };
export const isr = { maxAge: 300, swr: 3600, tags: (c) => contentTags(c) };
// or for the cache module: export const cache = ({ req }) => ({ maxAge: 300, tags: contentTags(req) });
```

Bindings/secrets: `CMS_WEBHOOK_SECRET` (`wrangler secret put`; `"new,old"` while rotating), queue producer `WEBHOOK_QUEUE`, KV `WEBHOOK_KV` (or the cache's
`CF_CACHE_TAGS`) for idempotency, plus `CF_CACHE_TAGS`/`CF_CACHE_DB` (and `ISR_BUCKET`/`ISR_QUEUE`) for the purge.

## Verification (canonical format)
Header `x-cms-signature: t=<unix seconds>,v1=<hex>` with `v1 = HMAC-SHA256(secret, "<t>.<raw body>")` (several `v1=` values allowed), `x-cms-delivery: <id>` for dedupe,
`|now - t| <= 300 s`. `CMS_WEBHOOK_SECRET` may be `"new,old"` while rotating. `signWebhook(body, secret, nowMs?, deliveryId?)` returns those headers (tests, mock CMS);
`verifyWebhook(req, rawBody, secret, opts?, now?)` is the pure check (503 no secret, 401 otherwise). Other providers: `verify: { mode: "secret", signatureHeader: "x-api-key" }`.

## Generic payload
`{ "id": "delivery-1", "events": [{ "action": "publish", "type": "post", "id": "42", "paths": ["/blog/hello"], "tags": ["nav"] }] }` — or a single event.
Responses: 200 `{ok, events}` / `{ok, duplicate:true}`, 400 bad payload, 401 bad signature, 413 > 256 KiB, 503 not configured.

## Tags
`trackContent(c, type, id | ids | "*")`, `contentTags(c)` (<= 14 tags; overflow collapses the biggest type to `content:<type>:*`), `contentTags(c, {all:true})` for pages that
must follow bulk syncs. A publish purges `content:<type>:<id>`, `content:<type>:*`, event `tags` and `path:` tags of `paths`.

## Optimizely Graph (stub)
`optimizelyAdapter()` + `optimizelyVerify` (`x-api-key`): `doc.updated` / `doc.expired` (docId `{UUID}_{language}_Published`) and `bulk.completed` (coarse purge).
Events carry the docId uuid **without dashes** (32 hex = Graph's `_metadata.key`), so `trackContent(c, "page", item._metadata.key)` tags match the event tags; `type` is `"content"` unless set (docIds carry no type: list pages track `"*"`). `_Draft` docIds are ignored (`includeDrafts: true` to purge on them; `keepDashes: true` for the raw uuid).
Shape taken from docs.developers.optimizely.com only and **not tested against a live tenant**.

Freshness: purge reaches other colos within the KV ledger's propagation delay (~30-60 s, see [caching](caching.md)).

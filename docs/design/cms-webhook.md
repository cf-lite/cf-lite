# CMS publish webhook -> cache purge / ISR regeneration (WP-WEBHOOK)

Status: round 1 (design + implementation start). Module: `cf-lite/modules/webhook` (+ `webhook-optimizely` stub).
User guide: [../webhooks.md](../webhooks.md). Builds on [caching](../caching.md), [ISR](../isr.md), [queues](../background-jobs.md).

## Problem
A headless CMS (Optimizely Graph, Contentful, Sanity, a custom admin) publishes content. Pages rendered from it are cached
(Cache API tier, ISR in R2). The CMS must be able to say "X changed" and every page that rendered X must refresh — without the
webhook request doing the work (CMS webhooks time out in seconds and retry), and without an attacker being able to purge on demand.

## Pipeline

```
CMS --POST--> receiver (Worker, fast path)            queue WEBHOOK_QUEUE            consumer (queue handler)
              1 size cap (256 KiB)                  { v, delivery, provider,        4 events -> tags (eventTags + resolve())
              2 verify (HMAC+timestamp | secret)       at, events[] }               5 ISR_BUCKET bound? revalidateTag()  (queue regen + ledger purge)
              3 adapter.parse -> ChangeEvent[]  --->                          --->    else purgeTags()                    (ledger only)
              3b dedupe (KV, 24 h)                                                   retry w/ backoff, dead after 6
              3c enqueue THEN mark seen
              -> 200
```

* **Fail closed**: no secret -> 503 and nothing enqueued; no queue binding -> 503 (the CMS retries; losing an event is worse than a retry).
* **Verification** (`verifyWebhook`, pure): canonical format (agreed with cmsdemo, round 2) `x-cms-signature: t=<unix>,v1=<hex HMAC-SHA256(secret,"<t>.<body>")>`; timestamp within ±300 s so a captured delivery cannot be replayed later; the signature covers the
  timestamp so re-stamping fails. `secret` mode = constant-time compare of a header (`x-api-key`) for providers that only offer a shared secret.
  All comparisons hash both sides then `timingSafeEqual` (length does not leak); rotation = `CMS_WEBHOOK_SECRET="new,old"`.
* **Idempotency**: key = `<adapter>:<delivery id>`, id from the provider header, else the body (`id`), else sha256(body). KV with 24 h TTL.
  KV is not atomic (two simultaneous duplicates can both pass) — acceptable because purging is idempotent. Enqueue happens *before* marking
  seen: a crash in between yields a re-enqueue, never a lost event. No KV bound -> no dedupe (warn once), still correct.
* **Why a queue, then 200**: purge of N tags + ISR listing of R2 can exceed the webhook timeout; Queues give retry/backoff/DLQ for free and a
  burst (bulk import = hundreds of webhooks) is absorbed. Works on Workers Free (see background-jobs.md).

## Dependency tags (the tag ledger)
The caches already invalidate by tag (cache.ts: ledger of tag -> purged-at; isr.ts: R2 tag index). What was missing is *producing the tags from
what a page actually rendered*. `trackContent(c, "post", post.id)` in a loader records the dependency on the **request**
(WeakMap keyed by `Request`, so it works with a Hono `c`, `isr({tags:(c)=>...})`, and `cache = ({req}) => ...`), and `contentTags(c)` turns the
record into tags `content:<type>:<id>`. A publish event purges `content:<type>:<id>`, `content:<type>:*` and explicit/`path:` tags.

* `trackContent(c, type, "*")` = "any content of this type" (list pages, sitemaps) -> tag `content:<type>:*`, purged by every publish of that type.
* **Tag cap**: cache/isr keep <= 16 tags per entry (1 is `path:`). `contentTags` returns <= 14; over that the type with the most ids *collapses* to
  `content:<type>:*` (never drops a dependency; cost = more purges for that page). Collapsed pages are still correct.
* Locale is deliberately not part of the tag: a publish of any locale refreshes pages that rendered any variant (over-purge > stale).
* Alternative considered: a persistent id -> pages table (D1). Rejected for round 1: tags already give O(1) purge across colos with no write on render
  (the entry carries its tags); a table adds a write per render and cleanup. Revisit only if "list everything that depends on X" becomes a feature.

## Provider adapters
`WebhookAdapter { name, deliveryIdHeader?, deliveryId?(body), parse(body, req) -> ChangeEvent[] }` — pure, no I/O. `ChangeEvent`:
`{ action: publish|unpublish, type?, id?, locale?, paths?, tags?, all? }`; `all` = coarse "something changed" (bulk sync without ids) -> tag `content:*`.
* `genericAdapter()`: `{ id?, events:[{action?, type, id, locale?, paths?, tags?}] }` (or one event), strict validation, <= 100 events.
* `optimizelyAdapter()` **stub**, from public docs only (docs.developers.optimizely.com, 2026-10-01): payload `{id,timestamp,tenantId,type:{subject,action},data}`;
  `doc.updated|doc.expired` carry `data.docId = {UUID}_{language}_Published`; `bulk.completed` carries only `journalId` (no ids) -> coarse purge.
  Auth documented as an `x-api-key` header set at registration -> `optimizelyVerify` (secret mode). Fixture: `test/fixtures/optimizely-graph-webhook.json`
  (shape copied from docs, values invented). Needs a live tenant to confirm; flagged for the owner.

## Consumer mapping
`webhookConsumer({ resolve? })`: `eventTags(ev)` + `resolve(ev, env)` (app hook: e.g. slug lookup -> `{ paths: ["/blog/x"] }`). With `ISR_BUCKET`
bound -> `revalidateTag` (enqueues regeneration, purges ledger); otherwise `purgeTags`. Chunks of 100 tags. Throws -> `defineQueue` retry with backoff.

## Open questions / limits
1. `all` events (bulk sync, no ids) purge tag `content:*`; pages opt in with `contentTags(c, { all: true })` (costs 1 of the 16 tags). Resolved in round 1; open: should list/sitemap pages default to it?
2. KV ledger propagation is ~30-60 s per colo (cache.ts); ISR regeneration is faster for regenerated pages only. Document as the freshness SLA.
3. Real Optimizely HMAC header format is not public; stub uses shared-secret.
4. Draft/preview events (unpublish vs draft) are ignored; belongs with WP-DRAFT.
5. Round 2: `cf-lite add webhook` scaffolds `server/api/webhooks.ts` + `server/queues/cms-webhook.ts` (existing api/queues conventions do the wiring; no new convention contributor was needed) and the wrangler queue entries. Runtime e2e: `packages/cf-lite/test/webhook-workerd.test.ts` (two `wrangler dev` colos sharing KV/R2 persistence, real local Queue).

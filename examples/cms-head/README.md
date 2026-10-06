# cms-head — a headless-CMS head on cf-lite

A public site whose pages, routes and blocks all come from a headless CMS (GraphQL), plus a mock CMS (with an editor UI) to run it against. Guide: [docs/cms-head.md](../../docs/cms-head.md).
Draft preview is `cf-lite/modules/draft`, publish → purge is `cf-lite/modules/webhook`; nothing is stubbed.

```
cms/            shared by Worker + tests (no app/ imports)
  types.ts      content model, Block union, splitRoute()
  graphql.ts    ~100-line GraphQL subset: parse, variables, inline fragments, projection
  mock.ts       the mock CMS (Hono app): reads, saveDraft/publish/unpublish, signed webhook, delivery log, editor + preview-url endpoints
  editor.ts     the editor page (iframes the head in preview; posts "content saved" to it)
  seed.ts       fixtures: en+vi x (home, about, 2 articles) + a shared Banner block
  client.ts     typed client; `fetcher` seam = in-process mock | service binding | real CMS (`CMS_URL`)
public/cms-saved-listener.js   generic content-saved listener (preview responses only)
app/blocks/registry.tsx        content-type -> component registry, <Blocks> composition, views.Page / views.Article
app/routes/[[...path]].tsx     catch-all: URL -> CMS route -> loader (isDraft, trackContent) -> registry; ISR with contentTags(c)
server/api/cms.ts              mock CMS mounted at /api/cms (graphql, editor, admin/*)
server/api/webhooks.ts         POST /api/webhooks/cms: webhookReceiver(genericAdapter) -> queue
server/queues/cms-webhook.ts   webhookConsumer(): event -> content tags -> revalidateTag -> ISR regeneration
vite.config.ts                 cfLite({ draft: true }) -> draft() + /api/draft/{enable,disable}
```

## Design

* **Route by URL.** `/en/blog/first` → locale `en`, CMS path `/blog/first`. One optional catch-all; the loader asks the CMS `route(path, locale, preview)` and `notFound()`s on `null`. `/` → `/en`; unknown locale = 404.
* **Content type → component.** The CMS returns a typed block tree (`Hero | RichText | Cta | Columns | ArticleList | Banner`; `BlockRef` is resolved CMS-side to a reusable `block` entry).
  `registry` maps `__typename` → a **plain sync component**; `<Blocks>` composes (Columns recurse). What a block needs beyond its fields (`ArticleList` → articles) is fetched **once by the loader**
  (`needsArticles`). Unknown type = hidden marker, not a crash. Only the registry is React; `cms/*` is framework-free.
* **Published vs draft.** Entries have `published` and `draft` versions. Live reads see `published`; `preview: true` (Bearer `CMS_TOKEN`, server-side only) reads `draft ?? published`.
* **Draft mode.** The CMS "Preview" link is `/api/draft/enable?secret=…&path=/en/about`: sets the sealed `__cfl_preview` cookie and redirects. The loader reads `isDraft(c)`; `isr()` bypasses on the cookie, so a previewer never stores/receives a cached page; responses are `private, no-store` + `noindex`.
* **Publish → purge.** The mock POSTs `{ id, events: [{ action, type, id, locale, paths }] }` signed `x-cms-signature: t=<unix>,v1=hmac_sha256(secret, "<t>.<body>")` + `x-cms-delivery`.
  `webhookReceiver` verifies, dedupes (KV), enqueues, answers 200; `webhookConsumer` turns events into tags (`content:<type>:<id>`, `content:<type>:*`, `path:`), calls `revalidateTag` → the `isr` queue regenerates; the old HTML keeps serving until the new is stored.
  The loader declares what a page depends on: `trackContent(c,"page",id)`, `("block","*")` (shared blocks are resolved CMS-side, so any block publish purges CMS pages), `("article","*")` for list blocks; `isr.tags = (c) => contentTags(c)`.
* **Editor + live preview.** `/api/cms/editor`: paste the token, pick an entry; the preview button (`GET /admin/preview-url`) loads the head through the enable link in an `<iframe>`; **save draft** `postMessage`s
  `{type:"cms:content-saved", id, version}` (target origin pinned) and the framed page reloads itself. `public/cms-saved-listener.js` (generic, ~20 lines, classic script) is added **only to preview responses** via `head().script`
  (published pages stay zero-JS), honours the page origin + `<meta name="cms-editor-origins">`, ignores everything else. Same idea as Optimizely's `createContentSavedListener`, not its API.
* **Mock CMS placement.** In-process (loader calls `mockCms.fetch`: no hop, no self-fetch) and also at `/api/cms/graphql`. To run it as its own Worker: `createMockCms({store, deliver})` there with `deliver = (req) => fetch(HEAD + "/api/webhooks/cms", req)`, then `CMS_URL` or a service binding on the head's `fetcher` seam.

## How to adapt to a real CMS (e.g. Optimizely Graph)

Everything CMS-specific sits behind four seams; the registry, loader shape, ISR tags and editor flow stay.

| Seam | Mock | Real CMS |
|---|---|---|
| **Content query** (`cms/client.ts`) | `route(path, locale, preview)` / `articles(...)` over the mock's GraphQL subset | Same two functions over the CMS's GraphQL. Optimizely Graph: query by the content item's URL/route field and locale and use its published-content key vs a draft-capable credential (**check the exact field names and auth in Optimizely's docs; not verified against a live tenant here**). Map its content-type union to the `Block` union (`__typename` → registry key). Keep documents inside what the CMS supports (real GraphQL has no subset limits). |
| **Fetcher** (`fetcherFor` in the route) | in-process mock | `fetch(env.CMS_URL…)` with the key in a secret, or a service binding |
| **Webhook adapter** (`server/api/webhooks.ts`) | `genericAdapter()`, HMAC `x-cms-signature` | `optimizelyAdapter()` + `optimizelyVerify` from `cf-lite/modules/webhook-optimizely` (`doc.updated` / `doc.expired` / `bulk.completed`, shared-secret header). **Stub: shape taken from Optimizely's docs, not tested against a live tenant.** For another CMS write a `WebhookAdapter` (pure `parse(body) -> ChangeEvent[]`). |
| **Tags** (`trackContent`) | entry ids from the mock | the CMS's stable content key (Optimizely: the GUID part of `docId`). Whatever you track must equal what the adapter emits as `ChangeEvent.id`/`type`, or use `paths`. Add `resolve()` to `webhookConsumer` when an event id cannot name the page directly. |
| **Preview** | `/api/draft/enable` link built by the mock editor | The CMS's "preview URL" template pointing at `/api/draft/enable?secret=…&path={url}` (prefer a CMS-signed `token` + `draftRoutes({ verifyToken })` over the long-lived secret in the URL); set `draft: { frameAncestors: ["https://<cms host>"] }` so the editor iframe is allowed, and `<meta name="cms-editor-origins">` (or `createContentSavedListener({allowedOrigins})`) for its save event. Translate the CMS's own saved event (Optimizely's SDK has a content-saved listener; check its payload) into the `cms:content-saved` message. |

Operational: `wrangler secret put CMS_TOKEN | CMS_WEBHOOK_SECRET | DRAFT_SECRET` (the `vars` in `wrangler.jsonc` are **demo values for the mock only**), real Queues `isr` + `cms-webhook`, R2 bucket, KV for dedupe.
Purges reach other colos within the tag-ledger propagation delay (see docs/caching.md). Sanitise `RichText.html` before rendering real CMS HTML.

## Run

```
npm run dev -w cf-lite-cms-head                  # /en ; editor at /api/cms/editor (token: demo-cms-token)
npx vitest run examples/cms-head                 # unit (graphql, mock + webhook wiring, registry, listener)
node scripts/cms-head-e2e.mjs                    # workerd e2e (also part of `npm run test:e2e`)
PW_ONLY=cms-head npx playwright test            # real browser: editor iframe live refresh
```

## Findings

* Blocks nest two levels in the GraphQL document (GraphQL has no recursion); deeper trees need a flattened CMS shape.
* The mock parses a GraphQL **subset** (no aliases / named fragments); a real CMS does not have that limit.
* `c.req.param("*")` was empty for `/en` on the optional catch-all under workerd, so the route reads the URL pathname (`splatOf`). Possible core bug, not changed here.
* Blocks resolved CMS-side (`BlockRef`) cannot be tracked by id from the head: any block publish purges all CMS pages (coarse, correct).

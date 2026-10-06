# Draft mode (preview)

`cf-lite/modules/draft` lets any CMS preview unpublished content on the real site. See [design/draft-mode.md](design/draft-mode.md) for the reasoning.

```ts
// server/middleware.ts  (draft() after security())
import { security } from "cf-lite/modules/csp";
import { draft } from "cf-lite/modules/draft";
export default [security(), draft({ frameAncestors: ["https://cms.example.com"] })];

// server/routes/draft.ts - mounted at /api/draft
import { draftRoutes } from "cf-lite/modules/draft";
export default draftRoutes({ verifyToken: async (token) => token === (await cms.previewToken()) });

// app/routes/blog/[slug].tsx - the loader decides what a previewer sees
import { isDraft } from "cf-lite/modules/draft";
export const render = "ssr";
export const loader = async ({ c, params }) => getPost(params.slug, { drafts: isDraft(c) });
```

Set `DRAFT_SECRET` (>= 32 chars, comma list for rotation; `openssl rand -base64 32`). The CMS "Preview" button opens
`https://site.example/api/draft/enable?secret=…&path=/blog/hello[&token=…]`; the site sets the `__cfl_preview` cookie and redirects to `path`.
`/api/draft/disable` clears it.

| Behaviour | Detail |
|---|---|
| Cookie | sealed (AES-GCM, bound to its name), `HttpOnly`, expiry inside the value (`maxAge`, default 1 h, max 24 h) |
| Caches | `cache()` and `isr()` bypass (`x-cf-lite-cache-why: draft`) whenever the cookie is present; responses are `private, no-store`, `Vary: Cookie` |
| Indexing | valid drafts send `X-Robots-Tag: noindex, nofollow, noarchive` |
| Iframe | `frameAncestors` relaxes CSP `frame-ancestors` (and drops `X-Frame-Options`) for valid drafts only; cookie becomes `SameSite=None` on https |
| Guards | missing/short `DRAFT_SECRET` -> 503; wrong secret/token -> 401; `path` must be same-origin |

## Previewing prerendered pages

Prerendered (`render = "static"`) pages are answered by the assets layer before the Worker runs, so a cookie cannot divert them. Turn on the wiring and they get an on-demand twin:

```ts
// vite.config.ts
cfLite({ renderer: react(), draft: { frameAncestors: ["https://cms.example.com"] } })
```

`draft` (true or `{ maxAge, frameAncestors, requireToken, allowPaths, ctxParams }`, JSON-only) installs `draft()`, mounts `/api/draft/{enable,disable}`, and generates `GET /__preview<path>` for every static page. Only `/__preview` and `/__preview/*` become Worker-first (every other static request stays free). The enable endpoint rewrites a prerendered `path` to `/__preview<path>` itself, so the CMS link stays `enable?secret=…&path=/about`. A request without a valid cookie gets the normal 404 there.
The static page's `loader(c)` runs at request time with `isDraft(c) === true`. Preview pages are server-rendered **without hydration** (the client router has no `/__preview` route); links inside them lead to the published pages. Need `verifyToken`? Mount your own `draftRoutes({ verifyToken })` in `server/routes` (a function cannot be put in `vite.config.ts` options that are generated into code; the first matching route wins).
`cf-lite doctor` warns (CFL012) when `draft` is on but `DRAFT_SECRET` is not declared.

## CMS-issued tokens, runtime CMS origins

A CMS that appends its own short-lived token (and cannot hold `DRAFT_SECRET`) is supported three ways:

```ts
// 1. cfLite config: a module with the verifier (default export or named `verifyToken`), imported into the generated app
cfLite({ renderer: react(), draft: { tokenOnly: true, verifyToken: "server/draft-token.ts" } })
// server/draft-token.ts
export default async (token: string | null, c: Context) => (await cms.verify(token)) === true;

// 2. in server/routes: draftRoutes({ tokenOnly: true, verifyToken }) - the token alone authorises `enable?token=…&path=…`
//    (DRAFT_SECRET still seals the cookie, but is never in a URL). Without tokenOnly the secret is also required.

// 3. your own route verifies whatever the CMS sends, then mints the cookie in one place:
import { enableDraft } from "cf-lite/modules/draft";
app.get("/preview", async (c) => (await cms.verify(c.req.query("preview_token"))) ? enableDraft(c, {}, { path: "/" + c.req.query("key"), ctx: { key: c.req.query("key")! }, maxAge: 600 }) : c.text("no", 401));
```

`enableDraft(c, opts, { path, ctx, maxAge })` seals the state, chooses `SameSite`, sanitises `path` (same-origin only), and adds the no-store headers. It answers 503 if `DRAFT_SECRET` is missing.

`frameAncestors` is no longer build-time only: besides the static array it takes a function `(c) => string[]` (in `draft()`/`draftRoutes()` constructed in `server/`), and the origins listed in the Worker env vars **`DRAFT_FRAME_ANCESTORS`** and **`CMS_ORIGINS`** (comma/space separated; override the names with `frameAncestorsEnv`, `[]` disables) are merged in per request - so `cfLite({ draft: true })` plus `vars.CMS_ORIGINS` per environment is enough. Env/function entries use the same validation (no bare wildcards); an invalid env entry is ignored, never widened. The cookie becomes `SameSite=None` whenever the resolved list is non-empty.

SSR/ISR catch-alls need no `/__preview`: `draft` only generates it for `render = "static"` pages; `ssr` + `isr()` pages are bypassed by the cookie itself (`x-cf-lite-isr-why: draft`).

Limits: `/about` itself (the public URL) stays the published static file even with the cookie - open the preview URL (the enable redirect does). Rate-limit `/api/draft/enable` with `ratelimit()` if it is internet-facing; prefer a CMS-signed `token` over the long-lived secret in the URL (URLs reach access logs).

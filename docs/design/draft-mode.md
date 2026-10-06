# Design: draft mode (WP-DRAFT, roadmap 1.2)

Status: rounds 1-2 - core, `/__preview`, `cfLite({ draft })`, doctor CFL012 and workerd e2e (`scripts/draft-e2e.mjs`) are implemented. User docs: [../draft-mode.md](../draft-mode.md).

## Goal and non-goals

A CMS-agnostic *preview primitive*: an editor clicks "Preview" in any CMS, lands on the real site rendering unpublished content, inside an iframe if the CMS wants. cf-lite knows nothing about the CMS; the CMS (or a mock) only needs to hit one URL.
Non-goals: a CMS client, content diffing, visual-editing overlays, per-user draft ACLs (the secret is the ACL).

## Mechanism

1. **Enable**: `GET /api/draft/enable?secret=S&path=/blog/x[&token=T]` (or `Authorization: Bearer S`). `S` is `DRAFT_SECRET` (constant-time compared, rotation list). Optional `verifyToken(T, c)` / `requireToken` lets the CMS pass a short-lived token it signs itself - recommended, because `S` in a URL lands in access logs. Success: 307 to a validated same-origin path + `Set-Cookie: __cfl_preview`.
2. **Cookie** `__cfl_preview`: `sealData({iat, exp, ctx?}, DRAFT_SECRET, aad="__cfl_preview")` - the session module's AES-256-GCM seal, so it is unforgeable, tamper-evident, and cannot be replayed as/for a session (aad). Expiry is *inside* the sealed value (default 1 h, cap 24 h), not only `Max-Age`. `HttpOnly; Path=/; Secure` on https. `SameSite=Lax`, or `None` when `frameAncestors` is configured on https (cross-site iframe cookies need it). No `__Host-` prefix: the name is fixed by the roadmap and `__Host-` would rename it.
3. **Read**: `draft()` middleware verifies the cookie once per request and sets `c.get("draft")`. `isDraft(c)` / `draftState(c)` are sync reads for loaders/actions/components. Without the middleware `isDraft` is `false` (fails closed). `ctx` carries opaque CMS context copied from allow-listed enable params (`ctxParams`, e.g. document id).
4. **Disable**: `GET|POST /api/draft/disable` clears the cookie; no secret needed (it only reduces access).

## Cache bypass (the part that must not leak)

Rule: a request that *might* be a previewer never reads or writes any shared cache, and nothing rendered for it is storable.

| tier | how |
|---|---|
| Cache API (`cache()`) | bypass `why=draft` when the cookie is **present** (presence-only regex, no crypto, independent of middleware order; fails toward bypass). Response `private, no-store`. |
| ISR (R2) (`isr()`) | same: bypass before any R2 access; also covers the `REGEN` path being untouched (regen requests never carry the cookie). |
| Browser / CDN | `Cache-Control: private, no-store` + `Vary: Cookie` on every response to a request with the cookie - valid *or* invalid/expired, so a shared cache cannot hold a page rendered for that cookie either. |
| Search engines | valid draft: `X-Robots-Tag: noindex, nofollow, noarchive`. |
| Prerendered / static assets | **Implemented (round 2, `conventions/draft.ts`).** Workers assets answer before the Worker unless the path is in `run_worker_first`, so a cookie cannot divert a prerendered page. A reserved Worker-first prefix `/__preview/*` (one glob in the generated `run_worker_first`, no cost to normal traffic). The enable endpoint redirects `path` -> `/__preview<path>` when `path` is prerendered; the Worker strips the prefix and renders the route through the SSR handler, falling back to `ASSETS` (+ `x-cf-lite-draft: static`, a doctor/log warning) if the route has no SSR handler. A page that needs true drafts should be `render = "ssr"`. |

Alternative rejected: run the Worker first for all paths when draft mode is configured (`run_worker_first: ["/*"]`) - bills and slows every static request (doctor CFL007 already warns on it).

## CSP / framing

`security()` defaults to `frame-ancestors 'none'` (strict) / `'self'` (relaxed), which blocks a CMS iframe. `draft({ frameAncestors: ["https://cms.example.com"] })` rewrites `frame-ancestors` to `'self' <origins>` and drops `X-Frame-Options` **only on valid-draft responses**; the public site stays unframeable. Entries are validated at construction (`https://host[:port]`, `'self'`, `*.sub` ok; bare `*`, whitespace, `;` refused - header-injection / clickjacking guard). `draft()` must be mounted *after* `security()` in the middleware list (it edits headers on the way out; either order works for the cache bypass).
Clickjacking trade-off: the allowed origins can frame a draft; since drafts require the cookie, the exposure is limited to the origin the operator named.

## Interaction with sessions / auth / security modules

- Independent of `session()`: a different cookie, key domain (aad) and lifetime. A draft cookie confers *content visibility only*, never an identity; authed-bypass in `cache()`/`isr()` is unchanged.
- `security()`: nonce CSP keeps working (draft responses are never cached, so nonces are fine); only `frame-ancestors` is edited.
- CSRF: enable is a GET that sets a cookie, but requires the secret, so it is not forgeable cross-site. Actions executed in draft mode keep their normal CSRF checks.
- Open redirect: `path` is same-origin-only (`safeRedirectPath`), optional `allowPaths`.
- Rate limiting of the enable endpoint is left to `ratelimit()` (documented, not built in).
- Secret in query string: documented risk; mitigations = `verifyToken`, short-lived tokens, `Referrer-Policy` already set by `security()`, 307 immediately so the secret never reaches a rendered page.

## Interface (public, stable intent)

```ts
// cf-lite/modules/draft
draft(opts?): MiddlewareHandler            // verify cookie -> c.get("draft"), harden response
draftRoutes(opts?): Hono                   // /enable, /disable
isDraft(c): boolean;  draftState(c): DraftState | undefined
DRAFT_COOKIE = "__cfl_preview"
DraftOptions { secrets?, maxAge?, frameAncestors?, verifyToken?, requireToken?, allowPaths?, ctxParams? }
// cf-lite/modules/cache
hasDraftCookie(req): boolean               // used by cache()/isr(); webhook purge code never needs it
```
Webhook/ISR siblings: a purge/revalidate never touches draft state; draft requests never populate caches, so no purge is needed after an edit.

## Round 2/3 plan
R2: `/__preview` Worker-first path for prerendered routes, `cfLite({ draft })` wiring (generated `run_worker_first`, doctor check for missing `DRAFT_SECRET`), workerd e2e (cache + ISR + prerender + iframe headers), `examples/cms-head` integration with the mock CMS. R3: size-budget entry, docs-check/snippets, review fixes, merge.

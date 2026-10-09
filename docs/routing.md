# Routing conventions

Everything below is build-time: a file layout becomes generated code (`.cf-lite/app.ts`, `.cf-lite/routes.ts`) and `assets.run_worker_first` globs. No runtime router ships to the Worker beyond the Hono app.
Design notes for the contributor mechanism live in [conventions.md](conventions.md).

## File -> URL

| File under `app/routes/` | URL |
|---|---|
| `index.tsx`, `about.tsx`, `posts/index.tsx` | `/`, `/about`, `/posts` |
| `posts/[id].tsx` | `/posts/:id` |
| `docs/[...rest].tsx` | `/docs/*` — catch-all, **at least one** segment (`/docs` is a 404); the value is `params["*"]` |
| `docs/[[...slug]].tsx` | `/docs/*?` — optional catch-all, also matches `/docs` (`params["*"] === ""`) |
| `(marketing)/pricing.tsx` | `/pricing` — a parenthesised directory is a **route group**: stripped from the URL, it may own a `_layout.tsx` (and boundaries) |

Specific beats dynamic beats catch-all beats optional catch-all. Two files mapping to one URL (also through groups) is a build error.
An optional catch-all compiles to two Worker-first globs (`/docs` and `/docs/*`, because `/docs/*` does not match `/docs`).

## Boundaries: `_loading`, `_error`, `_not-found`

Per directory, nearest ancestor wins (like layouts). They are not routes.

- **`_loading.tsx`** — the Suspense fallback wrapped around the page (inside the layouts, which stay mounted). React adapter; other adapters ignore it (Preact has no Suspense in core; Vue/Svelte: not wired yet).
  SSR flushes the shell before slow Suspense children resolve, so TTFB is not loader-bound.
- **`_error.tsx`** — rendered when the loader or the render throws **before the first byte**: status 500, props `{ params, data: { error: { message, digest } } }` (`digest` = `cf-ray` or a random id, also
  written to the Worker log as `[cf-lite] render error digest=…`). In production `message` is always `"Internal Server Error"`: the stack never reaches the client; in dev it is the real message.
  On the client (React, Preact) it is also an error boundary around the page (`error` prop too). Without an `_error` file: plain 500 with the digest.
- **`_not-found.tsx`** — used for `throw notFound()` (status 404, nearest directory's file), and as the last-resort client route for unmatched URLs. With a static `/` the root `_not-found` is
  **prerendered into `404.html`** (assets `404-page` handling serves it with status 404, no JS). Without it, `404.html` stays the SPA shell.

- **`_forbidden.tsx`** / **`_unauthorized.tsx`** — used for `throw forbidden()` (status **403**: signed in but not allowed) and `throw unauthorized()` (status **401**: not signed in), nearest directory's file,
  rendered without hydration like `_not-found`. Without the file: a plain-text `403 Forbidden` / `401 Unauthorized`. In an RSC route: `_forbidden.rsc.tsx` / `_unauthorized.rsc.tsx`.
  A 401 page should link to your sign-in route; cf-lite does not add a `WWW-Authenticate` header (set it in middleware if your clients need it).

### `template` and `default`: not provided

- **`template.tsx`** (a layout that remounts on every navigation): not implemented. cf-lite layouts stay mounted across client navigations; to force a remount, key the subtree on the path in your layout
  (`key={pathname}` in React/Preact, `:key` in Vue, `{#key}` in Svelte, with the pathname from `usePathname`-style state you keep yourself). Server-rendered pages are full documents, so there is nothing to remount.
- **`default.tsx`** (fallback for a parallel-route slot): n/a, because parallel and intercepting routes are a stated non-goal ([migration-from-nextjs.md](migration-from-nextjs.md)).

## Sentinels (`cf-lite/navigation`)

```ts
import { notFound, forbidden, unauthorized, redirect, permanentRedirect } from "cf-lite/navigation"; // also re-exported from cf-lite/server

export async function loader(c) {
  const post = await getPost(c.req.param("id"));
  if (!post) notFound();               // 404 + _not-found, before any byte is streamed
  if (!c.get("user")) unauthorized();  // 401 + _unauthorized
  if (!canRead(c.get("user"), post)) forbidden();  // 403 + _forbidden
  if (post.moved) redirect(post.url);  // 307 (redirect(url, 301|302|303|307|308)); permanentRedirect(url) = 308
  return post;
}
```

`ssr()` catches them around the loader and around the pre-flush render, so the status line and `Location` are real even though the body streams. Once streaming started an error can no longer change the
status (React finishes the shell first, so a throw in the shell is still caught; a throw inside a Suspense child after the flush degrades to client-side recovery).
Cache: only `200` responses are cached, so redirects/404/500 are never stored.

## `paths()` — static pages with dynamic segments

```tsx
// app/routes/blog/[slug].tsx
export const render = "static";
export async function paths() { return (await listSlugs()).map((slug) => ({ slug })); }   // splat: { "*": "a/b" }
export async function loader(c) { return getPost(c.req.param("slug")); }                   // runs at build, feeds render + head()
export default function Post({ params, data }) { … }
```

`vite build` + `cf-lite build` prerender one `blog/<slug>/index.html` per entry in Node. The Worker is not invoked for them (no Worker glob is generated). Unlisted params are a 404 (`404.html`).
`paths()` runs in Node, not workerd: reach data through `fetch`, files, or a wrangler-proxy; there are no bindings at build (`c.env` is `{}`).
A static `loader(c)` gets a minimal context: `c.req.param()`, `c.req.url`, `c.req.raw`; `notFound()` skips that entry, `redirect()` is a build error, and `forbidden()` / `unauthorized()` are build errors too (a static page has no request to authorize; make it `ssr`).

`export const dynamicParams = true` turns unlisted params into on-demand SSR: the route gets Worker globs, the handler first asks the assets binding for the prerendered file (`/x/1/`, `/x/1`), and renders
with the loader only on a 404. Cost: the Worker is invoked for every request on that route (cheap asset fetch for listed ones) — prefer `false` unless you need it.

## `server/routes/**` — non-API handlers

`server/routes/feed.xml.ts`, `server/routes/og/[slug].ts`: default export = a Hono app (handle `"/"`), mounted at the file's own URL and added to `run_worker_first`, like `server/api/**` but outside `/api`.
Runs after `server/middleware.ts`, before pages.

## Client: prefetch, focus, scroll

- `<Link to>` (React, Preact) warms the target route's modules (and its layouts/boundaries) on hover/focus/touch: `prefetch="intent"` default, `prefetch={false}` to disable. `prefetch(to)` is exported from `cf-lite/client`.
- After a client navigation the router updates a polite live region (`aria-live="polite"`, `role="status"`) (`#cf-lite-announcer`, text = `document.title`), moves focus to `<main>` (or `<h1>`; `tabindex=-1` is added), and scrolls to the top
  (or the `#hash` target). Back/forward keeps the browser's scroll restoration.

## Server-only exports never reach the browser

A page module is imported by both the Worker (full module) and the client router. The `cf-lite:strip-server` Vite transform (client environment only, dev and build)
removes the top-level exports `loader`, `actions`, `cache`, `isr` and `paths` from `app/routes/**/*.{ts,tsx,js,jsx,vue,svelte}` before bundling, leaving an `undefined` stub for in-file
references; imports only those exports used are then tree-shaken. `scripts/isr-route-e2e.mjs` and `test/strip-server.test.ts` assert the built client chunks contain no loader/action body.
Limits: detection is syntactic (`export const|function name`, `export { name }`; a destructured export is left alone), and an import with top-level side effects stays in the chunk — keep
server-only code in `server/`. In `.vue` files only the plain `<script>` block is rewritten (`<script setup>` cannot export route config anyway); in `.svelte` files only `<script module>` / `context="module"`.

## Not in this release

`defer()` streaming loaders, layout-level `loader`s, viewport prefetch / SSR HTML-fragment prefetch, `_loading`/`_error` wiring for Vue/Svelte (and `_loading` for Preact), group-level `middleware` files,
and the per-adapter axe/focus browser test. Tracked in the roadmap (WP-ROUTE).

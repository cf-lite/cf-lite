# React Server Components (`render = "rsc"`)

**Status: experimental.** Opt-in per route, React only. Design and security reasoning: [design/rsc.md](design/rsc.md) (ADR). Measurements: [../bench/RESULTS-rsc.md](../bench/RESULTS-rsc.md).
Apps without an `rsc` route are **byte-identical** to what cf-lite built before this feature (CI size gate + A/B hash of `dist/`), so nothing below applies to you unless you opt in.

Runs: build (Vite RSC environments), Worker (server components, Flight serialization, SSR of the result), browser (only the `"use client"` islands and a small router).
Cost on Cloudflare: Workers requests like `ssr` routes (Worker-first, GET); no extra bindings. Needs no account or plan beyond Workers.

## Opt in

Shortcut for a React app: `bunx cf-lite add rsc` does steps 1-3 (pins, flag, a starter page) and is idempotent; the manual steps are:

1. Install the pinned dependencies (exact versions, copy from `examples/site-rsc/package.json`; they are optional peers of `cf-lite`):
   `bun add -E @vitejs/plugin-rsc@0.5.35 react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0 rsc-html-stream@0.0.8`
2. wrangler: `"compatibility_flags": ["nodejs_compat"]` (`getRequest()` uses `AsyncLocalStorage`).
3. A page: `export const render = "rsc"`.

```tsx
// app/routes/dashboard.tsx
import { Suspense } from "react";
import { Counter } from "../islands/counter";            // file starts with "use client"
export const render = "rsc";
export const head = { title: "Dashboard" };
export default async function Page({ params, url }: { params: Record<string, string>; url: string }) {
  const rows = await loadRows(params);                    // async server component
  return <main><Rows rows={rows} /><Counter /><Suspense fallback={<p>loading</p>}><Slow /></Suspense></main>;
}
```

`cf-lite doctor` checks the setup: `CFL014` (flag), `CFL015` (pins), `CFL016` (CSP without a nonce source) - see [doctor.md](doctor.md).

## What you get

| Feature | How |
|---|---|
| async server components, `React.cache`, Suspense streaming | shell flushes first; slow parts arrive as inline Flight chunks, the browser hydrates without a second fetch |
| request context | `getRequest()` / `getEnv()` from `cf-lite/rsc` inside any server component |
| `loader` export | same loader contract as `ssr` routes; result passed as `data` prop |
| `head` export | same as other routes (object or function, may be async) |
| layouts | `_layout.rsc.tsx` files (nested like `_layout.tsx`); the client-style `_layout.tsx` is **not** applied to rsc pages |
| `notFound()` / `forbidden()` / `unauthorized()` / `redirect()` | from `cf-lite/rsc`; before the first byte = real `404`/`403`/`401`/`3xx`; after streaming started they degrade (boundary component / client redirect). Boundaries: `_not-found.rsc.tsx`, `_forbidden.rsc.tsx`, `_unauthorized.rsc.tsx` (built-in text without them) |
| `updateTag(tags)` | from `cf-lite/modules/rsc-update`, inside a server action: purge + read-your-writes cookie ([caching.md](caching.md#read-your-writes-updatetag-and-refresh)) |
| errors | `_error.rsc.tsx` (client component, digest only, no message leak), `_not-found.rsc.tsx` |
| `cache` / `isr` exports | wrap the HTML and the `?__rsc` payload with the same policy and tags (`cf-lite/modules/cache`); `isr` gets the same queue consumer / revalidate endpoint as on ssr routes |
| `i18n` | pages under `app/routes/[locale]/` work as on ssr routes: `params.locale`, `i18nHead` in a `_layout.rsc.tsx` (`<html lang>` + hreflang), redirects on `/`; HTML and payload are cached per locale |
| draft / preview | `cfLite({ draft })`: `isDraft()` from `cf-lite/rsc` (and `draft` in the loader argument) is true for a valid preview cookie; such requests (HTML and `?__rsc`) bypass cache and ISR and are `no-store` |
| zero JS pages | `export const hydrate = false`: no bootstrap script, no inline payload, no client JS |
| soft navigation | between rsc routes (fetch `?__rsc`, transition swap, prefetch on hover / `data-prefetch="viewport"`, scroll restore); everything else is a full load |
| form-based server actions | `<form action={fn}>` with `fn` from `app/actions/**` or `*.actions.ts`, listed in the route's `serverActions` |

## Limits (by design or not done yet)

* GET only (plus the action POST). Not in the client route table; no static prerender (`render` stays dynamic). Other UI adapters: React only.
* Server actions: form-based only. Bound actions, programmatic calls (`onClick={() => fn(x)}`) and returned values are **not supported**; cf-lite never calls `decodeReply` / `decodeAction`.
* Prerendered (`render = "static"`) preview pages are not an rsc feature. `<head>` scripts from `head.script` are not re-run on soft navigation. A non-hydrated page has no router (its links are full loads).
* Dev server: `cf-lite dev` runs rsc routes (e2e `scripts/rsc-dev-e2e.mjs`: `getRequest()`, loader, island, and a server-component edit re-renders the open page in place). Client-component edits use normal Vite HMR: the e2e edits the `"use client"` island and checks the browser shows it with no document reload and the island keeps its state.
* Cost: roughly +36 KB gzip in the Worker for the first rsc route (+45% on a tiny app) and the extra client entry on rsc pages only; see the benchmark file for current numbers.
* plugin-rsc is 0.x: cf-lite pins exact versions and follows vinext's ranges (policy in the ADR, section 6). Do not widen the ranges yourself; `CFL015` flags it.

## Security notes

* **No Flight request is ever decoded.** Server actions are parsed from a size-bounded `FormData` with exactly one `$ACTION_ID_*` field; Flight bodies (`text/x-component`, JSON) get `415`. This keeps the React2Shell / DoS-in-server-functions class (ADR section 7) unreachable.
* Action checks, cheap first: method, CSRF (`Sec-Fetch-Site` then `Origin`; neither = 403), content type, body limit (1 MiB, `actionMaxBytes`), id shape, route allowlist (`serverActions`), your `actionGuard` (rate limit / authz), registry lookup. Treat an action like any POST endpoint: **authenticate and authorize inside it**; the allowlist only decides *which* function a route may run.
* **Props crossing server -> client are public.** Everything passed to a `"use client"` component ends up in the HTML and the inline payload. Never pass secrets, tokens or whole DB rows.
* **Cache poisoning.** HTML and `?__rsc` payload are separate cache keys under one path tag (purging the path purges both). The payload response carries `vary: accept`. Pages whose output depends on cookies/headers must not be cached (same rule as `ssr` routes); a request with a CSP nonce or a draft cookie bypasses `cache` / `isr` entirely.
* **CSP.** Inline scripts (bootstrap + Flight chunks) get the per-request nonce when `security()` is installed (`server/middleware.ts`); otherwise a strict `script-src` blocks them (`CFL016`). Pure `hydrate = false` pages have no inline script.
* Keep React / plugin-rsc at or above the pinned versions; advisories override "follow vinext" (ADR sections 6-7). `rsc-pins.test.ts` enforces the floor.

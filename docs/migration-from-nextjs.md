# Coming from Next.js

cf-lite is not a Next.js clone: it keeps the ideas that map cleanly onto Cloudflare (file routes, layouts, loaders, actions, ISR) and drops the ones that
need a server runtime it does not have. This page is the map. The exhaustive capability matrix, with status per item, is [roadmap-1.0.md](roadmap-1.0.md) §1.

## Mental model

| Next.js (App Router) | cf-lite |
|---|---|
| Node/edge server running your app | a Worker, plus **Workers static assets** in front of it; static and prerendered paths never invoke the Worker |
| React Server Components, `"use server"` | not supported, on purpose. **Loaders** (server data) + **actions** (server mutations) give the same outcomes without a flight protocol |
| `middleware.ts` on every request | `server/middleware.ts`; the `matcher` also becomes `run_worker_first`, so unmatched paths cost nothing |
| Vercel KV / Blob / Postgres / Edge Config | KV, R2, D1 (or Hyperdrive), Analytics Engine, used directly |
| Any host | Cloudflare only |
| React only | React, Preact, Vue, Svelte, or htmx; one adapter package |

## Feature map

| Next.js | cf-lite | Notes |
|---|---|---|
| `app/page.tsx`, `layout.tsx` | `app/routes/index.tsx`, `_layout.tsx` | layouts nest and persist across client navigations. [routing.md](routing.md) |
| `[id]`, `[...slug]`, `[[...slug]]`, `(group)` | same filenames | catch-all needs >= 1 segment, as in Next |
| `generateStaticParams` | `export async function paths()` | runs in Node at build; no bindings there. `dynamicParams = true` renders unlisted params on demand |
| Server Component `await fetch` | `export const loader = async (c) => ...` | result arrives as `props.data`; throw `notFound()` / `redirect()` from `cf-lite/navigation` |
| `loading.tsx`, `error.tsx`, `not-found.tsx` | `_loading.tsx`, `_error.tsx`, `_not-found.tsx` | `_loading` is React-only today |
| Server Actions, `<form action={fn}>` | `export const actions = { save }` and `<form method="post" action="?/save">` | works with JS off; CSRF (same-origin check) built in. [actions.md](actions.md) |
| `app/api/x/route.ts` | `server/api/x.ts` (Hono sub-app) | typed client via `hc<ApiType>` |
| `middleware.ts` + `config.matcher` | `server/middleware.ts` + `config.matcher` | glob syntax only (`:path*`, `!` exclusions); no regex groups, no `has`/`missing`. [middleware.md](middleware.md) |
| `next.config` redirects / rewrites / headers | `cfLite({ routeConf: defineRouteConf({...}) })` | compiled to `_redirects` / `_headers`; conditional rules become a Worker table. [route-config.md](route-config.md) |
| `revalidateTag` / `revalidatePath`, `export const revalidate` | `export const cache = { maxAge, swr, tags }` + `purgeTags()`; durable tier: `isr()` + `revalidateTag()` | per-colo Cache API, or R2 + Queue global copy. [caching.md](caching.md), [isr.md](isr.md) |
| `next/image` | `<Image>` from your adapter's `/image` entry + Cloudflare Images | [images.md](images.md) |
| `next/font` | `fonts({ family, ... })` Vite plugin | self-hosted, hashed, zero layout shift. [assets.md](assets.md) |
| `next/script` | `head.script` with `strategy` | [assets.md](assets.md) |
| `metadata`, `generateMetadata` | `head()` export + `seo({...})` | sitemap, robots, manifest, icons, `_og.tsx` OG images. [metadata.md](metadata.md) |
| `opengraph-image.tsx` | `_og.tsx` | rendered by a separate satori worker |
| i18n routing | `cfLite({ i18n })` + `[locale]` | path prefixes, detection only on `/`. [i18n.md](i18n.md) |
| `useRouter`, `<Link>` | `navigate`, `<Link to>` from `@cf-lite/<ui>/client` | hover prefetch. Typed `href()` ([typegen.md](typegen.md)) |
| `after()` | `after(fn)` from `cf-lite/modules/after` | `waitUntil` with error capture; not retried, use a Queue for must-not-lose work |
| Vercel Cron, background functions | `server/cron`, `server/queues`, `server/workflows` | [background-jobs.md](background-jobs.md) |
| `instrumentation.ts`, Sentry | `server/error.ts`, `logging()`, `sentry()`, OTel | [observability.md](observability.md) |
| NextAuth / Auth.js | `cf-lite/modules/session` + `oauth` | sealed cookie, KV, D1 or DO stores. [auth.md](auth.md) |
| `next dev` / `next build` / `next start` | `vite dev` / `cf-lite build` / `cf-lite deploy` | there is no `start`: workerd is the runtime, locally and in production |

## Not available

| Next.js | What to do |
|---|---|
| RSC, `"use server"` RPC | loaders + actions; client components are just your UI framework's components |
| Parallel / intercepting routes | nested layouts + query-string state |
| `getServerSideProps`, Pages Router | not supported |
| Edge Config, Speed Insights | KV / Analytics Engine + the Web Vitals `metrics()` beacon |
| PPR | not yet; a static shell plus a streamed SSR route is the closest shape |
| Running somewhere else | never; that is the trade for Workers-native behaviour |

## Porting a page, step by step

```tsx
// Next: app/blog/[slug]/page.tsx
export async function generateStaticParams() { return (await slugs()).map((slug) => ({ slug })); }
export async function generateMetadata({ params }) { return { title: (await post(params.slug)).title }; }
export default async function Page({ params }) { const p = await post(params.slug); return <article>{p.body}</article>; }
```

```tsx
// cf-lite: app/routes/blog/[slug].tsx
import { seo } from "cf-lite/modules/seo";
export const render = "static";                                            // or "ssr" + drop paths()
export const paths = async () => (await slugs()).map((slug) => ({ slug }));
export const loader = async (c) => post(c.req.param("slug"));              // runs at build for static pages
export const head = ({ data }) => seo({ title: data.title, path: `/blog/${data.slug}` });
export default function Page({ data }) { return <article>{data.body}</article>; }
```

1. Move each `page.tsx` to `app/routes/<url>.tsx`; turn `layout.tsx` into `_layout.tsx` (it receives `children`).
2. Replace top-level `await` data access with a `loader`; replace `"use client"` boundaries by nothing (every page renders with your adapter; hydration is per route: SSR pages hydrate, `static` pages ship zero JS).
3. Convert Server Actions into an `actions` map and a plain `<form method="post" action="?/name">`; add `enhance()` / `<Form>` only where you want fetch-based submits.
4. Move `route.ts` handlers into `server/api/*.ts` Hono sub-apps.
5. Port `middleware.ts`; rewrite regex matchers as positive globs plus `!` exclusions.
6. Move `next.config` redirects/rewrites/headers into `defineRouteConf`.
7. Swap data stores for bindings: `bunx cf-lite add d1|kv|r2`; `cf-lite types` types `Env`.
8. `cf-lite doctor`, then `cf-lite analyze` to compare bundle sizes.

Expect to re-do: anything relying on Node APIs beyond what workerd's `nodejs_compat` offers, ORMs that need a TCP driver (use D1 or Hyperdrive), and libraries that assume a filesystem at request time.

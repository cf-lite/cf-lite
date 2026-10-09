# cf-lite vs Next.js App Router: parity assessment

Assessed 2026-10-01 against cf-lite `main` @ `7a16ca1` (package 0.4.0, private, not on npm) and Next.js **16.3.x** (docs at nextjs.org/docs show 16.3.6/16.3.8;
16.3 released 2026-08-03). Method: every row below was checked in source and tests on `main`, not only in docs; `roadmap-1.0.md` is a plan whose
"missing" cells are mostly stale, so it was **not** used as evidence. Test run on that commit: `npx vitest run` = 60 files, **807 passed, 0 failed**
(one `realtime.test.ts` "forged token" failure appeared once in an earlier run on the pre-rebase tree and did not reproduce in 3 isolated re-runs or the full re-run:
treat as a flaky test, unverified cause).

Scope of the comparison: this is "what a team porting a Next.js app would miss", not "which is better". Next.js is the reference; cf-lite deliberately trades
generality for Cloudflare-native behaviour. Where Next.js is better, the notes say so.

Legend: **have** = shipped + tested; **partial** = works with a stated gap; **missing** = absent; **n/a** = deliberate non-goal (counted separately).

## 1. Feature table

### Routing and rendering

| Feature | Next.js 16 | cf-lite | Evidence | Notes |
|---|---|---|---|---|
| File routes, nested layouts, dynamic / catch-all / optional catch-all | yes | have | `src/scan.ts`, `test/scan.test.ts`, `test/route.test.ts` | catch-all needs >= 1 segment (as Next) |
| Route groups `(x)` | yes | have | `scan.ts:9,73` | may own a `_layout`; group-level `middleware` files not supported (`docs/routing.md`) |
| `loading.js` | yes | partial | `docs/routing.md` §`_loading` | React adapter only; Preact/Vue/Svelte ignore it |
| `error.js`, `not-found.js`, `notFound()`, `redirect()`, `permanentRedirect()` | yes | have | `src/navigation.ts`, `conventions/pages.ts`, `test/route.test.ts` | status is real before first flushed byte; after flush degrades to client recovery |
| `forbidden()` / `unauthorized()` + `forbidden.js` / `unauthorized.js` | yes | have | `src/navigation.ts`, `scan.ts` (`_forbidden`, `_unauthorized`, `.rsc` twins), `test/forbidden.test.ts` | real 403 / 401 before the first byte, nearest-directory boundary, plain-text fallback; static prerender and `render="static"` treat them as a build error; no `WWW-Authenticate` header added |
| `template.js` | yes | n/a | `docs/routing.md` "`template` and `default`" | not built: layouts stay mounted; remount by keying a subtree on the path. Documented rather than half-implemented per adapter |
| `default.js` | yes | n/a | `docs/routing.md` | only exists for parallel-route slots, which are a non-goal |
| Parallel + intercepting routes | yes | n/a | `docs/migration-from-nextjs.md` | stated non-goal; modal-over-list UIs must be re-modelled |
| React Server Components, `"use client"`, `"use server"` RPC | yes | n/a | `docs/migration-from-nextjs.md` | **the largest semantic gap**: no component-level server data (opt-in RSC covers it for React: `docs/rsc.md`); zero-JS interactive islands inside an SSR page now exist as `*.island.tsx` (see next row); loaders are per route (layout loaders were not found on main) |
| Partial hydration / client islands inside a server-rendered page | `"use client"` under RSC | **have (experimental, React + Preact + Vue)** | `docs/islands.md`, `docs/design/islands.md`, `src/islands*.ts`, `src/vite-islands.ts`, `test/islands.test.ts`, `e2e/islands.spec.ts` | `*.island.tsx` + `export const client = "load\|idle\|visible\|interaction"`; pages without islands ship no JS; JSON props only (no `children`); `*.island.vue` for Vue (`examples/site-islands-vue`, `e2e/islands-vue.spec.ts`); Svelte not attempted (blocker in `docs/islands.md`); Preact/compat runtime option measured 12.4 vs 70.3 KB gz |
| Streaming / Suspense SSR | yes | partial | React `renderToReadableStream` and Vue stream; Svelte one chunk (`README.md` adapters table) | `defer()` helper not implemented (`docs/routing.md` "left for later") |
| Partial Prerendering / Cache Components (`cacheComponents`, `use cache`, `cacheLife`, `cacheTag`) | yes (16) | missing | `docs/migration-from-nextjs.md` "PPR: not yet" | closest shapes: `render="static"` page, SSR + `cache`/`isr`. No static shell + dynamic holes in one response |
| Instant navigations / `<Link>` prefetch / `useLinkStatus` | yes | partial | `src/client.ts:40` `prefetch`, React `Link prefetch="intent"` | hover prefetch of route modules only; no viewport prefetch, no SSR-payload prefetch, no pending-link hook |
| `useRouter`, `useParams`, `usePathname`, `useSearchParams`, `useSelectedLayoutSegment` | yes | partial | `packages/react/src/client.ts` exports `navigate`, `useParams`, `Link`, `mount` only | no `usePathname`/`useSearchParams`/segment hooks: read `location` yourself |
| View Transitions | yes (experimental flag) | **have (experimental)** | `src/vite-view-transitions.ts`, `withViewTransition` in `src/client.ts`, `test/view-transitions.test.ts`, `scripts/view-transitions-e2e.mjs`, `docs/view-transitions.md` | `viewTransitions: true` = cross-document `@view-transition` in the shell; `{ router: true }` also wraps SPA navigations; reduced-motion respected; **not** on `render="rsc"` pages (React document, no shell) |
| Typed routes (`typedRoutes`) | yes | have | `src/conventions/typegen.ts`, `src/href.ts`, `test/typegen.test.ts` | typed `href()`, `Link to`, loader data |
| `generateStaticParams` | yes | have | `export const paths`, `test/prerender.test.ts` | runs in Node at build, no bindings there |
| Draft Mode (`draftMode()`) | yes | have | `modules/draft.ts`, `docs/draft-mode.md`, `test/draft.test.ts`, `scripts/draft-e2e.mjs` | `draft()` + `draftRoutes()` (sealed `__cfl_preview` cookie), `isDraft(c)`; cache/ISR bypass, `private, no-store`, `/__preview/*` for prerendered pages, CMS iframe `frameAncestors`. (This row said "missing" in the first assessment although #32/#35 had landed: corrected 2026-10-02) |

### Data, caching, mutations

| Feature | Next.js 16 | cf-lite | Evidence | Notes |
|---|---|---|---|---|
| Server data fetch | `await` in server components | have (per route) | `loader(c)`, `docs/routing.md` | one loader per page; no layout-level loaders |
| Server Actions / `<form action>` with progressive enhancement | yes | have | `src/modules/actions.ts`, `form.ts`, `test/actions.test.ts`, `e2e/actions.spec.ts` | `?/name` POST, works without JS, CSRF built in, body cap (fixed in F1, `docs/rc-status.md`); React/Preact components only, others use `enhance()` |
| Route handlers | `route.ts` | have | `server/api/*.ts` Hono, typed `hc` client | |
| Time/tag/path revalidation (`revalidateTag/Path`, `export const revalidate`) | yes | have (different shape) | `modules/cache.ts` (Cache API + KV/D1 tag ledger), `modules/isr.ts`, `test/cache.test.ts`, `test/isr.test.ts`, `scripts/cache-e2e.mjs`, `isr-e2e.mjs` | Cache API tier is **per-colo and does nothing on `*.workers.dev`** (`docs/caching.md:114`); durable tier = R2 + Queue |
| ISR for pages | yes | have | `export const isr`, `examples/site-isr-route`, `scripts/isr-route-e2e.mjs` | needs R2 + Queue bindings; regen only for `isr()`-guarded routes; no post-deploy pre-warm |
| `updateTag` (read-your-writes), `refresh()` | yes | **have (different shape)** | `updateTag` / `updatePath` in `modules/cache.ts`, `updateTag` in `modules/rsc-update.ts`, `refresh()` in `client.ts`, `test/update-tag.test.ts`, `docs/caching.md` | `updateTag(c, tags)` = purge + 60 s cookie that makes the writer bypass cache/ISR (the KV ledger takes 30-60 s to reach other colos); `refresh()` re-fetches the RSC payload / re-renders an SPA route / reloads a document. Needs the tag ledger bound |
| `unstable_cache` / data cache | yes | partial | `modules/kv-cache.ts` `cached()` | KV is eventually consistent (~60 s) |
| `after()` | yes | have | `modules/after.ts` | `waitUntil` + error capture, not retried |
| Middleware / `proxy.ts` | yes | have | `conventions/middleware.ts`, `test/middleware.test.ts`, `scripts/middleware-e2e.mjs`, F2 fix | matcher globs only (no regex, no `has`/`missing` in matcher); **better than Next**: unmatched paths never wake the Worker |
| `next.config` redirects / rewrites / headers (incl. `has`) | yes | have | `modules/routeconf.ts`, `docs/route-config.md`, `test/routeconf.test.ts` | compiled to `_redirects`/`_headers`; conditional rules go through the Worker |
| i18n routing | no built-in in App Router (docs say implement via proxy) | have | `modules/i18n.ts`, `test/i18n.test.ts`, `scripts/i18n-e2e.mjs`, `examples/site-i18n` | path-prefix only; detection on `/` only; no domain locales |
| Cookies / headers APIs, `connection()`, `userAgent` | yes | have (Hono) | `c.req`, `hono/cookie` | no special API needed; not a separate feature |

### Assets, metadata

| Feature | Next.js 16 | cf-lite | Evidence | Notes |
|---|---|---|---|---|
| `next/image` | yes | have | `modules/images.ts`, `vite-images.ts`, `e2e/images.spec.ts`, `test/images.test.ts` | backends: `/cdn-cgi/image` (custom zone), `IMAGES` binding, build-time sizes. Allow-list of hosts. Needs the paid Cloudflare Images plan beyond free quota |
| `next/font` | yes | have | `src/vite-fonts.ts`, `test/fonts.test.ts`, `e2e/fonts.spec.ts` | self-hosted, hashed, preload, size-adjust |
| `next/script` | yes | have | `head.script` `strategy` | no `worker` (Partytown) strategy |
| Metadata API, `generateMetadata` | yes | have | `src/head.ts`, `modules/seo.ts`, `test/metadata.test.ts`, `test/head.test.ts` | |
| `sitemap`, `robots`, `manifest`, icons | yes | have | `modules/sitemap.ts`, `conventions/metadata.ts`, `test/icons-plugin.test.ts` | dynamic sitemap with index splitting |
| `ImageResponse` / `opengraph-image` | yes | have (experimental) | `_og.tsx`, `modules/og.ts`, `packages/cf-lite/og-worker`, `scripts/metadata-e2e.mjs` | separate satori worker; no `generateImageMetadata` |
| `<Form>` component | yes | partial | `modules/form.ts`, react/preact `form.test.ts` | |
| CSS Modules / Tailwind / MDX | yes | partial | Vite native for CSS/Tailwind; `cf-lite add tailwind` | no first-party MDX integration found (`@next/mdx` has no counterpart; Vite MDX plugin is DIY) |
| Bundling: Turbopack, React Compiler | yes | n/a | Vite 8 | React Compiler via Babel plugin is DIY |

### Auth, security, ops

| Feature | Next.js 16 | cf-lite | Evidence | Notes |
|---|---|---|---|---|
| Auth libraries (Auth.js, Clerk, Better Auth, Supabase, WorkOS...) | large ecosystem, official guides | partial | `modules/session.ts`, `oauth.ts`, `sso.ts`, `turnstile.ts`, `cf-lite add auth`, `test/session.test.ts`, `test/oauth.test.ts` | first-party sealed-cookie/KV/D1/DO sessions + OAuth/PKCE; **no passkeys, no magic link, no third-party SDK is documented to work**. Auth.js on Workers is possible but untested here |
| CSP / security headers | manual | have | `modules/csp.ts`, `vite-security.ts`, `scripts/security-e2e.mjs` | nonce CSP incl. SSR; **better than Next default** |
| Rate limiting | none built-in | have | `modules/ratelimit.ts` | not wired into the auth scaffold (`rc-status.md` J5) |
| Observability: `instrumentation.ts`, OpenTelemetry, error reporting | yes | have (experimental OTel) | `modules/log.ts`, `otel.ts`, `error.ts`, `metrics.ts`, `test/obs.test.ts` | |
| Cron / background / queues / workflows | Vercel-only or external | have | `server/cron|queues|workflows`, `test/jobs.test.ts`, `scripts/jobs-e2e.mjs` | **better than Next** (platform-native); Queues work on the free plan with limits (`docs/isr.md`) |
| Realtime (WebSocket) | no first-party | have (experimental) | `modules/realtime.ts`, `client-realtime.ts`, `test/realtime.test.ts`, `scripts/realtime-e2e.mjs` | hibernating Durable Object rooms; **better than Next**, which has no WebSocket story on serverless |
| Storage (D1, KV, R2 presign, Hyperdrive, Vectorize), AI Gateway | Vercel marketplace / DIY | have | `modules/d1|kv|r2|hyperdrive|vectors|ai.ts`, `test/storage*.test.ts`, `test/ai.test.ts` | `r2-runtime.test.ts` on main |
| Analytics / Speed Insights | Vercel | partial | `modules/metrics.ts` (Web Vitals beacon -> Analytics Engine) | no dashboard UI |

### DX, tooling, ecosystem

| Feature | Next.js 16 | cf-lite | Evidence | Notes |
|---|---|---|---|---|
| Dev server + HMR | Turbopack (stable, FS cache) | have | `vite dev` + workerd, `scripts/dev-e2e.mjs` | real workerd locally (DO, bindings): **better than `next dev` for Workers parity**; Turbopack is faster on very large apps (no benchmark here) |
| Devtools overlay, error overlay, route indicator, MCP server for agents | yes | partial | Vite error overlay only; `cf-lite doctor` (`docs/doctor.md`) | no in-browser devtools, no MCP server |
| Scaffold / templates | `create-next-app` | have | `packages/create-cf-lite`, `scripts/scaffold-e2e.mjs` (6 templates, 7 UIs), `cf-lite add rsc` (`test/add-rsc.test.ts`) | not on npm yet |
| Testing | docs + Playwright/Jest/Vitest guides | have | `packages/testing` (vitest-pool-workers), `packages/playwright` | open gaps in field notes: service bindings can't boot in `@cf-lite/testing` |
| Codemods / upgrade | `@next/codemod` | partial | `src/upgrade/`, `docs/upgrading.md` | few versions of history |
| Bundle analysis | yes | have | `cf-lite analyze`, `bench/module-sizes.json` size budget in CI | |
| Static export | yes | have | `render="static"` | |
| Hosting portability (Node, Docker, adapters API, Vercel, Netlify...) | **yes** | n/a | | cf-lite = Cloudflare only. Next.js also runs on Workers via OpenNext (larger bundle) |
| Vercel-only (Edge Config, Blob, Analytics, Fluid compute, skew protection) | Vercel | n/a | | Cloudflare equivalents exist as bindings; no skew-protection equivalent (assets are immutable per deploy; stale-client mismatch handled how? not found in source: unverified) |
| UI library support | React only | have | adapters for React/Preact/Vue/Svelte + htmx | **better than Next** if you are not React; React ecosystem libs that need RSC will not work |
| Community, docs volume, hiring, third-party tutorials, StackOverflow | enormous | **missing** | | 0.x, small team. This is the dominant risk for anything long-lived |
| Maturity / production proof | years, huge deployments | partial | [field-notes.md](field-notes.md): 3 ports | `rc-status.md`: >= 3 apps x 30 days gate still **open** |

## 2. Counts

Counting table rows above (a row with a slash-list is one row; n/a rows are non-goals):

| Status | Count |
|---|---|
| have | 37 |
| partial | 12 |
| missing | 2 |
| n/a (deliberate non-goal) | 7 |
| total rows | 58 |

Missing (2): **PPR / Cache Components**, **community & ecosystem**. Closed since the first assessment (2026-10-02, `feat/next-parity-2`): `forbidden()/unauthorized()`, View Transitions, `updateTag/refresh`; `template.js` and `default.js` moved to n/a (documented, see `docs/routing.md`); Draft Mode was already shipped (row corrected).
n/a rows (7): RSC + `"use server"` RPC, parallel + intercepting routes, `template.js`, `default.js`, bundler (Turbopack/React Compiler), non-Cloudflare hosting, Vercel-only services.

## 3. Where Next.js is plainly better

1. **RSC + Cache Components/PPR.** Component-level server data and per-component caching in one streamed response; cf-lite has per-route loaders and whole-page caching. For pages with a mostly static shell and one personalised hole, Next.js can do it in one request; cf-lite needs a client fetch or two requests.
2. **Ecosystem.** Auth.js/Clerk/WorkOS guides, CMS SDKs (including Optimizely's official one, which peers on `next`), shadcn, analytics SDKs, hiring pool, answers on the web. cf-lite has one maintainer team and zero outside users.
3. **Draft Mode** is a first-class `draftMode()` in Next.js; cf-lite has an equivalent (`cf-lite/modules/draft`) but it is newer and less exercised (it matters for every CMS head).
4. **Portability.** Next.js can leave Cloudflare; cf-lite cannot, by design.
5. **Navigation polish:** viewport prefetch, instant navigations, `useLinkStatus`, `usePathname`/`useSearchParams`, parallel/intercepting routes (View Transitions now exist, opt-in).
6. **Dev tooling:** devtools overlay, MCP server, Turbopack at scale.
7. **Track record:** years of production at scale vs. its unit tests and three ports.

## 4. Where cf-lite is better (evidence, with caveats)

* Static and redirect paths are answered by the assets layer with **no Worker invocation** (`scripts/e2e.mjs` signature checks; `docs/middleware.md`). Next+OpenNext runs middleware on every request.
* Worker size 7-74 KiB gz vs ~915 KiB for Next+OpenNext (`README.md`, `bench/RESULTS-live.md`); cold start +27..45 ms vs +261 ms (older run). The README itself notes a prerendered static page is **+6..10 ms slower** on the real network than a bare Worker; claims are size/CPU, not warm latency.
* Platform primitives as conventions: cron, queues, workflows, Durable Object realtime, R2 presign, ISR on R2.
* Non-React UI frameworks.

## 5. Honest overall reading

cf-lite covers roughly the **Pages-Router-with-loaders/actions class** of Next.js apps very well and is missing the RSC-era half of App Router. The routing, caching,
forms, i18n, images, fonts, metadata, middleware and ISR surface is real and tested, not aspirational. What it will never match is the ecosystem and the
Vercel-hosted DX; what it has not yet earned is production time (RC gates 2.6-2.7 open, `docs/rc-status.md`). Treat as "ready for internal tools and
content sites a team owns end to end", not "drop-in Next replacement".

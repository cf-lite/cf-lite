# cf-lite roadmap to 1.0

> **History plus plan, not a status line.** Written 2026-09-30; sections 1-4 are the plan as proposed then. Where it disagrees with [DECISIONS.md](DECISIONS.md) the decision wins: the version train is 0.4.x with no rc naming ([D-001](DECISIONS.md#d-001-release-train-is-04x-no-10-yet)); there is no fixed pre-1.0 soak or review date, so any "RC1", "6-8 weeks" or "30 days" target below is an estimate of effort, not a schedule ([D-002](DECISIONS.md#d-002-no-10-is-scheduled-the-pre-10-soak-review-date-is-not-fixed)); seven packages are on npm at 0.4.0 ([D-006](DECISIONS.md#d-006-seven-packages-are-published-to-npm-at-040-the-owner-authorises-every-publish-bump-and-tag)). The gate audit is in [rc-status.md](rc-status.md).

Status of this doc: architect proposal, written 2026-09-30 against `main` at 0.4.0 (+ in-flight work at that date: SSR edge caching `modules/cache`, a hub-style app port, the docs site `site/`). Nothing here is committed scope until the owner picks the first wave (section 4.5).

**Direction (the owner):** stay hard on Cloudflare. Bring over every Next.js capability that matters in real apps, implemented the Cloudflare-native way
(use the platform's strengths instead of emulating Vercel), and reach a production-ready 1.0.

## 0. Principles (what "Cloudflare-native" means here)

1. **Static traffic never wakes the Worker.** Anything that can be answered by the assets layer (`_redirects`, `_headers`, prerendered HTML, hashed assets) stays there.
   Every feature below must state which requests it adds to `run_worker_first`, and default to *zero new* Worker-first globs unless the feature is impossible otherwise.
2. **Use the binding, don't abstract it.** Images -> `IMAGES` binding, cache -> Cache API + tags, sessions -> KV/D1/DO, jobs -> Queues/Workflows/Cron, realtime -> Durable Objects.
   cf-lite supplies conventions, typed helpers and codegen; it does not invent a portable layer. No `if (vercel)` shims, no Node polyfill zoo.
3. **Build time over request time.** Conventions are compiled by the Vite plugin into plain Hono/TypeScript (as today). No runtime router package between the app and workerd.
4. **Opt-in and tree-shakeable.** A feature you don't import costs 0 bytes in the Worker (`sideEffects: false`, separate `cf-lite/modules/*` entries; keep the 7 KiB API-only Worker honest — a perf budget, section 2).
5. **Wrangler config stays the source of truth for bindings.** cf-lite may *check* it (`cf-lite doctor`) and *edit it on explicit `cf-lite add <x>`* (idempotent, jsonc-preserving), never silently rewrite it on build.
6. **Not chasing Next for its own sake.** RSC, parallel/intercepting routes, and Vercel-only features (Edge Config, Speed Insights) are explicitly out (section 1.15).

Legend — status: **have** (shipped, tested), **partial** (works but gap noted), **missing**. `WP-x` = work package in section 3. "Core" = touches `packages/cf-lite/src/{scan,generate,server,vite,client,prerender,cli}.ts`.
Claims about Cloudflare product limits/pricing are marked *(verify)* where they must be re-checked against current docs before we write them into user docs; do not copy them into README unchecked.

---

## 1. Capability matrix: Next.js (App Router, current stable) -> cf-lite -> Cloudflare-native design

### 1.1 Routing

| Next.js capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Pages, nested layouts (`layout.tsx`) | `app/routes/**`, nested `_layout.tsx`, persists across SPA navs | have | — | — |
| Dynamic `[id]`, catch-all `[...rest]` | have for SPA/SSR; `static` + `[param]` is a build error | have / partial | Add `generateStaticParams`-equivalent: `export const paths = async () => [...]` evaluated in the build-time prerender (Node, can read D1 via `wrangler` local/remote API or a JSON file); params not listed fall through to SSR (`dynamicParams`) or 404. Prerendered files live in assets -> Worker not invoked | WP-ROUTE |
| Optional catch-all `[[...x]]` | no | missing | Scanner + matcher support; maps to two globs | WP-ROUTE |
| Route groups `(marketing)` | no (design.md says unsupported) | missing | Directory name in parens is stripped from URL, may own a `_layout` and `middleware`; pure scan change, no runtime impact | WP-ROUTE |
| `loading.tsx` (Suspense boundary) | React/Vue stream; no convention file | partial | `_loading.tsx` per directory wraps the page in the adapter's Suspense/boundary at compose time (SSR streams shell + fallback; SPA shows it while modules/loader data load). Cloudflare angle: SSR flushes the shell immediately (workerd streams), so TTFB is not loader-bound | WP-ROUTE |
| `error.tsx` (error boundary) | none: a throwing SSR loader = generic 500; SPA = blank | missing | `_error.tsx` per directory: adapter error boundary for render errors + loader errors route to it with `{ error, digest }`; digest = request id logged to Workers Logs (WP-OBS). Never leak stack to client in production | WP-ROUTE |
| `not-found.tsx`, `notFound()` | SPA client 404 view; `404.html` when `/` is static; no SSR `notFound()` | partial | `_not-found.tsx` convention; `notFound()` helper throws a typed sentinel caught by `ssr()` -> 404 status with the page rendered (streaming not yet started, so status is still settable; after flush it degrades to meta noindex + client redirect). Static 404 is the assets layer's `404.html` | WP-ROUTE |
| `redirect()`, `permanentRedirect()` in loaders | none | missing | Sentinel throws, `ssr()` converts to `Response.redirect` before first byte | WP-ROUTE |
| Middleware (`middleware.ts`, `matcher`) | DIY in user `server/worker.ts` (`root.use` then `root.route`) | partial | `server/middleware.ts`: `export default` Hono middleware + `export const config = { matcher: [...] }`. Matcher globs are **appended to `assets.run_worker_first`** (with `!negative` patterns for exclusions), so non-matching paths never invoke the Worker — this is the Cloudflare-native advantage over Next/OpenNext where middleware runs on every request. Broad matcher (`/*`) = "gated site" mode already proven by Project A. Generated app applies it before `/api/*` and SSR routes. Verify `run_worker_first` array/pattern count limits *(verify)*; above the limit fall back to `["/*", "!<static prefixes>"]` | WP-MIDDLEWARE (core) |
| Redirects / rewrites / headers in `next.config` | `public/_redirects` passthrough only; `_headers` passthrough | partial | `cf-lite.config.ts` (or `cfLite({ redirects, headers, rewrites })`) **compiled at build** to `_redirects` (static, dynamic-splat, placeholders; assets-layer limits *(verify: 2,000 static + 100 dynamic redirects, 100 header rules)*) and `_headers`. Conditional rules (`has: cookie/header/host`) and rewrites to other origins cannot be expressed in `_redirects`: those compile to Worker-first globs + a generated Hono handler. Overflow beyond assets limits: emit a report and suggest account-level Bulk Redirects (zone feature) — no automatic API calls. `vite dev` now applies the same table (today `_redirects` is not applied in dev) | WP-ROUTECONF (core-light) |
| i18n routing (`/vi`, `/en`, locale detection) | none | missing | Path-prefix locales via a route-group-like `[locale]` segment + `cf-lite.config` `i18n: { locales, default }`. Detection happens **only on `/` and unprefixed paths**, as a single Worker-first glob set, from `Accept-Language` + cookie + (optional) `request.cf.country`; prefixed pages are static/SSR as usual. Message catalogs are plain JSON imported per locale (tree-shaken per route). `hreflang` alternates auto-injected into `head`, sitemap emits per-locale entries. No domain-based locales in 1.0 (needs zone routes) | WP-I18N (core) |
| `<Link>` prefetch, `useRouter`, `usePathname`, `useSearchParams` | `Link`, `navigate`, `useParams` per adapter; no prefetch | partial | Hover/viewport prefetch of route modules (`modulepreload`) and, for SSR routes, optional HTML-fragment prefetch through Cache API. Typed `href()` (see 1.17) | WP-ROUTE + WP-TYPEGEN |
| Parallel / intercepting routes, `template.tsx`, `default.tsx` | no | out | Out of scope for 1.0 (complexity/value ratio); documented escape hatch = nested layouts + query-param state | — |
| `app/api/**/route.ts` handlers | `server/api/*.ts` Hono sub-apps | have | See 1.6 | — |

### 1.2 Data: loaders, mutations, caching, streaming

| Next.js | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Server data fetching in components (RSC `await`) | `loader(c)` on SSR routes, result as `props.data`; none for static/SPA | partial | Keep loader model (no RSC). Add: `loader` on `static` routes evaluated at build (feeds prerender, e.g. reads D1/R2 via local bindings or `fetch`); layout-level `loader`s (opt-in, parallelised with the page loader: `Promise.all`) | WP-ROUTE |
| Server Actions / `<form action>` with progressive enhancement | none (mutations = Hono routes) | missing | Route file exports `actions = { save: async (formData, c) => ... }`. Compiled to `POST <route>?/save` -> handled in the Worker with no-JS semantics: form posts, Worker runs action, **303 redirect or re-render with `actionData` + field errors** (works without JS, cacheable pages unaffected). JS enhancement (`@cf-lite/<ui>/form`): fetch + router soft-navigate + pending state + optimistic hook. **CSRF built in**: `Origin`/`Sec-Fetch-Site` check (same-origin only) + SameSite=Lax cookies; token double-submit only when the route opts into cross-origin embeds. Zod/valibot-agnostic validator hook. Files via `multipart/form-data` streamed to R2 (1.8) | WP-ACTIONS (core) |
| `revalidatePath` / `revalidateTag` | `modules/cache` in flight (0.5): Cache API + tag ledger (KV or D1), `swr` emulated, purge O(1) write | partial (in flight) | Finish 0.5 as baseline; 1.0 adds: `revalidateTag/Path` typed helpers callable from actions/webhooks/queues; **global** purge option via Cloudflare Cache Purge API with `Cache-Tag` headers (custom domain only, token secret) *(verify plan availability of tag purge)*; `cf-lite-revalidate` admin route guarded by `CACHE_PURGE_TOKEN`; metrics (hit/miss/stale) to Analytics Engine | WP-CACHE (finish cfisr) |
| ISR for *pages* (static HTML regenerated) | none | missing | Two tiers. (a) SSR + edge cache (0.5) = per-colo ISR — cheap, good default. (b) **"Durable static"**: regenerated HTML written to **R2** (`/_isr/<key>`), served by the Worker via `env.R2.get` (+ edge cache in front); regeneration triggered by tag purge -> **Queue message** -> consumer re-renders and writes R2. Global consistency without redeploy. Workers static assets remain immutable per deploy (by design) | WP-ISR (after WP-CACHE) |
| `unstable_cache` / `use cache` data cache | `kv-cache` `cached()` | partial | `cached()` on KV with tags shared with the page-tag ledger; D1/DO variants; request-coalescing in a DO for stampede control (opt-in) | WP-CACHE |
| Streaming / Suspense | React, Vue stream; Svelte one chunk | have | Document; add `defer()` loader helper (return promises, stream resolved values) for adapters that support it | WP-ROUTE |
| PPR (partial prerendering) | no | future | Native shape exists: static shell from assets + SSR "holes". Research spike post-1.0 (needs client-side stitching or Worker-side shell fetch via `ASSETS.fetch`) | backlog |
| `after()` | Hono `c.executionCtx.waitUntil` (untyped habit) | partial | `after(fn)` helper bound to the request `ExecutionContext` + error capture; documented limits (30 s-class wall budget after response *(verify)*) | WP-JOBS |
| Draft mode / preview | none | missing | Signed cookie `__cfl_preview` bypasses Cache API/ISR tiers and exposes draft loaders; toggle routes generated | WP-CACHE |

### 1.3 Assets: images, fonts, static files, scripts

| Next.js | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| `next/image` optimization | none (Vite asset pipeline only) | missing | `@cf-lite/<ui>` `<Image src width height sizes priority>` emits `srcset` + intrinsic dimensions (no CLS) + `loading`/`fetchpriority`. Three backends selected by config: (1) **`/cdn-cgi/image/...` URL transformations** on a custom domain zone with Images transformations enabled — zero Worker CPU, cached at the edge; (2) **`IMAGES` binding** for workers.dev or private sources (R2): generated `GET /_img` route: `env.IMAGES.input(stream).transform({width,...}).output({format})`, result cached via Cache API; (3) build-time sharp-free pre-sizing for static assets (Vite plugin emits variants; nothing at runtime). Allow-list of remote hosts/R2 buckets (SSRF guard), size whitelist (prevents cache-busting abuse), AVIF/WebP via `Accept`. Limits/pricing for transformations *(verify, may need paid Images plan: the owner)* | WP-IMAGES |
| `next/font` (self-hosted, no layout shift) | none; user adds CSS | missing | Vite plugin `fonts({ family: "Inter", source: "fontsource"|"google"|local, weights, subsets })`: **downloads/subsets at build time** (fontsource npm packages preferred: offline, deterministic), emits hashed `woff2` (immutable via default `_headers`), injects `<link rel=preload as=font crossorigin>` into head + `@font-face` with `size-adjust` fallback metrics. No runtime fetch from Google | WP-ASSETS |
| Static assets / `public/` | assets layer, `_headers` | have | Default `_headers` generated: `/assets/*` immutable 1y, HTML `must-revalidate` | WP-ASSETS |
| `next/script`, `<Script strategy>` | none | missing | Head `script` entries with `strategy: "defer"|"idle"|"worker"` — Partytown-free: defer/idle only; CSP-nonce aware (see 1.14) | WP-ASSETS |
| CSS modules / Tailwind / global CSS | Vite native | have | Document Tailwind 4 recipe + `cf-lite add tailwind` | WP-DX |
| Bundle analyzer | none | missing | `cf-lite analyze`: per-route client JS + Worker size report (builds on existing `bench/` size scripts) | WP-DX |

### 1.4 Metadata

| Next.js | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| `metadata` / `generateMetadata` | `head` object or `({params,data})` function, merged across layouts, works zero-JS | have | Add `jsonLd`, `openGraph`/`twitter` sugar that expand to meta tags; canonical helper (`absoluteUrl` from `SITE_URL` env) | WP-METADATA |
| `opengraph-image.tsx` (dynamic OG) | none | missing | Convention `app/routes/**/_og.tsx` (JSX -> image). Runtime: **satori + resvg-wasm** in a *separate Worker entry / service binding* so the wasm (>1 MiB) never bloats the main Worker (Worker size limit applies *(verify: 3 MiB free / 10 MiB paid, gzipped)*). Result cached in Cache API + optionally R2 keyed by params hash; `Cache-Control: immutable` when params are content-hashed. Alternative backend documented: Browser Rendering binding (heavier, paid). Fonts come from 1.3 build-time fonts | WP-METADATA (needs WP-ASSETS fonts; core-light) |
| `sitemap.ts`, `robots.ts`, `manifest.ts` | hand-written files in `public/` | missing | **Static routes**: sitemap generated at build from the route table (+ `paths()` results). **Dynamic** (D1-backed): `server/sitemap.ts` exporting `async () => entries`, served from the Worker with edge cache + `lastmod`; sitemap-index splitting at 50k URLs. `robots`/`manifest` typed, emitted as static files at build. `noindex` automatically for preview URLs (`*.workers.dev` previews) | WP-METADATA |
| `favicon`/`icon`/`apple-icon` file conventions | manual `<link>` | missing | Scan `app/icon.*`, emit hashed copies + head links | WP-METADATA |

### 1.5 Auth and sessions

| Next.js (ecosystem: Auth.js, Clerk, iron-session) | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Cookie sessions | none (`sso` is verify-only JWT cookie) | missing | `cf-lite/modules/session`: two stores behind one API — **stateless sealed cookie** (AES-GCM via WebCrypto, key rotation list, <4 KB) and **KV/D1/DO-backed** (session id in cookie; KV for read-heavy, D1 for admin/listing, DO for strict consistency/instant revoke). `getSession(c)`, `session.set/destroy/rotate`, sliding expiry, `__Host-` cookie prefix, SameSite=Lax default, CSRF integration with actions | WP-AUTH |
| OAuth / OIDC login | none | missing | Helpers for authorization-code + PKCE (GitHub, Google, generic OIDC) built on `fetch` + WebCrypto; account linking tables shipped as a D1 migration template (`cf-lite add auth`) | WP-AUTH |
| Passkeys / magic link / email OTP | none | missing | Magic link/OTP through Email Service / Workers `send_email` binding *(verify current email-sending product and plan)* + Turnstile; WebAuthn (passkeys) as stretch — 1.1 | WP-AUTH (stretch) |
| Org SSO gate | `modules/sso` verify-only Ed25519 cookie, `requireSso`, `readSso`, `ssoLoginUrl` | have | Keep; document interop with `session` (SSO is "identity from elsewhere", session is "our own") | — |
| Bot protection | none | missing | `cf-lite/modules/turnstile`: server `verify(token, ip)`, form widget component per adapter, action integration (`turnstile: true`), fails closed; test keys in dev | WP-AUTH |
| Test login bypass | `modules/e2e-login` | have | Extend to session module | WP-AUTH |

### 1.6 APIs

| Next.js | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Route handlers (`route.ts`, GET/POST, streaming) | `server/api/*.ts` (Hono) | have | Also allow non-`/api` handlers under `server/routes/**` (e.g. `/feed.xml`, `/og/*`) with the same scan + Worker-first glob mechanism | WP-ROUTE |
| Typed RPC (tRPC-like) | `hc<ApiType>` from `.cf-lite/app.ts` | have | Keep Hono RPC as the answer; add `zValidator` recipe, typed error shape, `@cf-lite/<ui>/query` thin hooks (optional, TanStack Query recipe doc rather than code) | WP-API |
| OpenAPI | none | missing | Optional `@hono/zod-openapi` recipe + `cf-lite openapi` export; not core | WP-API |
| Webhooks | hand-rolled | missing | `cf-lite/modules/webhook`: signature verifiers (HMAC-SHA256 generic, Stripe, GitHub, Svix-style) with constant-time compare + timestamp tolerance, **idempotency** via D1/KV dedupe key, and "verify -> enqueue to Queue -> 200" pattern so the provider never waits on your work | WP-API (+ uses WP-JOBS queues) |
| CORS, body limits, JSON errors | per-app | partial | `cf-lite/modules/http` helpers (`cors`, `bodyLimit`, `problemJson`) — mostly re-exports/recipes of `hono/*` | WP-API |

### 1.7 Background work

| Next.js / Vercel | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Cron (`vercel.json` crons) | user `scheduled()` in `server/worker.ts` (demo) | partial | `server/cron/<name>.ts`: `export const schedule = "*/15 * * * *"; export default async (ev, env, ctx)`. Generated dispatcher `scheduled()` by `ev.cron`; `cf-lite doctor` diffs `triggers.crons` in wrangler against the files (and `cf-lite add cron` edits it) | WP-JOBS |
| Queues | none | missing | `server/queues/<name>.ts`: `export default { batch handler, retry/DLQ config }`; generated `queue()` multiplexer by `batch.queue`; **typed producer** `queues.<name>.send(msg)` via codegen of message types (zod optional); DLQ + `retryDelay` helpers; local dev through miniflare | WP-JOBS |
| Workflows (durable multi-step) | none | missing | `server/workflows/<name>.ts` exporting a `WorkflowEntrypoint` class; generated re-export for the Worker entry + typed `workflows.<name>.create({params})`/status; recipes: ISR regeneration, signup onboarding, report export | WP-JOBS |
| `waitUntil` / `after` | raw | partial | `after()` (see 1.2) | WP-JOBS |
| Email handler (`email()`) | none | missing | `server/email/*.ts` convention for inbound Email Routing; shares handler generator | WP-JOBS (stretch) |
| Wrapper entry generation | `server/worker.ts` fully user-owned | have | Generate `.cf-lite/handlers.ts` exporting `{ queue, scheduled, email }` the user spreads into their default export; stays optional | WP-JOBS (core-light) |

### 1.8 Realtime and storage

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| WebSockets / realtime | demo `Room` Durable Object + WS, works in dev and prod | have (example only) | `cf-lite/modules/realtime`: `HibernatingRoom` base class (WebSocket Hibernation API: `acceptWebSocket`, tags, `webSocketMessage/Close`, attachment state, alarm-based heartbeat), `broadcast(tag, msg)`, presence, typed message protocol; client `connectChannel()` (framework-free) with auto-reconnect + backoff + resume token; `server/do/*.ts` convention + generated re-exports; `cf-lite add do` writes the `durable_objects` + `migrations` (SQLite-backed classes) wrangler entries | WP-REALTIME |
| D1 | `modules/d1` thin wrapper | partial | Migrations workflow: `cf-lite db new|apply|status` wrapping `wrangler d1 migrations` (local + remote, **refuses remote apply without `--yes`**); typed rows via codegen from migration SQL or recommend Drizzle/Kysely (recipe, not dependency); **D1 Sessions API** (`withSession`, bookmark cookie) for read replicas *(verify GA status)*; `Smart Placement` guidance | WP-STORAGE |
| KV | `kv-cache` `cached()` | partial | typed `kv<T>(ns)` with JSON + `expirationTtl` + list pagination helpers; clear docs on eventual consistency (~60 s) and when to use D1/DO instead | WP-STORAGE |
| R2 uploads / signed URLs | none | missing | `cf-lite/modules/r2`: (a) proxy-streamed upload through the Worker with size/type limits (fine <100 MB body limit *(verify plan body limit)*), (b) **presigned PUT/GET URLs** via S3 API (aws4fetch; needs R2 access-key secrets), (c) multipart resumable helper, (d) range/conditional `GET` handler with correct `ETag`/`Cache-Control`/`Content-Disposition`, (e) image pipeline hook into 1.3 | WP-STORAGE |
| Hyperdrive (external Postgres/MySQL) | none | missing | `cf-lite/modules/hyperdrive`: connection helper for `postgres`/`pg` per-request client with correct close-in-`waitUntil`; recipe + `cf-lite add hyperdrive` wrangler edit | WP-STORAGE |
| Durable Object as data layer (SQLite) | user code | partial | Recipe + `defineDO` base with typed SQL helper and migrations-by-version | WP-REALTIME |

### 1.9 AI

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Workers AI | none | missing | `cf-lite/modules/ai`: typed `ai.run(model, input)` with AI Gateway routing by default (caching, rate limit, logs, fallback), **SSE streaming helper** that maps to `ReadableStream` + `useChat`-style client hook per adapter (optional), structured output validation | WP-AI |
| AI Gateway | none | missing | Config key `AI_GATEWAY_ID` -> all `ai.run` and OpenAI-compatible `fetch` go through `gateway.ai.cloudflare.com`; per-user cache keys, `cf-aig-*` headers typed | WP-AI |
| Vectorize / embeddings / RAG | none | missing | `vectors(index)` helper: `upsert/query` with batching (limits *(verify)*), `embed()` via Workers AI, chunking util, optional AI Search (AutoRAG) wrapper *(verify GA)*; a `cf-lite add ai-chat` template (route + action + stream) | WP-AI |

### 1.10 Observability

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Logs | `console.*` only | missing | Scaffold enables `observability: { enabled: true, head_sampling_rate }` (Workers Logs). `cf-lite/modules/log`: structured JSON logger (`log.info({...})`), per-request id (`cf-ray` fallback), redaction list; Logpush/Tail Worker recipe *(paid features: verify)* | WP-OBS |
| Tracing / OTel | none | missing | Use platform automatic tracing where available (beta *(verify)*) + optional OTel-fetch exporter (`cf-lite/modules/otel`, W3C `traceparent` propagation, spans for loader/action/queue). Must not add bytes unless imported | WP-OBS |
| Error reporting | generic 500 | missing | `onError` hook in generated app: logs structured error + digest, optional reporters (Sentry via `toucan-js` recipe, or generic `fetch` sink through `waitUntil`); boundary (`_error.tsx`) shows the digest | WP-OBS |
| Web Vitals / custom metrics | none | missing | `Analytics Engine` dataset helper (`metric("lcp", v, {route})`), tiny beacon script (opt-in) posting to a generated `/_m` route (Worker-first glob only for that path) | WP-OBS |
| `cf-lite doctor` | none | missing | Checks bindings vs wrangler vs `Env` types, run_worker_first sanity, compat date age, size budget | WP-DX |

### 1.11 Security

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Security headers / CSP | hand-written `_headers` | missing | `security: { preset: "strict" }` compiles to `_headers` (static CSP with hashes of inline scripts emitted by the build; `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS suggestion, `frame-ancestors`). **Nonce CSP** for SSR routes: per-request nonce injected by `ssr()` into shell scripts/styles (static pages use hashes, since no Worker runs) | WP-SECURITY |
| Rate limiting | none | missing | `cf-lite/modules/ratelimit` over the `ratelimit` **binding** (per-colo, approximate; periods 10 s/60 s *(verify)*): `rateLimit({ key: ip|session|fn, limit })` Hono middleware + action option; DO-based exact limiter for auth-critical paths (login/OTP) | WP-SECURITY |
| CSRF | none | missing | In WP-ACTIONS; shared helper exported from security module | WP-ACTIONS |
| Secrets / env | `.dev.vars`, wrangler secrets | partial | Typed `env` validated at boot (`defineEnv({ SECRET: z.string() })`) failing *closed* with a clear message; `cf-lite secrets push` = `wrangler secret bulk` from a gitignored file, never prints values | WP-DEPLOY |
| Dependency / supply-chain | none | missing | `npm audit` + lockfile + provenance (npm `--provenance`) in release CI; `SECURITY.md` process | WP-RELEASE |
| WAF / bot management | n/a | n/a | Document Cloudflare dashboard features (WAF custom rules, Bot Fight) as the recommended layer; **dashboard/DNS changes are the owner's** | docs |

### 1.12 Deploy

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Deploy, envs | `cf-lite deploy [--env]` fresh build + `wrangler deploy` | have | — | — |
| Versions / gradual rollouts | none | missing | `cf-lite deploy --gradual 10,50,100` -> `wrangler versions upload` + `versions deploy` with percentage steps and health gate (polls Workers Logs/Analytics error rate or a `/_health` check; auto-rollback via `wrangler rollback`). Caveat: Durable Object class migrations and gradual deployments interact *(verify)* | WP-DEPLOY |
| Preview URLs per PR | none | missing | GitHub Action template: `wrangler versions upload --preview-alias pr-<n>` -> comment URL (workers.dev preview URLs) *(verify flag name)*; previews get `noindex`, separate D1/KV via `--env preview`, never production bindings | WP-DEPLOY |
| Smart Placement | none | missing | Scaffold option `placement: smart` when D1/Hyperdrive detected; docs on trade-off (static/asset path unaffected) | WP-DEPLOY |
| Env / secrets | see 1.11 | partial | — | WP-DEPLOY |
| `wrangler types` | user-run | partial | `cf-lite prepare` also runs `wrangler types` -> `worker-configuration.d.ts` and includes it in tsconfig; `Env` no longer hand-written | WP-TYPEGEN |
| Custom domains / routes / zones | n/a | n/a | **the owner** (DNS/zone changes are outside agent scope) | — |
| Multi-worker (services) | none | missing | `server/services` typed service-binding clients (RPC entrypoints `WorkerEntrypoint`) — used by OG image worker and heavy jobs | WP-DEPLOY (stretch) |

### 1.13 Testing

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Unit/integration tests for user apps | none exposed (cf-lite's own vitest + workerd e2e scripts) | missing | `cf-lite/testing`: preset for **`@cloudflare/vitest-pool-workers`** (config helper that reads the same wrangler config + bindings), `testApp()` returning `fetch(path, init)` against the generated app with isolated D1/KV/R2/DO storage per test, `applyMigrations()` from `db/` dir, fake Queue/Workflow producers with assertion helpers, `loginAs(session)` (uses e2e-login/session), time control for cron (`scheduled()` trigger helper) | WP-TESTING |
| Browser e2e | repo-internal Playwright | partial | Playwright fixture package `@cf-lite/playwright` (boots `vite preview`/`wrangler dev`, asserts "which requests hit the Worker" — the existing signature check, exposed), axe-core a11y fixture | WP-TESTING |

### 1.14 Developer experience

| Capability | cf-lite today | Status | Cloudflare-native design | WP |
|---|---|---|---|---|
| Typed routes/links (`typedRoutes`) | `hc` types for API only | partial | `.cf-lite/routes.d.ts` codegen: route table, params per route, `href("/blog/:slug", { slug })`, typed `Link to`, typed `loader`/`actions` data (`InferData<typeof route>`), API client already typed | WP-TYPEGEN (core) |
| Bindings typegen | manual `Env` | partial | See 1.12 (`wrangler types`) | WP-TYPEGEN |
| `create-cf-lite` templates | `--ui <x>` minimal | have | Templates: `minimal`, `blog` (static+MDX+sitemap+OG), `saas` (auth+D1+actions+queue), `api` (Hono RPC + ratelimit + webhooks), `realtime` (DO chat), `ai-chat` | WP-DX |
| `add` | `cf-lite add <ui>` | partial | `cf-lite add d1|kv|r2|queue|cron|do|workflow|hyperdrive|images|ai|auth|turnstile|tailwind|...` — each: install deps, edit wrangler jsonc/vite config idempotently, scaffold a file, add `Env` typing, print what changed; `--dry-run` | WP-DX |
| Upgrade codemods | none (changelog prose) | missing | `cf-lite upgrade`: bumps packages, runs versioned codemods (ts-morph) for each breaking change (`renderer:"react"` -> `react()` style changes are the prototypes), prints manual steps; every breaking change must ship a codemod or a documented "no automated path" | WP-DX |
| `cf-lite doctor` | none | missing | see 1.10 | WP-DX |
| Dev parity | `vite dev` with workerd, HMR | have | `_redirects`/`_headers`/middleware/i18n parity in dev (from WP-ROUTECONF) | WP-ROUTECONF |
| Docs site | `site/` (cfdocs, in flight) | in flight | Versioned docs, per-capability guides written alongside each WP (docs are part of each WP's acceptance) | WP-DOCS |

### 1.15 Explicitly out of scope (and what to say instead)

| Next.js feature | Answer |
|---|---|
| React Server Components / `"use server"` RPC | No. Loaders + actions give the same outcomes (server data, progressive forms) without a flight protocol. Revisit only if RSC-on-Workers becomes a Cloudflare platform feature |
| Parallel + intercepting routes | No. Nested layouts + query state |
| Edge Config, Vercel KV/Blob/Postgres, Speed Insights | Cloudflare equivalents (KV, R2, D1/Hyperdrive, Analytics Engine) are in 1.8/1.10 |
| Non-Cloudflare runtimes | Never (principle 2) |
| `middleware` on every request | Deliberately not: matcher compiles to Worker-first globs (1.1) |
| Pages Router, `getServerSideProps` | No |

---

## 2. Definition of "production-ready" for 1.0

All items are release gates, checkable by a script or a named reviewer. 1.0 is cut only when every box is green; slipping a gate means slipping 1.0.

**2.1 Stability and semver policy** (`docs/stability.md`)
- Public API surface = the `exports` map of every published package + CLI flags + file conventions + generated-file *shapes that users import* (`.cf-lite/app` types). Anything else (`.cf-lite/*` internals, `src/*` not exported) is private.
- Semver strictly from 1.0: breaking = major. Every breaking change requires a codemod in `cf-lite upgrade` or an explicit "manual" entry in the upgrade guide; deprecations live >= 1 minor with a runtime/CLI warning.
- Experimental tier: modules may ship under `cf-lite/experimental/*` (no semver guarantee); promotion requires >= 1 production app. Candidates at 1.0: realtime presets beyond the base class, AI helpers, OTel, OG images.
- Support matrix pinned and tested: Node 22 + 24, Vite 8 (`^8`), `@cloudflare/vite-plugin` 1.x (2.x when GA: separate compat track, see design.md), wrangler 4.x, Hono 4.x, each UI adapter's supported major. Compatibility-date policy: scaffolds pin a date <= 90 days old; `doctor` warns beyond 180.
- Release: changesets-style versioning, npm provenance, signed tags, CHANGELOG generated *and* human-curated; LTS = latest minor of the previous major gets security fixes for 6 months.

**2.2 Security review checklist** (`docs/security-review.md`, executed and signed off in the repo before 1.0 — reviewer must not be the author; use a cross-vendor review (author Claude, reviewer GPT) per the project's review rule, plus a human pass by the owner on the auth/CSRF/session sections)
- [x] Actions: CSRF enforcement tests (missing/foreign `Origin`, `Sec-Fetch-Site: cross-site`, method override attempts, content-type confusion, multipart) *(`test/sec-runtime.test.ts`, `test/actions.test.ts`)*
- [x] Sessions: sealed-cookie format review (AES-GCM nonce uniqueness, key rotation, no `alg` agility), fixation/rotation on login, `__Host-` prefix, revoke path, constant-time compares everywhere secrets are compared *(`test/sec-runtime.test.ts`; independent review pending, see docs/security-review.md)*
- [x] SSO/JWT verify: alg pinning (EdDSA only), `kid` confusion, clock skew, audience/issuer required (fail closed) — already in module; add negative-test corpus *(`test/sec-runtime.test.ts` negative corpus)*
- [x] Open redirect: `redirect()`, `ssoLoginUrl`, `returnTo` validated against an allow-list; `_redirects` generator rejects user-controlled targets *(`modules/safe-redirect`, `test/sec-runtime.test.ts`)*
- [x] SSRF: image loader/OG fetch/AI gateway remote fetch only via allow-list; no fetch of arbitrary `src` *(`test/sec-runtime.test.ts`, `test/images.test.ts`)*
- [x] Cache poisoning / deception: cache key normalization, `Vary` handling, authenticated bypass, draft cookie bypass, `x-forwarded-*`/host header trust, private responses never stored (tests exist for auth bypass in `modules/cache`; extend) *(`test/sec-runtime.test.ts`; `Vary: Cookie` fix)*
- [ ] XSS: head injection escaping (`injectHead`), JSON-LD escaping (`</script>`), loader data serialization (`</script>`/U+2028), CSP nonce flow, `dangerouslySetInnerHTML` audit of built-in components
- [ ] Supply chain: `npm audit` clean at release, pinned GitHub Actions by SHA, provenance, 2FA on the npm org, no install scripts in published packages
- [ ] Secrets: no module logs env values; fail-closed on missing config; `E2E_LOGIN_SECRET` module inert in production builds unless var present (documented danger)
- [ ] Rate-limit and Turnstile defaults on scaffolded auth routes
- [ ] Threat model doc for the request path (assets layer vs Worker-first, who can reach what) and `SECURITY.md` disclosure process exercised once (dry run)

**2.3 Performance budgets** (enforced in CI by `bench/` size + workerd timing scripts; regressions > budget fail the PR)
- Worker gzip: API-only <= 10 KiB (today 7.2); React SSR app <= 80 KiB (today 73.5); Preact/Svelte/Vue scaffolds <= +10% of today; **each opt-in module adds its measured size to a committed `bench/module-sizes.json` and only when imported** (tree-shake test: app importing nothing gets identical bytes).
- Client JS: static page 0 B; Preact hydrated SPA <= 12 KiB gz; router core <= 3 KiB gz.
- Worker CPU p50 (live `workers.dev`, same methodology as `RESULTS-live.md`): api <= 0.6 ms, SSR <= 2.0 ms, **SSR cache HIT <= 0.6 ms**, middleware-only path adds <= 0.2 ms; static/redirect = 0 Worker invocations (asserted by e2e).
- Cold start: <= +50 ms over a bare Worker (today +27…+45). Build: example app cold `cf-lite build` <= 20 s in CI; dev server ready <= 3 s.
- Live benchmark re-run on each minor before a release, committed with the same caveats section (no latency claims without the methodology; the known static-page +6…+10 ms open question must be **resolved or documented** before 1.0).

**2.4 Docs completeness**
- Every capability in section 1 marked have/partial has: a guide page, an API reference generated from TSDoc, a runnable example in `examples/`, and a "Cloudflare limits that matter here" box (each number verified at time of writing with the date).
- Getting-started per UI; "coming from Next.js" migration guide (table of section 1, codemod-ish checklists); recipes (auth, uploads, ISR, i18n, realtime, AI chat, cron+queues); troubleshooting (every `doctor` code has a page); ADR log (`docs/adr/`) for decisions like "no RSC".
- Docs site (`site/`) built with cf-lite itself, versioned (`/docs/0.x`, `/docs/1.x`), search, copy-paste-tested snippets (CI extracts and typechecks code fences).

**2.5 Upgrade guide**
- `docs/upgrading.md` with one section per version since 0.1 (existing "Upgrading from 0.2/0.3" notes migrated), plus 0.x -> 1.0 with `cf-lite upgrade --to 1.0` codemod run against all example apps and the three production apps as a CI job ("upgrade rehearsal").

**2.6 Test matrix**
- Unit (vitest): every module with negative/security cases; target >= 85% lines on `packages/cf-lite/src` excluding CLI glue.
- Workerd e2e: every example app x {preview, deployed-to-a-scratch-account-on-tag} asserting Worker-invocation signatures; scaffold e2e for every `--ui` and every template.
- Dev-mode e2e (vite dev restarts etc.); Playwright across chromium + firefox + webkit for the shared site suite; **axe a11y** on scaffolds/examples (0 serious/critical).
- Matrix axes: Node {22, 24} x OS {ubuntu, macos} for build/CLI; UI adapter x render mode {spa, static, ssr, ssr+hydrate}; plugin 1.x (+ 2.x beta as allowed-to-fail canary).
- Cloudflare-side integration suite (needs a scratch CF account, see section 5): real D1 migrations remote, Queues round-trip, Workflow run, DO hibernation, Images binding, R2 presign, Turnstile test keys. Runs nightly, not per-PR.
- Upgrade rehearsal (2.5) and a "fresh clone to deployed" smoke (scaffold -> install -> build -> deploy to scratch -> curl) per release.

**2.7 Real-world proof: >= 3 apps in production for >= 30 days each, on the release-candidate line**
1. An existing app (in production today): gated API + dashboard; migrate to the new middleware/session/testing modules (exercises WP-MIDDLEWARE, WP-TESTING, WP-OBS).
2. The cf-lite docs site itself (`site/`): static + search + OG images + sitemap (exercises WP-METADATA, WP-ASSETS, WP-ROUTECONF).
3. A data-heavy read/write app with auth + forms + uploads (candidate: an internal CMS/admin-style app on D1 + R2; **the owner picks which project**) — exercises actions, session/auth, storage, queues, ISR.
4. (Stretch) a realtime or AI app (DO chat / `ai-chat` template) to justify promoting those modules out of `experimental`.
Each app: field-notes entry at the candidate build and at 30 days, every friction item either fixed or ticketed as post-1.0.

**2.8 Error pages**
- Built-in, themeable, zero-JS defaults for 404 / 500 / 503(maintenance) / 429 / 403; static versions served from assets (`404.html` already partly there); SSR 500 shows digest; JSON vs HTML negotiation on `Accept`; `_error`/`_not-found` conventions override them. Tested in every render mode and with `/api/*` returning problem+json, not HTML.

**2.9 Accessibility**
- Router: focus management + `aria-live` route announcer on SPA navigation, scroll restoration, `prefers-reduced-motion` respected, skip-link in scaffolds, `lang` attribute (from i18n), accessible `<Image>` (`alt` required by types), form action errors linked with `aria-describedby`/`aria-invalid` in the form helper, docs site passes WCAG 2.2 AA (axe + manual keyboard/screen-reader pass recorded in `docs/a11y.md`).

---

## 3. Work packages

### 3.1 Rules for parallel work

- Each WP = one worktree `../cf-lite-wt/<name>` on branch `feat/<name>`, rebased on `main` daily; merged through a PR with the WP's acceptance tests green plus the three CI suites (`npm test`, `test:e2e`, `test:dev`).
- **Path ownership**: a WP may create/edit only its owned paths. A path not owned by the WP is changed only by asking the owner WP (or the core train owner). New modules get their own files.
- **Core seams (WP-SEAMS) go first.** Today `generate.ts` emits one monolithic `app.ts` and `package.json` lists `exports` one by one, so every feature would collide on the same 4 files. SEAMS introduces: (a) wildcard `exports` for `./modules/*` and `./testing` etc., (b) a *convention contributor* interface (`packages/cf-lite/src/conventions/<name>.ts`: `{ scan(root) -> entries, emit(entries) -> code chunks + worker-first globs + wrangler checks }`) that `generate.ts` iterates, so a new convention = a new file, not an edit of `generate.ts`, (c) a generated `.cf-lite/handlers.ts` slot for `queue/scheduled/email`, (d) a documented `Env` augmentation point. After SEAMS, most core-touching WPs touch only their own `conventions/*.ts` + tests; the residual shared files are listed per WP.
- **Core train**: WPs marked CORE are merged one at a time in this order (a rebase-on-merge queue; each passes the full suite before the next): SEAMS -> CACHE(cfisr, in flight) -> MIDDLEWARE -> ROUTE -> ROUTECONF -> ACTIONS -> I18N -> TYPEGEN. Their development may overlap in worktrees; only *merging* is serialized. Non-core WPs (modules, packages, docs, CI) never wait for the train.
- Effort unit: agent-days (one focused work session of ~4-6 h incl. tests + docs). S <= 1, M = 2-3, L = 4-6.
- Every WP's acceptance includes: unit tests, an e2e or workerd test where the feature is runtime, a size entry in `bench/module-sizes.json`, a guide page in `site/` (owned by the WP as `site/content/guides/<name>.md`; docs WP owns the shell), CHANGELOG line, and the "no new Worker invocations for static paths" assertion where relevant.

### 3.2 Packages (ordered by value for real apps)

Value rank reflects: the first app + likely apps (gated dashboards, CMS/admin, content sites, small SaaS).

#### WP-ISLANDS — SSR islands (PRIORITY, added 2026-10-02; implemented in the first cut, follow-ups open)
- **Why priority**: the largest remaining semantic gap vs Next ([next-parity.md](next-parity.md)): no interactive component inside a server-rendered page without hydrating the whole page. Principle: normal React/TSX, light output (a page without islands ships zero JS).
- **Done (first cut)**: `*.island.tsx|jsx` convention, `export const client = "load|idle|visible|interaction"`, JSON props with size guard, per-island chunks + shared runtime chunk, works on static (`prerender`) and SSR (streamed) pages with `hydrate = false`, strict CSP (hash / nonce), React + Preact adapters, optional preact/compat runtime (70.3 -> 12.4 KB gz measured), doctor CFL017, `examples/site-islands`, unit + workerd/Chromium e2e. Non-island apps byte-identical. ADR [design/islands.md](design/islands.md), guide [islands.md](islands.md).
- **Open follow-ups**: Svelte `islands` adapter hook (Vue done 2026-10-02: `*.island.vue`; Svelte has an expected blocker, see [islands.md](islands.md)); `modulepreload` hints for island chunks; decide whether the default runtime flips to preact/compat (needs a call: size vs exactness); nonce on React's inline Suspense streaming scripts (pre-existing, affects strict CSP + streaming, not islands-specific); `client:only` islands; slots/children.
- **Owns**: `src/{islands,islands-server,client-islands,vite-islands}.ts`, `conventions/pages.ts` (wrapper hook), `prerender.ts` (tail), adapters' `islands*.ts`, `docs/islands.md`.
- **Acceptance**: met for the first cut (see ADR test map); gate for 1.0 = a real app (the CMS starter repository's `foundation-islands` app and its comparison doc) running on it.

#### WP-SEAMS — core seams (CORE, S-M, first, blocks the train)
- **Scope**: items (a)-(d) above; no user-visible features; refactor `generate.ts` into contributor form with snapshot tests proving identical output for existing examples.
- **Owns**: `packages/cf-lite/src/{generate.ts,conventions/**,vite.ts (contributor wiring only)}`, `packages/cf-lite/package.json` (exports).
- **Acceptance**: all existing tests + e2e unchanged; generated `app.ts` byte-identical for all 7 examples (snapshot); adding a dummy convention in a test requires zero edits to `generate.ts`; docs/`conventions.md`.
- **Deps**: lands after/with `cfisr` (0.5) since both touch `generate/scan/server` (rebase onto cfisr, do not race it). **Effort** S-M.

#### WP-CACHE — finish SSR edge cache + data cache + draft mode (CORE-light; already in flight as cfisr)
- **Scope**: land 0.5 as designed in `modules/cache` (docs/caching.md); add `cached()` tag unification with KV/D1, `revalidateTag/Path`, draft-mode cookie bypass, hit/miss metrics hook, optional Cache-Purge-API global mode.
- **Owns**: `src/modules/{cache.ts,kv-cache.ts}`, `test/cache.test.ts`, `docs/caching.md`, `examples/demo/app/routes/*cache*`.
- **Acceptance**: HIT/STALE/MISS/BYPASS matrix e2e under workerd; tag purge across two "colos" (two Miniflare instances sharing a D1) in test; authenticated bypass; draft bypass; CPU on HIT within budget.
- **Deps**: SEAMS (rebase). **Effort** M (remaining portion S-M).

#### WP-MIDDLEWARE — middleware + matcher -> Worker-first globs (CORE, M)
- **Scope**: `server/middleware.ts` convention, `config.matcher` compile (incl. negative patterns, broad-matcher mode), `run_worker_first` limit check + fallback, dev parity, `cf-lite doctor` hook; migrate the first app's gate as the reference.
- **Owns**: `src/conventions/middleware.ts`, `test/middleware.test.ts`, `examples/site-gated/`, `e2e/middleware.spec.ts`. Residual shared: `vite.ts` (globs merge), `scan.ts` (`assetsRouting`).
- **Acceptance**: e2e asserts non-matching paths never invoke the Worker (same signature check as today); matcher `["/admin/:path*"]` + negative cases; ordering with `server/worker.ts` documented and tested; the first app reproduces its current behavior byte-identically on a staging copy.
- **Deps**: SEAMS. **Effort** M.

#### WP-ROUTE — routing completeness (CORE, L)
- **Scope**: route groups, optional catch-all, `_loading`/`_error`/`_not-found`, `notFound()`/`redirect()` sentinels, `paths()` (generateStaticParams) for `static` + dynamic, loader on static routes, layout loaders (opt-in), `defer()`, `server/routes/**` non-API handlers, Link prefetch, router a11y (announcer/focus/scroll).
- **Owns**: `src/conventions/{pages,boundaries}.ts`, `src/{scan.ts,client.ts,prerender.ts,server.ts}` (this WP is the primary owner of these files on the train), adapter hooks for boundaries in `packages/{react,preact,vue,svelte}/src/*` (coordinated small diffs, owned here).
- **Acceptance**: matrix test per adapter x boundary x render mode; 404 status correctness with streaming; `paths()` prerenders N files and unlisted param returns SSR/404 per `dynamicParams`; focus/announcer axe test; existing 7 examples unchanged.
- **Deps**: SEAMS, MIDDLEWARE (group-level middleware). Splittable: ROUTE-a (groups, optional catch-all, paths, non-API routes) and ROUTE-b (boundaries, sentinels, defer, prefetch) to cut L to 2x M. **Effort** L.

#### WP-ACTIONS — server actions + forms + CSRF (CORE, L)
- **Scope**: `actions` export, `POST ?/name` handler, no-JS flow (303 / re-render with `actionData`), enhance helper per adapter, validation hook, CSRF/Origin checks, file upload to R2 handoff, redirect/notFound sentinels reuse, Turnstile hook (when AUTH lands), optimistic helper (simple).
- **Owns**: `src/conventions/actions.ts`, `src/modules/csrf.ts`, `packages/*/src/form.ts(x)`, `test/actions.test.ts`, `e2e/actions.spec.ts`, `examples/site-forms/`.
- **Acceptance**: form works with JS disabled (Playwright `javaScriptEnabled:false`); CSRF negative corpus (2.2); double submit guard; pending/error state in JS mode across 5 adapters; action on cached page purges by tag (uses CACHE).
- **Deps**: SEAMS, ROUTE (sentinels), CACHE (revalidate from action). **Effort** L.

#### WP-AUTH — sessions, OAuth/OIDC, Turnstile (non-core, M-L)
- **Scope**: `modules/session` (sealed + KV/D1/DO stores), OAuth/OIDC PKCE helpers, `modules/turnstile`, `e2e-login` integration, D1 migration templates for users/accounts, `cf-lite add auth` template (saas), WebAuthn as stretch.
- **Owns**: `src/modules/{session,oauth,turnstile}.ts`, `src/conventions/` none, `templates/auth/**`, `test/session.test.ts`, `test/turnstile.test.ts`.
- **Acceptance**: unit + workerd tests incl. key rotation, tamper, expiry, revoke; OAuth flow against a local mock IdP; negative corpus of 2.2; a scaffolded app logs in/out e2e.
- **Deps**: SEAMS (exports only). Soft: ACTIONS for forms/CSRF (ships a Hono-only path first). **Effort** M-L.
- **Needs the owner**: GitHub/Google OAuth client registration for the demo (real accounts); email-sending product choice/plan for magic links *(verify)*.

#### WP-STORAGE — D1 migrations/sessions, KV, R2, Hyperdrive (non-core, M)
- **Scope**: `cf-lite db new|apply|status` (+ `--remote --yes` guard), D1 Sessions helper, typed KV helper, R2 module (streamed upload, presign, multipart, range GET), Hyperdrive helper, `cf-lite add d1|kv|r2|hyperdrive` (wrangler edits via jsonc-preserving writer shared from DX).
- **Owns**: `src/modules/{d1,r2,kv,hyperdrive}.ts`, `src/cli-db.ts`, `test/storage*.test.ts`, `examples/site-uploads/`.
- **Acceptance**: migrations apply local + idempotent + remote refused without flag; R2 presigned URL round-trip against miniflare's S3 surface or scratch bucket (nightly); range request correctness; size/type limit tests; Hyperdrive connection closed on error (mock).
- **Deps**: SEAMS. Shares the wrangler-editor with WP-DX (create it in STORAGE as `src/wrangler-edit.ts`; DX consumes). **Effort** M.

#### WP-JOBS — cron, Queues, Workflows, after(), email handler (CORE-light, M-L)
- **Scope**: `server/cron|queues|workflows|email/**` conventions, generated `handlers.ts`, typed producers, DLQ helpers, `after()`, doctor check for wrangler triggers/queues/workflows bindings, `cf-lite add cron|queue|workflow`.
- **Owns**: `src/conventions/{cron,queues,workflows,email}.ts`, `src/modules/{queue,workflow,after}.ts`, `test/jobs*.test.ts`, `examples/site-jobs/`.
- **Acceptance**: workerd test: enqueue -> consumer runs -> retry -> DLQ; cron dispatch by expression; workflow steps run under miniflare; typed producer compile tests (`tsd`-style); generated handlers absent (zero bytes) when no conventions present.
- **Deps**: SEAMS (handlers slot). Feeds ISR and webhooks. **Effort** M-L. **Needs the owner**: Queues availability on the account's plan and any paid-plan enablement *(verify)* before remote tests.

#### WP-IMAGES — `<Image>` + transformations (non-core, M)
- **Scope**: per-adapter `Image` component, `/cdn-cgi/image` backend, `IMAGES` binding route with Cache API, allow-list, sizes whitelist, Vite build-time pre-sizing, LQIP (optional).
- **Owns**: `src/modules/images.ts`, `packages/*/src/image.ts(x)`, `src/vite-images.ts`, `test/images.test.ts`, `examples/site-images/`.
- **Acceptance**: srcset/dimensions snapshot per adapter; binding route: format negotiation, allow-list rejection (SSRF tests), cache hit on second call; no CLS (dimensions present, Playwright layout-shift check).
- **Deps**: SEAMS. **Effort** M.
- **Needs the owner**: zone with Images transformations on a custom domain for backend (1) and paid Images usage beyond free tier *(verify)*; binding backend works on workers.dev.

#### WP-ASSETS — fonts, `_headers` defaults, script strategy (non-core, S-M)
- **Scope**: font plugin (fontsource build-time, preload, size-adjust), generated default `_headers` (immutable hashed assets), head `script` strategies.
- **Owns**: `src/vite-fonts.ts`, `src/modules/headers-default.ts`, `test/fonts.test.ts`. Residual: `head.ts` (script entries; owned here, coordinated with METADATA).
- **Acceptance**: build emits hashed woff2 + preload link + `@font-face` with fallback metrics; no network at build in CI (offline fixture); Lighthouse-style CLS check in Playwright; `_headers` snapshot.
- **Deps**: SEAMS. **Effort** S-M.

#### WP-METADATA — OG images, sitemap/robots/manifest, icons, JSON-LD (CORE-light, M)
- **Scope**: `_og.tsx` convention + satori/resvg renderer in separate Worker entry or service binding, sitemap (static at build + dynamic), robots/manifest, icon conventions, `openGraph/twitter/jsonLd` head sugar, preview-URL `noindex`.
- **Owns**: `src/conventions/metadata.ts`, `src/modules/{og,sitemap}.ts`, `packages/cf-lite/og-worker/**`, `test/metadata.test.ts`, `examples/site-blog/`. Residual: `head.ts` (with ASSETS).
- **Acceptance**: sitemap validates against the sitemap.org schema incl. index split; OG PNG 1200x630 byte-stable hash for fixed input, cached (second request = HIT); main Worker size unchanged when OG unused; robots noindex on previews.
- **Deps**: SEAMS; ASSETS (fonts for OG). **Effort** M.

#### WP-ROUTECONF — redirects/rewrites/headers config compile (CORE-light, S-M)
- **Scope**: `cf-lite.config.ts` schema (`redirects`, `headers`, `rewrites`, `security` presets hook for SECURITY), compile to `_redirects`/`_headers` + Worker fallback for conditional/rewrite rules, limit reports, dev-mode application.
- **Owns**: `src/conventions/routeconf.ts`, `src/config.ts`, `test/routeconf.test.ts`.
- **Acceptance**: golden-file output; limit overflow produces a clear error with counts; conditional rule reaches Worker only for its glob; dev server applies same table.
- **Deps**: SEAMS, MIDDLEWARE (glob merge). **Effort** S-M.

#### WP-SECURITY — CSP/security headers, rate limiting (non-core, S-M)
- **Scope**: `security` presets (static CSP hashes, headers), nonce flow for SSR (touches `ssr()` — coordinated), `modules/ratelimit` (binding + DO exact limiter), threat-model doc, execute the 2.2 checklist (cross-vendor review, GPT reviewer).
- **Owns**: `src/modules/{ratelimit,csp}.ts`, `docs/security-review.md`, `docs/threat-model.md`, `test/security.test.ts`. Residual: `src/server.ts` nonce hook (tiny, via ROUTE owner).
- **Acceptance**: CSP works on built static + SSR pages without `unsafe-inline` (Playwright console has no CSP violations); ratelimit returns 429 + `Retry-After`; checklist items each linked to a test or a dated review note.
- **Deps**: ROUTECONF (headers compile), SEAMS. **Effort** S-M (+ review time).

#### WP-OBS — logs, tracing, errors, metrics (non-core, M)
- **Scope**: `modules/log`, `onError` hook in generated app (via seam), error digest, reporter interface (+ Sentry recipe), OTel exporter module, Analytics Engine metric helper + vitals beacon, scaffold `observability` enabled.
- **Owns**: `src/modules/{log,otel,metrics}.ts`, `test/obs.test.ts`. Residual: generated `onError` slot (SEAMS).
- **Acceptance**: request id in logs and in error page digest; redaction tests; traceparent propagation test; zero bytes when unused.
- **Deps**: SEAMS. **Effort** M. **Needs the owner**: paid-plan features (Logpush/Tail Workers retention, Trace export) only if he wants them in the recipes *(verify)*.

#### WP-AI — Workers AI, AI Gateway, Vectorize (non-core, M; ships as experimental)
- **Scope**: `modules/ai` (run, stream SSE, gateway routing), `vectors`, embed + chunk utilities, `ai-chat` template.
- **Owns**: `src/modules/{ai,vectors}.ts`, `templates/ai-chat/**`, `test/ai.test.ts`, `examples/site-ai/`.
- **Acceptance**: mocked binding unit tests; gateway headers typed; streaming test through workerd; template builds and passes scaffold e2e; real-model nightly smoke on scratch account.
- **Deps**: SEAMS; ACTIONS optional. **Effort** M. **Needs the owner**: Workers AI/AI Gateway enablement and budget for nightly smoke *(verify)*.

#### WP-REALTIME — Durable Object presets, hibernating WS (non-core, M; experimental at 1.0 unless 4th app)
- **Scope**: `modules/realtime` (HibernatingRoom, broadcast, presence, alarms), client `connectChannel`, `server/do/**` convention + generated exports, `cf-lite add do`, `realtime` template; promote demo `Room`.
- **Owns**: `src/modules/realtime.ts`, `src/client-realtime.ts`, `src/conventions/do.ts`, `templates/realtime/**`, `test/realtime.test.ts`.
- **Acceptance**: DO hibernation test (connection survives eviction simulation), reconnect/backoff/resume unit tests, two-client e2e broadcast under workerd, migration entry generated correctly (SQLite classes).
- **Deps**: SEAMS. **Effort** M.

#### WP-TYPEGEN — typed routes/links, loader/action data types, `wrangler types` integration (CORE, M)
- **Scope**: `.cf-lite/routes.d.ts`, `href()`, typed `Link`, `InferData`, `Env` from `wrangler types` in `prepare`, `cf-lite types` command.
- **Owns**: `src/conventions/typegen.ts`, `src/cli.ts` (prepare hook), `test/typegen.test.ts` (type tests with `tsc` fixtures), adapter `Link` type diffs (coordinated with ROUTE).
- **Acceptance**: compile-fail fixtures for wrong param/route; all examples typecheck with generated types; `Env` stays in sync after binding change in wrangler config.
- **Deps**: SEAMS, ROUTE (final route model), ACTIONS (action types) — last on the train. **Effort** M.

#### WP-I18N — locale routing, catalogs, hreflang (CORE, M)
- **Scope**: config, prefix routing, detection only on `/` + unprefixed, cookie, catalogs with per-route tree-shaking, hreflang/sitemap integration, `lang` attr.
- **Owns**: `src/conventions/i18n.ts`, `src/modules/i18n.ts`, `test/i18n.test.ts`, `examples/site-i18n/`.
- **Acceptance**: `/` redirect by `Accept-Language` without touching other paths' Worker-first status (e2e signature); hreflang present; fallback locale; static pages per locale prerendered via `paths()`.
- **Deps**: ROUTE (groups/paths), ROUTECONF, METADATA (sitemap alternates). **Effort** M.

#### WP-ISR — "durable static" regeneration via R2 + Queue/Workflow (non-core on top of CACHE/JOBS, M)
- **Scope**: R2-backed regenerated pages, tag purge -> queue -> regenerate, stale-while-regenerate from R2, admin revalidate endpoint, example.
- **Owns**: `src/modules/isr.ts`, `test/isr.test.ts`, `examples/site-isr/`.
- **Acceptance**: edit content -> `revalidateTag` -> new HTML globally visible without redeploy (two-colo test + scratch-account smoke); regeneration failure keeps serving last good copy; cost doc (R2 ops, queue msgs).
- **Deps**: CACHE, JOBS, STORAGE(R2), ACTIONS (optional trigger). **Effort** M. Post-first-wave.

#### WP-DEPLOY — gradual rollouts, preview URLs, typed env/secrets, placement, services (non-core, M)
- **Scope**: `cf-lite deploy --gradual`, rollback gate, CI templates (preview per PR, production with approval), `defineEnv`, `cf-lite secrets push`, Smart Placement option, service-binding typed clients (stretch).
- **Owns**: `src/cli-deploy.ts` (extracted from `cli.ts` by SEAMS), `templates/ci/**`, `src/modules/env.ts`, `test/deploy*.test.ts`.
- **Acceptance**: `--dry-run` plans printed and tested; rollback path tested with mocked wrangler; preview worker never gets production bindings (assertion in config diff test); secrets push never echoes values (test on captured output).
- **Deps**: SEAMS. **Effort** M. **Needs the owner**: real gradual rollout/preview alias run on a scratch account; GitHub Action secrets (API token) and any production deploy (a release to real users needs the owner's approval).

#### WP-TESTING — `cf-lite/testing` + Playwright fixtures + a11y (non-core, M)
- **Scope**: vitest-pool-workers preset, `testApp`, migrations helper, fake queues/workflows, `scheduled()` trigger helper, `loginAs`, `@cf-lite/playwright` (Worker-invocation assertions, axe), docs.
- **Owns**: `packages/testing/**` (new `@cf-lite/testing`), `packages/playwright/**`, `examples/*/test/**` added.
- **Acceptance**: the first app's gate + an example's API tested with the preset; isolation test (storage does not leak between tests); a11y fixture fails on seeded violation.
- **Deps**: SEAMS (wrangler-config reader); best after MIDDLEWARE to test it, but independent. **Effort** M.

#### WP-DX — `add`, templates, `doctor`, `analyze`, upgrade codemods (mostly non-core, L)
- **Scope**: generic `cf-lite add <module>` framework (uses `wrangler-edit`), templates (minimal/blog/saas/api/realtime/ai-chat), `doctor`, `analyze`, `cf-lite upgrade` + first codemods (0.2->0.3 renderer, 0.3->0.4 sso env), Tailwind recipe.
- **Owns**: `src/{add.ts,doctor.ts,analyze.ts,upgrade/**}`, `packages/create-cf-lite/**`, `templates/**` (shared with module WPs by subdirectory: each WP owns its own `templates/<x>`).
- **Acceptance**: every `add` target idempotent (run twice = no diff) + `--dry-run` golden output; every template passes scaffold e2e; codemod fixtures before/after; `doctor` codes each have a doc page.
- **Deps**: SEAMS; consumes wrangler-edit (STORAGE); templates grow as module WPs land (so DX is continuous, final polish last). **Effort** L (spread).

> Post-1.0 developer toolkit (init, generators, seed, NL mode, AI assets, component preview) with its entry gate: [roadmap-dx.md](roadmap-dx.md).

#### WP-DOCS — docs site shell, reference, migration guide, a11y page (non-core, M, continuous)
- **Scope**: `site/` (cfdocs in flight) versioning, API reference from TSDoc, "coming from Next.js", snippet CI, `docs/{stability,upgrading,a11y,adr/*}.md`.
- **Owns**: `site/**` except `site/content/guides/<wp>.md` (owned by each WP), `docs/{stability,upgrading,a11y}.md`.
- **Acceptance**: snippet typecheck job; broken-link check; axe clean; version switcher.
- **Deps**: cfdocs session output. **Effort** M (continuous).

#### WP-RELEASE — release engineering + 1.0 readiness audit (non-core, M)
- **Scope**: changesets, provenance publish workflow, npm scope/name reservation, perf-budget CI gates (`bench/module-sizes.json`, workerd timing), nightly scratch-account integration job, upgrade rehearsal job, RC process, test-matrix CI (Node 22/24, macOS), `SECURITY.md` dry run, final 1.0 audit report.
- **Owns**: `.github/workflows/**`, `bench/**` (gates), `docs/release.md`, `scripts/release/**`.
- **Acceptance**: dry-run publish to a local registry (verdaccio) succeeds with provenance flags off, on with real token only by the owner; budgets fail on a seeded regression.
- **Deps**: SEAMS for file moves; runs continuously; finalizes last. **Effort** M.
- **Needs the owner**: **npm org/scope `@cf-lite` + package names, 2FA, publish token, making the GitHub repo public, choosing license of record (MIT already), the public announcement** — public release is his call.

### 3.3 Dependency graph and core overlap

```
SEAMS ─┬─> MIDDLEWARE ─┬─> ROUTE ─┬─> ACTIONS ─┬─> TYPEGEN
       │               │          │            └─> ISR (+CACHE, JOBS, STORAGE)
       │               └─> ROUTECONF ─┬─> SECURITY
       │                               └─> I18N (+ROUTE, METADATA)
       ├─> CACHE (cfisr, rebase first)
       ├─> AUTH, STORAGE, JOBS, IMAGES, ASSETS->METADATA, OBS, AI, REALTIME, DEPLOY, TESTING, DX, DOCS, RELEASE   (parallel, non-core)
```

| WP | Core? | Sequencing constraint |
|---|---|---|
| SEAMS, MIDDLEWARE, ROUTE, ROUTECONF, ACTIONS, I18N, TYPEGEN | **yes** | merge in train order; worktrees may overlap |
| CACHE (cfisr), JOBS, METADATA | core-light (own `conventions/*.ts`, one slot each) | after SEAMS; merge order CACHE < JOBS < METADATA |
| AUTH, STORAGE, IMAGES, ASSETS, SECURITY, OBS, AI, REALTIME, DEPLOY, TESTING, DX, DOCS, RELEASE, ISR | no | free to run any time after SEAMS (AUTH/STORAGE/TESTING/ASSETS/IMAGES may even start before, as they touch only new files — they just must not edit `package.json` exports; use the wildcard once SEAMS lands, or merge right after it) |

Shared-file watch list (touching any = coordinate with the train owner): `scan.ts`, `generate.ts`, `server.ts`, `vite.ts`, `client.ts`, `prerender.ts`, `cli.ts`, `head.ts`, `packages/cf-lite/package.json`, adapter `src/index.ts`s.

### 3.4 Value order (roadmap order)

**Priority item, outside the numbered order: WP-ISLANDS** (see 3.2) - small, opt-in, and it removes the biggest remaining App Router gap for content sites.

1. SEAMS (enabler) -> 2. CACHE (already in flight) -> 3. MIDDLEWARE (the first app + every gated app) -> 4. AUTH + STORAGE (every real app) -> 5. ACTIONS (the headline Next gap) -> 6. ROUTE (boundaries/groups/paths) -> 7. JOBS -> 8. TESTING -> 9. DEPLOY -> 10. IMAGES + ASSETS + METADATA (content sites, SEO) -> 11. ROUTECONF + SECURITY -> 12. OBS -> 13. TYPEGEN -> 14. I18N -> 15. ISR -> 16. REALTIME, AI (experimental-tier) -> continuous: DX, DOCS, RELEASE.

### 3.5 Proposed waves

| Wave | Packages (parallel worktrees) | Why together |
|---|---|---|
| **0 (now, before/with cfisr)** | SEAMS (+ land CACHE/cfisr) | unblock everything; <= 1 core train lane |
| **1** | **MIDDLEWARE** (core), **AUTH** (new files), **STORAGE** (new files), **TESTING** (new package) | highest value; 1 core + 3 non-overlapping new-file WPs; the first app benefits from all four |
| **2** | ROUTE-a, ACTIONS (core, sequential merges), JOBS, DEPLOY, ASSETS+IMAGES | Next parity headline + operational maturity |
| **3** | ROUTE-b, ROUTECONF, SECURITY, METADATA, OBS | production hardening + SEO |
| **4** | TYPEGEN, I18N, ISR, REALTIME, AI, DX polish, DOCS completeness | long tail; the release-candidate cut after this + 30-day soak of >= 3 apps |
| **RC/1.0** | RELEASE audit, security review sign-off, upgrade rehearsal, perf live re-run | gates of section 2 |

Rough total: ~30-40 agent-days of executor work across ~20 packages; with 3-4 parallel lanes and a serialized core train, **about 6-8 calendar weeks to a release candidate + 30 days soak** (estimate, dominated by the core train and the owner-dependent steps, not by module work).

### 3.6 Risks

- **Core train is the bottleneck.** Mitigation: SEAMS pushes most features into `conventions/*.ts`; split ROUTE into a/b; keep per-WP PRs small.
- **Plugin 2.x GA** could force a config-layer rewrite mid-stream (`wrangler.jsonc` no longer read; `cf` CLI deploy). Mitigation: isolate all wrangler-config access behind `src/wrangler-edit.ts`/`src/config.ts` (STORAGE/SEAMS) so 2.x support is one adapter; keep the 2.x canary job.
- **`run_worker_first` limits** (glob count/length) could cap middleware/i18n/routeconf; decide by measurement in MIDDLEWARE week 1 and record in the ADR *(verify)*.
- **Worker size budget** with satori/resvg, Images, AI SDKs: hard rule that heavy deps live behind separate entries or service bindings, enforced by the size gate.
- **Cloudflare product churn** (beta/GA of tracing, D1 sessions, AI Search, preview aliases): every such item is labelled `experimental` until verified GA on the docs date; docs carry the verification date.
- **Scope creep toward "Next clone"**: the out-of-scope table (1.15) is part of the contract; anything new needs a real-app use case from the three production apps.

---

## 4. Decisions and inputs needed from the owner

### 4.1 Needs the owner (cannot/should not be done by agents)
| Item | Needed by | Why |
|---|---|---|
| Choose the 3rd (and 4th) production app from the existing apps | before RC | real-world gate 2.7; data-heavy app with auth/forms/uploads |
| Scratch Cloudflare account (or a dedicated zone/workers subdomain) for nightly integration + gradual-rollout/preview tests | Wave 1-2 | avoid touching a production account; tests need real D1/R2/Queues/Workflows/Images/AI |
| Paid plan features: Queues/Workflows/Images transformations/AI/Logpush/Trace export — confirm which are enabled *(verify current plan gating)* | WP-JOBS, IMAGES, AI, OBS | remote tests and "recommended defaults" depend on it |
| Custom domain + zone for docs site and for `/cdn-cgi/image`, Cache-Purge API, preview aliases | Wave 2-4 | DNS/zone changes are outside agent scope (project rule) |
| OAuth client registrations (GitHub/Google), email sending setup for magic links | WP-AUTH demo | real accounts/credentials: not created by agents |
| npm org/scope `@cf-lite` + names, 2FA, publish token; repo public flip; announcement; docs domain go-live | RC/1.0 | public/outward-facing release is his decision (owner approval) |
| Approve production deploys of the ported apps on candidate builds; gradual rollout to real users | candidate soak | real users; owner approval |
| Security review sign-off on auth/CSRF/session sections (human pass) | before 1.0 | agents' review (GPT reviewer) is evidence, not sign-off |
| Decision: RSC never (current stance) vs revisit if Cloudflare ships platform support | ADR | scope contract |

### 4.2 Open questions for him (defaults in bold)
1. Forms: **`actions` export in route files** vs separate `server/actions/*.ts`? (route-colocated is closest to Next and needs no registry)
2. i18n: **path-prefix only in 1.0**, domains later?
3. OG images: **separate Worker/service binding** (size-safe) vs inline in main Worker?
4. Keep Preact/Svelte/Vue adapters at 1.0 **with full feature parity on boundaries/forms**, or tier them (React+Preact tier-1; others tier-2 with documented gaps)? Tiering cuts ROUTE/ACTIONS effort ~25%.
5. Publish under unscoped `cf-lite` + `@cf-lite/*` (names were free on 2026-09-30) — confirm before anything is reserved.

### 4.3 First wave (proposed)
After SEAMS lands (S-M, do now alongside cfisr): **MIDDLEWARE, AUTH, STORAGE, TESTING** in parallel worktrees (`feat/middleware`, `feat/auth`, `feat/storage`, `feat/testing`). One core lane (middleware) + three new-file lanes => near-zero merge conflicts; the first app gets gate middleware, sessions, D1 migrations and tests immediately; then Wave 2 opens the ACTIONS/ROUTE core train.

---

## 5. Tóm tắt (tiếng Việt)

- **Hướng đi**: bám chặt Cloudflare; không bắt chước Vercel. Nguyên tắc: request tĩnh không bao giờ đánh thức Worker (middleware `matcher` biên dịch thành `run_worker_first` globs), dùng binding gốc (Images, Cache API, KV/D1/DO/R2, Queues, Workflows, Rate Limiting), convention biên dịch lúc build, module opt-in (không import = 0 byte).
- **Ma trận** (mục 1) phủ routing, data, assets, metadata, auth, API, background, realtime, storage, AI, observability, security, deploy, testing, DX; mỗi dòng có trạng thái have/partial/missing + thiết kế Cloudflare-native + WP phụ trách. Loại trừ có chủ đích: RSC, parallel/intercepting routes, tính năng riêng Vercel.
- **Định nghĩa production-ready 1.0** (mục 2): semver + codemod cho mọi breaking change, checklist bảo mật có reviewer độc lập, ngân sách hiệu năng chạy trong CI, docs đầy đủ, hướng dẫn nâng cấp, ma trận test (Node 22/24, 3 trình duyệt, axe a11y, tích hợp Cloudflare thật hằng đêm), >= 3 app chạy thật >= 30 ngày, trang lỗi, a11y.
- **Work packages** (mục 3): ~20 gói, mỗi gói có worktree `feat/<tên>`, path ownership, acceptance test, effort, phụ thuộc. Gói đụng core (SEAMS, MIDDLEWARE, ROUTE, ROUTECONF, ACTIONS, I18N, TYPEGEN) merge tuần tự theo "core train"; SEAMS đi trước để các tính năng mới chỉ thêm file riêng (`conventions/*.ts`, exports wildcard) thay vì sửa chung `generate.ts`/`package.json`. Ước tính ~30–40 agent-day, 6–8 tuần tới RC1 rồi soak 30 ngày.
- **Wave 1 đề xuất** (sau SEAMS + cfisr): **MIDDLEWARE** (core), **AUTH** (session/OAuth/Turnstile), **STORAGE** (D1 migrations/R2/KV/Hyperdrive), **TESTING** (vitest-pool-workers + Playwright fixtures). Wave 2: ACTIONS + ROUTE + JOBS + DEPLOY + ASSETS/IMAGES.
- **Cần chủ dự án** (mục 4.1): chọn app production thứ 3, tài khoản Cloudflare thử nghiệm, xác nhận tính năng gói trả phí (Queues/Workflows/Images/AI/Logpush), domain/zone (DNS ngoài phạm vi agent), đăng ký OAuth & email, npm scope `@cf-lite` + token + chuyển repo public + thông báo, duyệt deploy production, ký duyệt review bảo mật cuối.

# cf-lite

*Lightweight, Cloudflare-native web framework - easy to start, open enough to grow.*

**A Cloudflare-only web framework-lite: Vite + Hono + Workers static assets, with file-based conventions generated at build time.**
No framework runtime sits between your code and workerd, and static traffic never wakes the Worker.

> Status: **0.4, open source (MIT), version 0.x** - API may still change between minors (policy: [`docs/stability.md`](docs/stability.md)).
> `cf-lite`, `@cf-lite/preact|react|solid|svelte|vue` and `create-cf-lite` are on npm at 0.4.0 (checked 2026-10-06; list: [`docs/published.md`](docs/published.md)).
> **Known issue:** the published `create-cf-lite` 0.4.0 scaffolder fails when run through `npx` / `npm create` (its copy filter skips templates installed under `node_modules`); `0.4.1` fixes it and is set on `main`, but was not on the registry at the 2026-10-06 check. Until it is published, scaffold from a clone (commands below).
> Design + rationale: [`docs/design.md`](docs/design.md). Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Why the name

* **cf** - built for the Cloudflare Workers runtime first (Workers, KV, R2, D1, Queues, Durable Objects), not a portable framework squeezed onto the edge.
* **lite** - what is left when you remove everything a page does not need: a Worker as small as ~7 KiB gzip for an API-only app (it grows with routes and SSR; see [`docs/field-notes.md`](docs/field-notes.md)), static pages that never wake the Worker, zero client JS unless you ask for it.
* **lite** also reads as light: requests answered at the edge, close to the user, in milliseconds.
* The rule behind it: easy to start, open enough to grow. Everything that can be predefined is predefined; everything else stays plain Hono, Vite and your UI library of choice.

cf-lite is an independent open-source project and is not affiliated with, sponsored by, or endorsed by Cloudflare, Inc., Optimizely, or Vercel Inc. Cloudflare, Cloudflare Workers, Optimizely and Next.js are trademarks or registered trademarks of their respective owners, used here only to describe compatibility.

## What cf-lite is - and is not

**It is**
* a Vite plugin + tiny CLI (`cf-lite dev|build|deploy|add`) on top of [`@cloudflare/vite-plugin`](https://www.npmjs.com/package/@cloudflare/vite-plugin), [Hono](https://hono.dev) and Workers static assets;
* file conventions compiled at *build* time: `app/routes/**` (pages, nested `_layout`, per-route `head`), `server/api/*.ts` (one Hono sub-app per file, typed client via `hc<ApiType>`), `public/_redirects`;
* three page kinds per route: SPA (default), **static** (`export const render = "static"`: prerendered, zero JS), **SSR** (`render = "ssr"` + `loader`, streamed, optional hydration);
* **UI-agnostic**: React, Preact, Vue, Svelte or Solid via one adapter package, an htmx + Alpine preset (server-rendered fragments, no UI framework), or none (API + your own `index.html`).

**It is not**
* not a meta-framework with a server runtime: no data-router, no middleware hooks in front of `/api/*`, no ISR/image pipeline;
* not portable: Cloudflare Workers only (Durable Objects, D1, KV, cron are used directly, not abstracted);
* not (yet) a mature ecosystem: 0.x, API may still change; Astro-style islands are experimental (React, Preact, Vue);
* not faster on every path - see the benchmark caveats below.

## 60-second quickstart (pick a UI)

Needs Bun 1.4+ ([bun.sh](https://bun.sh)) and, to deploy, a Cloudflare account (`bunx wrangler login`). The packages are on npm, but `create-cf-lite` 0.4.0 has a known `npx` bug (fixed in `0.4.1` on `main`, not yet on the registry at the 2026-10-06 check), so scaffold *inside a clone*
(`examples/*` is a Bun workspace, so one `bun install` links `cf-lite` and `@cf-lite/*` locally; every `--ui` is covered by `scripts/scaffold-e2e.mjs`):

```bash
git clone <this repo> cf-lite && cd cf-lite && bun install --frozen-lockfile && bun run build      # once
bun packages/create-cf-lite/index.mjs examples/my-app --ui react --no-install   # or preact | vue | svelte | solid | htmx | none
bun install && bun run --filter my-app dev
```

Once `create-cf-lite` 0.4.1 is published this becomes `bun create cf-lite my-app -- --ui react && cd my-app && bun install && bun run dev`.

| `--ui` | you write | add to an existing app |
|---|---|---|
| `react` | `app/routes/*.tsx`, React 19, SSR via `renderToReadableStream` (Suspense streaming) | `bunx cf-lite add react` |
| `preact` | `.tsx` (React code works via compat aliases), smallest client (~8 KiB gz) | `bunx cf-lite add preact` |
| `vue` | `app/routes/*.vue`, Vue 3.5, `renderToWebStream` | `bunx cf-lite add vue` |
| `svelte` | `app/routes/*.svelte`, Svelte 5 (sync SSR, no streaming) | `bunx cf-lite add svelte` |
| `solid` | `app/routes/*.tsx`, Solid 1.9 JSX, `renderToStream` SSR + fine-grained hydration (`vite-plugin-solid`) | `bunx cf-lite add solid` |
| `htmx` | renderer stays `none`: Hono routes return HTML fragments (`hono/html`), `hx-*` attributes swap them in, Alpine for small client state; no JSX, no component compiler | `bunx cf-lite add htmx` |
| `none` (default) | `server/api/*.ts` + your own `index.html`; no UI framework installed | - |

```bash
bun run dev       # vite dev: HMR for your UI + workerd (Durable Objects, WebSockets, bindings)
bun run build     # vite build + prerender static pages; Worker is minified
bun run deploy    # fresh build + wrangler deploy   (cf-lite deploy --env preview for a wrangler environment)
```

A minimal route tree:

```
app/routes/index.tsx          SPA page                        -> / (static shell, no Worker)
app/routes/about.tsx          export const render = "static"  -> prerendered /about/, zero JS, no Worker
app/routes/blog/[slug].tsx    export const render = "ssr"     -> /blog/:slug, runs in the Worker
app/routes/_layout.tsx        nested layouts
server/api/hello.ts           export default new Hono().get("/", c => c.json({...}))  -> /api/hello
public/_redirects             /go/example https://example.com/  302   (answered by the assets layer)
```

Only `/api/*` and SSR route globs are ever sent to the Worker (`assets.run_worker_first`); everything else is answered by
Workers static assets, which are not billed as Worker requests. Gates/middleware go in your own `server/worker.ts`
(`root.use(...)` then `root.route("/", app)`).

## Adapters

| adapter | SSR | hydration | HMR | route files | Worker gzip* | client JS* |
|---|---|---|---|---|---|---|
| `@cf-lite/react` | `renderToReadableStream` (Suspense) | `hydrateRoot` | Fast Refresh | `.tsx` | 74 KiB | 69 KiB |
| `@cf-lite/preact` | `preact-render-to-string/stream` | `hydrate` | prefresh | `.tsx` | 18 KiB | 8 KiB |
| `@cf-lite/vue` | `renderToWebStream` | `createSSRApp` | Vue HMR | `.vue` | 38 KiB | 28 KiB |
| `@cf-lite/svelte` | `render()` (sync, one chunk) | `hydrate` | Svelte HMR | `.svelte` | 17 KiB | 18 KiB |
| `@cf-lite/solid` | `renderToStream` | `hydrate` (fine-grained) | Solid HMR | `.tsx` | 23 KiB | 10 KiB |
| htmx preset (no adapter) | `hono/html` fragments from `server/api/ui.ts` | none (htmx swaps HTML) | Vite full reload | n/a | 8 KiB** | 38 KiB (htmx + Alpine) |

\* same app, minified, SSR route + layouts + API; client = hydrated SSR page up front ([`bench/RESULTS-adapters.md`](bench/RESULTS-adapters.md)).
\*\* `examples/site-htmx` re-implements the pages as fragments, so it is an order-of-magnitude comparison, not a like-for-like row.
Contract for writing a new adapter (and why not Vike): [`docs/adapters.md`](docs/adapters.md). Examples: `examples/demo` (React showcase with a Durable Object + WebSocket + cron),
`examples/site*` (the same app in five UI frameworks; `site-htmx` is the htmx/Alpine flavour).

## Benchmarks - summary and honest caveats

Measured against Next 16 + OpenNext and vinext 1.0 (same three-route app), locally and on real `workers.dev` Workers. Full method and raw data:
[`bench/RESULTS.md`](bench/RESULTS.md), [`bench/RESULTS-live.md`](bench/RESULTS-live.md), [`bench/methodology.md`](bench/methodology.md).

**Live, 0.3 (real `workers.dev` Workers, client in the HKG colo, p50 over a 10-line bare Worker, n = 300 per cell; cold start n = 5):**

| | api | static page | SSR page | redirect |
|---|---|---|---|---|
| warm TTFB over bare | +0.4 … +1.1 ms | **+6 … +10 ms** | +1.6 … +2.9 ms | +0.2 ms |
| Worker CPU p50 | 0.27 – 0.53 ms | **0 (no Worker invocation)** | 0.9 – 1.9 ms | **0 (no Worker invocation)** |

* The four adapters are indistinguishable on API latency; SSR costs ~1-2 ms of Worker CPU per request (Preact lowest, Vue highest).
* **Cold start** after a fresh deploy (first request minus the next): Svelte +27, Preact +29, Vue +34, React +38, demo +45 ms; a bare Worker is +6 ms. In the earlier run, vinext was +97 ms and Next+OpenNext +261 ms (not repeated on 0.3).
* **Honest caveats:** a prerendered static page is **slower** on the real network than a trivial Worker (+6…+10 ms; cause not yet verified), so cf-lite's case is *CPU/billing and size*, not warm latency;
  the local-launcher "cf-lite is 12 ms faster" numbers in `RESULTS.md` are a `vite preview` artifact and do not reproduce in production. Worker sizes (gz): 17-74 KiB depending on UI, 7 KiB for an API-only app,
  vs 281 KiB (vinext) / 915 KiB (Next+OpenNext).

General caveats: one day, one Cloudflare account, clients in one region that all reach the HKG colo; n is small for cold starts; the
comparison apps are not the same capability (cf-lite static pages ship zero JS, the others ship a React runtime); p99 from 300 samples is ~3 requests.
Local-launcher numbers (`RESULTS.md`) carry a ~15 ms floor from `vite preview`/`wrangler dev` and are **not** evidence of production latency.
The defensible claims are *size, CPU and cold-start*, not a warm-latency win.

## Repo layout

```
packages/cf-lite          core: Vite plugin, framework-free client router, ssr helper, CLI, optional modules (sso, d1, kv-cache, cache, e2e-login)
packages/react|preact|vue|svelte|solid   UI adapters (@cf-lite/*)
packages/create-cf-lite   scaffold
examples/demo, examples/site*     showcase + same app in 5 UIs + htmx flavour
bench/                    reproducible benchmarks (local: bench/run.sh; live workers.dev: bench/live/)
e2e/, scripts/            Playwright + workerd behaviour tests
```

`cf-lite/modules/sso` is a verify-only Ed25519 cookie gate with no built-in issuer: set `SSO_ISSUER` + `SSO_PUBLIC_KEYS` (JWKS or kid map)
yourself - see the header of `packages/cf-lite/src/modules/sso.ts` for every variable.

`export const cache = { maxAge, swr, tags }` on an SSR page caches it at the edge (Cache API, stale-while-revalidate, tag purge via KV/D1, signed-in bypass) - per-colo, not global; read [docs/caching.md](docs/caching.md) for the limits (0.5.0, unreleased).

## Upgrading from 0.3

* `cf-lite/modules/sso` no longer has a built-in issuer: set `SSO_ISSUER` and `SSO_PUBLIC_KEYS` (a JWKS or a `{kid: base64-key}` map); required `SSO_AUDIENCE` (fail-closed), optional `SSO_COOKIE_NAME`, `SSO_AUTH_ORIGIN`. `ssoLoginUrl(returnUrl, env, refresh?)` now takes the env for the auth origin.
* Adapter authors: `View` gained an optional `hydrate` flag (whether the page will hydrate in the browser).

## Upgrading from 0.2

* `cfLite({ renderer: "react" })` / `"preact"` -> `cfLite({ renderer: react() })` (`import react from "@cf-lite/react"`); the string renderers are gone. `bunx cf-lite add react` does it.
* `import { Link, mount } from "cf-lite/client"` -> `"@cf-lite/react/client"` (framework-free `navigate`, `createRouter` stay in `cf-lite/client`).
* `react`/`react-dom` are no longer dependencies of `cf-lite`; an API-only app can drop them (`renderer: "none"`).

## Tests and contributing

```bash
bun install --frozen-lockfile
bun run typecheck      # tsc for every package + example apps
bun run test               # build + vitest unit tests
bun run test:e2e       # demo + every adapter app + every `create-cf-lite --ui` scaffold under local workerd; asserts which requests reach the Worker
bun run test:dev       # vite dev: SSR route add/remove restarts, dev-mode SSR for every adapter
bun run test:browser   # Playwright (chromium) shared suite against all adapter apps + demo
```

CI runs all of the above on every push/PR. See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md), [`CHANGELOG.md`](CHANGELOG.md).

# cf-lite — design

**Premise.** Next.js on Workers (OpenNext, vinext) runs a router, middleware and framework runtime inside
the Worker for *every* request — including a redirect-only route. cf-lite is what you get if you refuse that:
a plain Vite front end + a plain Hono Worker, packaged as conventions and one Vite plugin. All framework work happens
at **build time**; at request time there is Workers static assets, Hono, and your code.

> Name: `cf-lite` / `create-cf-lite` are free on npm (checked 2026-09-30, both 404). No rename needed.

## Request path (the hard requirement)

```
request ──► Workers static assets ──► file found?  yes ─► served, Worker NOT invoked
                   │                     (HTML, JS, _redirects, _headers, prerendered pages, SPA fallback)
                   └─ matches run_worker_first ([/api/*, <ssr routes>]) ─► Worker ─► Hono ─► your handler
```

* `wrangler.jsonc` → `assets.run_worker_first = ["/api/*"]`; the plugin **appends** one glob per `render = "ssr"` route.
  Nothing else can reach the Worker.
* Redirects and headers are `public/_redirects` / `public/_headers` — handled by the assets layer, zero Worker
  invocations, no CPU time billed.
* `assets.not_found_handling = "single-page-application"` gives SPA routes their `index.html` without the Worker
  (switches to `"404-page"` when `/` is a static page — see [Precedence](#precedence-what-answers-a-request)).
* In the Worker, the only framework code is the generated `.cf-lite/app.ts`: a plain Hono app
  (`.route("/api", api)` + one `.get(path, ssr(...))` per SSR page). `ssr()` is ~40 lines in `cf-lite/server`.

## Pieces

| piece | what it is | size |
|---|---|---|
| `cf-lite/vite` | Vite plugin array: the adapter's framework plugin(s) + `@cloudflare/vite-plugin` + a generator that scans `app/routes/**` and `server/api/**` and writes `.cf-lite/{routes,app,meta}` | ~70 LOC + scan/generate ~150 |
| `cf-lite/client` | framework-free router: `createRouter`, `navigate`, `handleLinkClick`, head updates. The adapter renders `router.current` (layouts stay mounted via the UI framework's own reconciliation) | ~100 LOC |
| `cf-lite/adapter` | the `UiAdapter` contract (types + `defineAdapter`) | types only |
| `cf-lite/server` | `ssr()` — layouts + head + the adapter's stream into the built HTML shell | ~50 LOC |
| `@cf-lite/react｜preact｜vue｜svelte｜solid` | UI adapters: `mount`/`Link`, server `render`, Vite plugin, scaffold descriptor (see `docs/adapters.md`) | ~60-90 LOC each |
| `cf-lite/head` | `Head` types; merge + string-inject (static/ssr) + DOM apply (SPA) | ~85 LOC |
| `cf-lite prerender` | build step: loads `render = "static"` routes through a throwaway Vite SSR server in Node, writes `<path>/index.html` (+ SPA-shell copies, see below) | ~70 LOC |
| `cf-lite` CLI | `dev` = `vite dev`, `build` = `vite build` + prerender, `deploy [--env x]` = fresh build for that env + `wrangler deploy`, `prepare` = regenerate, `add <ui>` = install + wire an adapter | ~110 LOC |
| `create-cf-lite` | minimal template (renderer none) + the same `add` code for `--ui` (tested: every scaffold is built and run under workerd) | ~40 LOC |
| optional modules | `cf-lite/modules/sso`, `/d1`, `/kv-cache`, `/e2e-login` — only bundled if imported | ~130 LOC |

No runtime package sits between you and workerd. `server/worker.ts` is yours:

```ts
import app from "../.cf-lite/app";
export { Room } from "./room";                       // Durable Object — exported verbatim
export default { fetch: app.fetch, scheduled() {…} } // add queue(), email(), tail()… as you like
```

## Conventions

```
app/routes/index.tsx          →  /              SPA (default)
app/routes/about.tsx          →  /about         export const render = "static"   (prerendered at build)
app/routes/posts/[id].tsx     →  /posts/:id     export const render = "ssr"      (streamed in the Worker)
app/routes/docs/[...rest].tsx →  /docs/*
app/routes/_layout.tsx        →  (no URL)       wraps every page; app/routes/posts/_layout.tsx wraps posts/** inside it
server/api/hello.ts           →  /api/hello     default export = a Hono app
server/worker.ts                                 Worker entry (yours)
public/_redirects, _headers                      static redirects / headers
app/main.tsx                                     3 lines: mount(routes)
```

Per-route exports: `render` (`"spa"|"static"|"ssr"`), `head` (below), `title` (shorthand for `head.title`),
`hydrate = true` (ship the JS and hydrate; **off by default** — static/ssr pages ship zero JS), `loader(c)` (ssr only; receives
the Hono context, result arrives as `props.data`).

### Nested layouts (v0.2)

`app/routes/**/_layout.tsx` is not a route; it wraps every page in its directory **and all subdirectories**, outermost
(closest to `app/routes/`) first: `<Root><Posts><Page/></Posts></Root>`. One file convention, three render modes:

* **SPA** — the client router loads page + layout modules and composes them; layouts stay mounted across client navigations
  between pages that share them (same component type at the same position, so React keeps state).
* **static** — composed at build time by the prerender, same tree.
* **ssr** — the generated Worker app imports the layout modules and composes them around the page in the stream.

A layout is `export default function Layout({ children, params })` and may also export `head`. One `_layout` per directory
(two is a build error). Layouts do not get `loader` data (keep data on the page). A layout that imports the adapter's
`Link` is fine in an SSR Worker: client-only code is tree-shaken (`sideEffects: false`, `mount` in its own module) — this
was measured: it took the demo-shaped Worker from 211 KiB to 111 KiB gzip.

### Head management (v0.2)

```ts
export const head = { title: "About", meta: [{ name: "description", content: "…" }], link: [{ rel: "canonical", href: "…" }] };
// or, for ssr, a function of the route params + loader data:
export const head = ({ params, data }) => ({ title: `Post ${params.id}` });
```

Heads of the layouts and the page are merged outer → inner: `title` = innermost defined; `meta` de-duplicated by
`name`/`property`/`http-equiv`/`charset`; `link` by `rel+href` (`canonical`, `icon`, `manifest` are singular). Inner wins.

* **static / ssr**: injected into the HTML shell as a string (prerender at build, `ssr()` per request) — `<title>` replaced,
  `<meta>`/`<link>` added with `data-cf-head`; an unmanaged tag in `index.html` with the same key (e.g. a default description)
  is replaced, so no duplicates. Works with zero client JS.
* **SPA navigation**: after the route's modules load, the client removes the previous `data-cf-head` tags, restores any
  `index.html` defaults it had hidden, applies the new ones and sets `document.title` (falling back to the title the HTML
  shell had, remembered in `<title data-cf-base>`). Initial SPA load applies the head client-side (SPA pages have no
  server-rendered head — that's what `static`/`ssr` are for).
* Not supported: `<script>`/`<style>`/`<base>` tags in `head`, `htmlAttributes`/`bodyAttributes`.

### Precedence: what answers a request

1. **Existing file in the assets layer** — prerendered static pages (`/about/index.html`), *SPA-shell copies*, `public/*`, built
   JS/CSS. Exact match wins; the Worker is never invoked.
2. **`run_worker_first` globs** (`/api/*` + one per SSR route) — these are checked *before* the file lookup, so an SSR route
   shadows a same-path file. They are the only things that reach Hono.
3. **Fallback** for everything else: `not_found_handling`.
   * `/` is SPA/ssr (default): `"single-page-application"` — any unknown navigation gets `index.html` (the SPA shell, status 200).
   * **`/` is `render = "static"`** (v0.2): `index.html` *is* the prerendered home page, so it cannot be the SPA shell.
     The prerender instead writes the pristine shell to `<path>/index.html` for **every fixed-path SPA route** and to
     `404.html`; assets run in `"404-page"` mode. Consequences: SPA routes still never invoke the Worker; an unknown URL is a
     real **404** (status + the client router's 404 view) instead of a soft-200 fallback; **dynamic SPA routes (`[id]`,
     `[...rest]`) cannot coexist with a static `/`** (no file to serve for them) — build error, make them `ssr`.
     `vite dev` keeps the SPA fallback (no prerendered files in dev).
   * Among routes of the same kind the matcher prefers static segments > `:param` > splat (unchanged).

### UI adapters: `cfLite({ renderer: react() })` (v0.3)

The core imports no UI framework. `renderer` is a `UiAdapter` (from `@cf-lite/react|preact|vue|svelte|solid` or your own) or `"none"` (default: no page routes, your own `index.html`,
API + static assets only). An adapter supplies the framework's Vite plugin(s), the extensions of route files, and two module specifiers: a *client* module (`mount`, `Link`) and a *server* module
(`render` -> stream/string, `renderToString` for the build-time prerender). The generated `.cf-lite/app.ts` imports the server module only when an SSR route exists, so an SSR-free app still bundles no renderer.
Full contract, what the core owns vs the adapter, and the per-framework notes: [`docs/adapters.md`](adapters.md). Preact (native, with `react`->`preact/compat` aliases via `@preact/preset-vite`, now with HMR)
is an adapter of its own; its measured effect is in `bench/RESULTS.md` / `bench/RESULTS-adapters.md`.

**Worker bundles are minified** (`cfLite({ minifyWorker: false })` opts out): every non-client Vite environment gets `build.minify: true` unless you set it.

**Static pages** are rendered in Node during `cf-lite build`; **SSR pages** run `renderToReadableStream` in the Worker using
the built `index.html` as the shell (saved as `/_shell.tpl` — not `.html`, because assets would 308 `/x.html` → `/x`).

**Types, no codegen step.** `.cf-lite/app.ts` is a real `.ts` file chaining `.route()` calls, so
`hc<ApiType>("/api")` (hono/client) is fully typed. The plugin rewrites it on file add/remove/change in dev
and on every build; `cf-lite prepare` does it for CI typechecks.

**Dev.** `vite dev`: React HMR for the front end, workerd (real bindings, DOs, WebSockets) for the Worker, both from
one process. Verified: SPA, static (rendered client-side in dev), SSR, API, WebSocket all work.

**Dev, route files added/removed (v0.2).** The generated `.cf-lite/*` files update live as before. `run_worker_first` lives in the
Cloudflare plugin's resolved config, which cannot be hot-swapped, so when a file event changes the *routing signature*
(set of SSR globs — an ssr route appeared/vanished or a route flipped to/from `render = "ssr"`) the plugin calls
`server.restart()` itself (logs `[cf-lite] routing changed … restarting dev server`). No manual restart; editing a route body,
adding/removing SPA/static routes, or editing an SSR route's body does **not** restart (covered by `scripts/dev-e2e.mjs`:
asserts exactly 2 restarts for add-ssr + remove-ssr, 0 for the rest). Cost: a restart re-spawns workerd (~1–2 s) and drops open
WebSockets/DO connections in dev.

## Deliberately NOT supported

| Next feature | cf-lite |
|---|---|
| Server Components / server actions | no — SSR is plain React to a stream; mutations are Hono routes |
| Middleware | no — a Hono `use()` on the routes that need it. Static assets never pass through it |
| ISR / `revalidate`, `next/cache` | no — use `_headers` cache rules, KV (`cf-lite/modules/kv-cache`), or rebuild |
| `next/image` optimizer | no — Cloudflare Images / pre-sized assets |
| Parallel/intercepting routes, `default.tsx`, `template.tsx`, per-layout loaders | no (route groups: see [routing.md](routing.md); nested `_layout.tsx` is supported since v0.2) |
| Dynamic static routes (`generateStaticParams`) | no — `static` + `[param]` is a build error; use `ssr` |
| Dynamic SPA routes (`[id]`) next to a static `/` | no — build error (fixed-path SPA routes are fine, see Precedence) |
| Redirects/rewrites in config, `headers()` | `_redirects` / `_headers` only (assets-layer syntax and limits apply) |
| Node-only APIs / Node runtime | Workers runtime only. That is the point |
| Non-Cloudflare targets | no |
| `_redirects` in `vite dev` | not applied in dev (assets layer is not emulated by Vite); works in `preview` and prod |

## Comparison

| | cf-lite | Next + OpenNext | vinext |
|---|---|---|---|
| Programming model | Vite SPA + Hono, opt-in static/SSR per route | Next App Router (RSC, actions, ISR, middleware) | Next API on Vite + RSC |
| Code on a redirect request | none (assets layer) | Worker → OpenNext runtime → Next routing (`redirects()`) | Worker → vinext handler (`redirects()`): ~+3 ms over floor |
| Code on a static page | none | Worker (in our bench `/about` entered the Worker: ~33 ms over floor) | Worker |
| Code on an API request | Hono | OpenNext + Next route handler runtime | vinext handler + route handler |
| Build | `vite build` + tiny Node prerender | `next build` then `opennextjs-cloudflare build` (esbuild repack) | `vite build` (rsc + ssr + client envs) |
| Cloudflare plugin | `@cloudflare/vite-plugin` 1.x (stable) | wrangler only | `@cloudflare/vite-plugin` 2.0 beta + `cf` CLI |
| Next compatibility | none | highest | high (goal) |
| When to pick it | you write the app; you want the Worker to do *only* what you wrote | you need Next semantics / existing Next code | you want Next semantics with Vite tooling |

Measured numbers (build time, bundle size, client JS, latency): [`bench/RESULTS.md`](../bench/RESULTS.md) — read its caveats first.

## Optional modules (all off by default)

* **SSO** `cf-lite/modules/sso` — verify-only Ed25519 (EdDSA) JWT cookie check, WebCrypto only, + `requireSso()` Hono middleware.
  Mount it per route; never global by default. Fully env-configured, no built-in issuer: `SSO_PUBLIC_KEYS` (JWKS or kid map),
  `SSO_ISSUER`, required `SSO_AUDIENCE` (fail-closed), optional `SSO_COOKIE_NAME`, `SSO_AUTH_ORIGIN` (for `ssoLoginUrl`), `SSO_ALLOWED_LOGINS`, `SSO_REFRESH_AFTER_S`.
* **D1** `cf-lite/modules/d1` — `d1(db).all/first/run/batch` with bound params. No ORM.
* **KV** `cf-lite/modules/kv-cache` — `cached(kv, key, ttl, compute)`.

## `@cloudflare/vite-plugin` 2.x — tried 2026-09-30, not adopted yet

`npm view @cloudflare/vite-plugin dist-tags` → `latest: 1.62.2`, `beta: 2.0.0-beta.sha-ad79608dd`: **there is no 2.x GA**, so this is the beta.
`node scripts/try-plugin2.mjs` (a scratch copy; the repo is untouched) reproduces the spike: it **works** — `vite build` + prerender,
`vite preview` and `vite dev` all behave correctly on `examples/site` (static `/`, SPA routes, SSR route via `run_worker_first`, only SSR + `/api/*` reach the Worker, unknown URL = 404).
What changes in 2.x, and why cf-lite stays on 1.x (`^1.62.2`) by default:

* **`wrangler.jsonc` is no longer read** — the Worker is described in `cloudflare.config.ts` (`@cloudflare/config`, camelCase:
  `assets.runWorkerFirst`, `notFoundHandling`, bindings as `env: { ASSETS: bindings.assets() }`; DOs via `exports`, crons via `triggers`).
  The plugin's `config` customizer is validated against that schema, so the keys cf-lite injects differ. cf-lite now detects the installed
  plugin major and emits the right shape (`vite.ts`), and the prerender finds the new output dir — that part is in and exercised by the spike.
* **Output moves** from `dist/<worker>/` + `dist/client/` (+ redirect `wrangler.json`) to `.cloudflare/output/v0/workers/default/{bundle,assets}`;
  it is deployed with the `cf` CLI (`cf deploy`), not `wrangler deploy`, and `wrangler dev` cannot serve it. Every harness here (`e2e.mjs`, the
  Playwright `webServer`, `deploy`, the bench) uses wrangler — moving means rewriting all of them *and* the demo's config, for a beta.
* Friction seen: the build probes the Docker socket (`failed to connect to the docker API…` on a host without Docker; harmless), and worker bundles are
  not minified in either version (same 1,086,331-byte SSR Worker on 1.x and 2.x for the same app).
* Not tried: `cf deploy` of a cf-lite app (would create a Worker on a real account; out of scope for the spike).

Revisit when 2.x is `latest`: swap the dependency, add a `cloudflare.config.ts` to `examples/*`, switch the e2e launchers to `cf`/`vite preview`.

## Known limitations / next steps

* SSR pulls the UI framework's server renderer into the Worker bundle (react 74 / vue 38 / preact 18 / svelte 17 KiB gzip minified, `bench/RESULTS-adapters.md`).
  An SSR-free app bundles none (the generated app only imports `cf-lite/server` + the adapter if an SSR route exists).
* Svelte SSR is not streamed (Svelte 5 `render()` is synchronous); Preact streams sequentially (no out-of-order Suspense).
* Vue route files: `render`/`head`/`loader` must be in a plain `<script lang="ts">` block (a `<script setup>` cannot export); page components must declare `params`/`data` props or Vue falls them through as DOM attributes.
* Prerender runs the page in Node through a Vite SSR loader; route modules for `static` pages must not touch Worker-only APIs.
* Dev restart on routing change re-spawns workerd (see Dev above); `_redirects` is not applied in dev.
* Client-side `Link` navigation to a *static* or *ssr* route is a normal document navigation (by design). Navigations between SPA routes
  that share a layout keep it mounted; `<Link>` prefetching is not implemented.
* Layouts: no per-layout `loader`. Head: no `script`/`style`/`html` attributes.
* No `generateStaticParams`.

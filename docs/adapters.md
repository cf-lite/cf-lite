# cf-lite UI adapters

Direction (maintainer, 2026-09-30): **cf-lite stays UI-agnostic.** A UI framework is an optional, ready-made integration you install with one
command — nobody hacks the core to use Vue or Svelte. Core = Vite + Hono + Workers assets + file conventions + head + prerender
orchestration. An *adapter* = everything that knows what a "component" is.

## 1. What we studied, what we copy, what we avoid

Sources: Astro docs (integrations reference, `addRenderer`, `astro add`), Vike docs (extensions, `+onRenderHtml`, Cloudflare, migration/server),
TanStack Start docs/architecture, plus the framework docs for Vue / Svelte SSR APIs. Claims below marked *(docs)* come from those pages (fetched 2026-09-30);
*(measured)* ones are from this repo or the scratch spike in §2. I did **not** read Astro/Vike/TanStack source code — only docs.

| System | How a UI framework plugs in | Copy | Avoid |
|---|---|---|---|
| **Astro** | An *integration* is an object with hooks (`astro:config:setup` …). A UI framework is a *renderer*: `addRenderer({ name, clientEntrypoint, serverEntrypoint })` — two module paths, server one exports `check` + `renderToStaticMarkup`, client one hydrates an island. `updateConfig` merges Vite plugins. `astro add x` installs the package **and edits `astro.config`** *(docs)* | The split **server entry / client entry as module specifiers** (no function crosses the build boundary — the Worker/browser only ever imports plain modules). `add` command that installs + edits config idempotently. Integration as a *factory returning data + Vite plugins*. | Island model (per-component hydration) — cf-lite hydrates a whole page; `check()` auto-detection between renderers — we have exactly one UI per app, so no runtime dispatch. |
| **Vike** | "Extensions" (`vike-react`, `vike-vue`) are packages with a `+config.js` that set `onRenderHtml` / `onRenderClient`, `Page`/`Layout`/`Head` settings; everything is a *setting* in a cumulative config system *(docs)*. The same public API a user would use ("extensions use the same API you use"). | The **principle**: adapters use only the public contract, so a user can write their own (Lit, htmx) without touching cf-lite. One adapter package per UI framework, named `<prefix>-<ui>`. Head/Layout as first-class per-route settings — we already have `_layout` + `head`. | The config-as-settings meta-system (`+config.js` cumulative/env-split settings) and `pageContext` — a large surface for something we resolve at build time with a file scan. Vike's server story: see §2. |
| **TanStack Start** | Router/start *core* packages are framework-agnostic; per-UI packages (`react-start`) wrap them *(docs page unavailable when fetched — this is from general knowledge, unverified)*. | Same shape we are aiming for: agnostic core + thin UI package. | Its router/server-function runtime in the Worker for every request — the thing cf-lite refuses. |

## 2. Should cf-lite build on Vike? — No. Evidence

cf-lite's hard rules: (1) zero framework code on the request path for static/redirect, (2) small Worker, (3) Cloudflare-native,
(4) build-time generation.

* **(1) static/redirect.** Vike can prerender and the assets layer would serve those files first, so this rule is *not* a blocker in principle *(docs: "pre-rendered pages are statically deployed while your SSR pages are served dynamically")*.
  But Vike's model is "every non-asset request goes to `renderPage()`" — there is no equivalent of `run_worker_first` scoped to SSR route globs, so an unknown URL enters the Worker and Vike's router instead of a real assets-layer 404/SPA fallback. cf-lite's scan already knows the exact SSR globs at build time.
* **(3) Cloudflare-native — the decisive, measured point.** I tried to build the smallest possible Vike app (`vike` 0.4.267, `vike-react` 0.6.29, `pages/index` + prerendered `pages/about`, Hono API route) for Workers on 2026-09-30, timeboxed to ~15 minutes:
  * `vike-photon` (what `vike.dev/vike-photon` still documents) prints `vike-photon is deprecated, see vike.dev/migration/server`;
  * the replacement (`+server.ts` + `@vikejs/hono`) built, but the output `dist/server/index.mjs` is a **Node server** (top-level `await startServer()`, `node:fs`/`node:zlib`/`node:stream` imports, `process.env.NODE_ENV` assignment); `wrangler deploy --dry-run` fails with `Top-level await is currently not supported with the "iife" output format` / `Unexpected external import of node:fs…`;
  * adding `@cloudflare/vite-plugin` with `main: "virtual:vike-server-entry"` failed: `Failed to resolve main entry file`.
  I could not get a Worker bundle in 15 min. That is **not proof it is impossible** (Vike docs say Cloudflare is supported through `vike-cloudflare`, which I did not try — 0.2.8), only that the Cloudflare path is in flux and is not something cf-lite can sit on without inheriting that churn. Reproduce: `/tmp/vike-spike2` (scratch, not committed) — `npx vike build && npx wrangler deploy --dry-run`.
* **(2) small Worker / (4) build-time.** Vike ships its router + page-config runtime (virtual modules) into the server bundle. I have no measured Worker size for it because of the above, so no number is claimed. cf-lite's core-only Worker is 14.9 KiB gzip (`bench/RESULTS.md`).
* **What building on Vike would cost us:** dropping `run_worker_first` scoping, the generated plain-Hono `app.ts`, `_redirects`-only redirects, our `hc<ApiType>` typed API, and the benchmark story, in exchange for getting React/Vue extensions that already exist. Conversely Vike's extension quality is real: `vike-vue` has years of edge cases handled. cf-lite's adapters will be *thinner* (no islands, no pageContext) and therefore less capable — that is the trade, and it is acceptable for the target (API + mostly-static sites).

**Recommendation: keep cf-lite's own adapter layer**, modelled on Astro's renderer split (server entry + client entry modules) with Vike's "extensions only use the public contract" discipline. Revisit if Vike ships a first-class Workers build that keeps static/redirect off the Worker. No migration was started.

## 3. SSR on workerd, per framework

Only what is relevant to adapters. *(docs)* = from the framework docs, *(measured)* = built and run on local workerd in this repo (see `bench/RESULTS.md` adapter section and the shared e2e).

| | SSR API used | Streaming | Hydration | Vite plugin / HMR | workerd notes |
|---|---|---|---|---|---|
| **React 19** | `react-dom/server` `renderToReadableStream` | real (Suspense, out-of-order) | `hydrateRoot` | `@vitejs/plugin-react` (Fast Refresh) | needs the `browser`/`workerd` export condition (Vite cloudflare plugin sets it) so it picks `react-dom/server.browser`; ~109 KiB gzip in the Worker *(measured, RESULTS.md)* |
| **Preact 10** | `preact-render-to-string/stream` `renderToReadableStream` | sequential chunks (no out-of-order Suspense) | `hydrate` | `@preact/preset-vite` (prefresh HMR; also aliases react→compat) | ~29 KiB gzip Worker *(measured)*. `preact/compat` semantic gaps remain if react-flavoured libraries are used |
| **Vue 3.5** | `vue/server-renderer` `renderToWebStream` / `renderToString` *(docs)* | yes (async components awaited in order) | `createSSRApp().mount()` | `@vitejs/plugin-vue` (HMR) | Node-only functions (`renderToNodeStream`, `pipeToNodeWritable`) must not be used; the web ones are fine. `<script setup>` cannot `export` — route config (`render`, `head`, `loader`) goes in a plain `<script lang="ts">` block next to it |
| **Svelte 5** | `svelte/server` `render(Component, { props })` → `{ body, head }` *(docs)* | **no** — sync string (async SSR needs `experimental.async`), adapter emits one chunk | `hydrate(Component, { target, props })` | `@sveltejs/vite-plugin-svelte` (HMR) | component must be compiled with the server option — vite-plugin-svelte does this per environment; `svelte:head` content comes back in `head`, which the adapter merges into the shell. Route config lives in `<script module>` |

## 4. The adapter contract

*(Implemented as designed, with the deviations listed at the end of this section. Types: `packages/cf-lite/src/adapter.ts`.)*

An adapter is an npm package `@cf-lite/<ui>` whose default export is a **factory** returning a plain object:

```ts
// cf-lite/adapter  (types only, shipped by the core)
export interface UiAdapter {
  /** Package name; the prerender step re-imports the adapter by it (it runs outside the user's Vite config). */
  id: string;
  options?: unknown;              // JSON-serialisable factory options, kept in .cf-lite/meta.json for prerender
  extensions: string[];           // route/layout file extensions: [".tsx",...] / [".vue"] / [".svelte"]
  client: string;                 // module specifier, e.g. "@cf-lite/vue/client"  (mount, Link, useParams, navigate)
  server: string;                 // module specifier, e.g. "@cf-lite/vue/server"  (render, renderToString)
  vite(): { plugins: PluginOption[]; config?: UserConfig };   // framework plugin + aliases; used by the build AND the prerender server
}
// Static description for `cf-lite add` / create-cf-lite, exported separately as `@cf-lite/<ui>/scaffold` (never shipped to an app bundle):
export interface AdapterScaffold { deps; devDeps?; tsconfig?; entry: { file; content }; starter: Record<path, content> }
```

Runtime modules (what actually runs in browser / Worker / Node-prerender):

```ts
// server module - runs in the Worker (ssr routes) and in Node (static prerender)
render(view: View): Promise<{ body: ReadableStream<Uint8Array> | string; head?: string }>;
renderToString(view: View): Promise<{ body: string; head?: string }>;
// client module - browser only
mount(routes: ClientRoute[], el?: Element): Promise<void>;       // hydrate when el has data-ssr, else render
Link, useParams, navigate;                                       // framework-native (Svelte: <Link> is a .svelte file; params are props)
interface View { Page: unknown; layouts: unknown[]; params: Record<string,string>; data?: unknown }   // Page === null -> the adapter draws its 404
```

How each concern maps:

| Concern | Owner |
|---|---|
| File scan, route table, `run_worker_first`, `_redirects`, 404 precedence | **core** (extensions come from `adapter.extensions`) |
| Head merge, string injection, DOM apply | **core** (`cf-lite/head`; adapters never see `<head>`, except Svelte's `head` string which core merges) |
| Client router state: match, navigate, popstate, view loading (`{Page, layouts, params, data}`), head apply | **core** (`cf-lite/client` `createRouter` -> `router.current` + `subscribe`, framework-free, ~100 LOC) |
| Turning a `View` into a DOM tree, keeping layouts mounted on navigation, `Link`, `useParams` | **adapter client** (subscribes to `router`, re-renders) |
| SSR to a stream/string, the `<div id="root" data-ssr>` splice and shell handling | core `ssr()` does the splice; adapter only produces `body` |
| Build-time prerender | core drives Vite SSR server + `adapter.vite()`; calls `adapter.server.renderToString` |
| Client mount vs hydrate | adapter reads `el.hasAttribute("data-ssr")` (core puts it there) |
| Dev HMR | the framework's own Vite plugin, returned from `adapter.vite()` |
| Route-module typing | adapter ships ambient types (`@cf-lite/vue/env` declares `*.vue`; react/preact are plain TS) |

Rules that keep the core honest:
1. Core has **no** `react`/`vue`/`svelte` import anywhere. With `renderer: "none"` (default) `app/routes` pages are ignored, the plugin adds no UI plugin, and the SPA/`index.html` is yours (API + static-HTML apps such as usage-meter).
2. `cf-lite/server`'s `ssr()` takes the adapter's server module as an argument (`ssr(mod, { ui, … })`, `ui` imported by the *generated* `.cf-lite/app.ts` from `adapter.server`) — it does not import it, so an app with no SSR route bundles no renderer, same as today.
3. Adapters import only `cf-lite/*` public subpaths.

**Deviations between this design and what was built** (found while implementing, all kept):
* `scaffold` is *not* a field of `UiAdapter`; it is a separate `./scaffold` export, so `cf-lite add` can read it without constructing the adapter and so it can never end up in a bundle.
* `mount` lives in its own module per adapter (`mount.ts`) and `client.ts` re-exports it: a layout importing `Link` into an SSR Worker otherwise drags `react-dom/client` (measured: React Worker 140 KiB -> 77 KiB gzip once split).
* Svelte layouts are composed by two small `.svelte` files shipped in the package (`lib/Root.svelte`, `lib/Nest.svelte`, recursive dynamic component) because a Svelte layout receives its page as a `children` snippet; there is no `h()` equivalent.
* Vue `useParams()` returns a computed ref; Svelte has no `useParams` (pages and layouts get `params` as a prop). React/Preact return the plain object.
* Unknown-adapter and no-adapter cases fail at build with the command to run (`cf-lite add ...`), never silently.

### Choices, with reasons

* **Preact is its own package (`@cf-lite/preact`), not an option on `@cf-lite/react`.** React and Preact differ in every adapter touchpoint
  (render/hydrate APIs, stream function, Vite plugin) — an option would be an `if` in every function. Native Preact + `@preact/preset-vite`
  also gives prefresh **HMR**, which the old alias-only `renderer: "preact"` did not (full reload on edit). The preset's react→`preact/compat` alias is kept on (`compat: true`, default),
  so the existing react-flavoured `examples/site` still builds unchanged for the bench.
* **Factory returns data, functions stay out of the Worker/browser.** Learned from Astro: only specifiers cross into bundles.
* **`renderer: "react"` string is removed** (breaking, 0.3): `cfLite({ renderer: react() })`. A string would force the core to depend on every adapter. The error for a missing adapter says what to install.
* **Whole-page hydration, no islands.** Same as 0.2.
* **`cf-lite add <ui>`** installs `@cf-lite/<ui>` + its framework deps, rewrites `vite.config.ts` (`renderer: <ui>()`), writes the entry + starter route if absent; every step guarded so re-running changes nothing. **`npm create cf-lite@latest my-app -- --ui none|react|preact|vue|svelte|htmx`** = the `none` template + the same `add` code path (one implementation, tested once).

### htmx + Alpine preset (0.4)

Not an adapter: there is no component model, so nothing implements `UiAdapter`. `cf-lite add htmx` / `create-cf-lite --ui htmx` keeps `renderer: "none"`
and drops in `server/api/ui.ts` (Hono routes returning `hono/html` fragments, which escape interpolations by default), an `app/main.ts` that starts htmx + Alpine,
the `htmx.org` / `alpinejs` dependencies, and `hx-get="/api/ui" hx-trigger="load"` on `<div id="root">`. The preset lives in `packages/cf-lite/src/presets.ts`
(`PRESETS`), reuses the same idempotent `addUi` code path and adds no vite config. Trade-offs: no static prerender of fragments (the shell is an SPA `index.html`),
no layouts/`head` per route (fragments are not pages), htmx + Alpine (~38 KiB gzip) ship on every page, and htmx's `hx-on`/`hx-vals="js:"` need `eval` (Vite warns about it at build; it is not used by the starter).

## 5. Out of scope for this round (noted, not built)

npm publish (written at 0.3.0; since published at 0.4.0, see [published.md](published.md)) (all packages were 0.3.0 and `npm pack`-able; names `@cf-lite/*` and `cf-lite`/`create-cf-lite` unverified on the registry for the scope); OSS prep (LICENSE file, CI, changelog).

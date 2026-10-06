# ADR: SSR islands (Astro-style partial hydration, no RSC)

Status: implemented on `feat/ssr-islands` (opt-in, React and Preact adapters; Vue added in `feat/next-parity-2`, see "Vue" below). User guide: [../islands.md](../islands.md).
Context: [next-parity.md](../next-parity.md) lists "no zero-JS interactive islands inside an SSR page" as the largest gap next to RSC. [rsc.md](../rsc.md) closes it for React with `"use client"`; islands close it for everyone else and for sites that want no Flight runtime.

## Decision summary

| Question | Choice | Why |
|---|---|---|
| Marking | file suffix `*.island.tsx` / `*.island.jsx` | zero API to learn or hallucinate: an LLM or dev writes a normal component, names the file, imports it normally. No wrapper component, no directive on every use site, types stay the component's own types. |
| Strategy | `export const client = "load" \| "idle" \| "visible" \| "interaction"` in the island file (default `load`) | a strategy is a property of the component (a chart is always `visible`), so it lives next to it; no per-use prop that would have to be typed on every component. |
| Props | JSON only, validated at render: functions, elements/`children`, Date, Map, class instances, NaN throw with the island id and prop path. 8 KiB warns (dev), 64 KiB throws, `cf-lite doctor` CFL017 flags built pages | props travel in the HTML (`data-p`); keeping them plain JSON makes escaping and size predictable. |
| Where props live | `data-p` attribute on `<cfl-island>`, escaped by the renderer | React/Preact escape attribute values; an inline `<script type=application/json>` needs a custom `<` escape and a CSP hash/nonce. Cost: `&quot;` inflation (~15%), accepted. |
| Wrapper element | `<cfl-island data-i data-p data-w>` + one `<style>cfl-island{display:contents}</style>` | `display:contents` keeps layout identical to the un-islanded component. Style is added with the runtime tag, so it is hashed (static) / nonced (SSR) like every other inline block. |
| Client runtime | `cf-lite/islands-client` (~1 KB gz) + adapter `mount()`; default React (`hydrateRoot`), option `islands: { runtime: "preact" }` (preact/compat alias in the client environment only) | see measurement below. |
| Chunks | one virtual entry `islands` (id -> `() => import(file)`), so every island is its own dynamic chunk; React/Preact lands in one shared chunk | an island's code is fetched only when its strategy fires. |
| Finding the runtime | client build writes `_islands.json` (`runtime` = the entry URL, `preload` = its static import closure, `islands[id] = { w, deps }` = strategy + chunk files); the Worker (`ASSETS.fetch`) or the prerender reads it | the shell (`index.html` / `_shell.tpl`) stays untouched, so non-island apps are byte-identical. |
| Injection | SSR: generated app wraps the page handler with `islandsRoute` (stream transform: sees `<cfl-island`, collects the island ids, inserts style + `<link rel=modulepreload>` hints (runtime closure + the chunks of the `load` islands on the page) + script before `</body>`, nonce from `c.get("cspNonce")`). Static: `prerender.ts` does the same on the string | no change to `ssr()` / `server.ts`; apps without island files get no wrapper at all. |
| `hydrate = false` pages | the normal case: no page bundle, no `window.__CF_LITE_DATA__`, only the island runtime | |
| `hydrate = true` pages | islands render the same markup and are hydrated by the whole-page hydration; the island runtime is **not** added (only the style) | avoids double hydration; one rule: a page either hydrates as a whole or by islands. |
| Dev (`cf-lite dev`) | whole-page hydration (the existing dev behaviour keeps the page scripts); islands are interactive, strategies are not simulated | HMR works; strategy timing is a production concern, covered by the e2e. |
| Streaming | works: late Suspense content (incl. islands) is moved by React's own inline script before the module runtime runs | e2e `/live`. Under a strict CSP React's inline streaming scripts carry no nonce today (pre-existing, not islands-related). |
| i18n / draft | unaffected: nothing in them touches rendering; the markup is a normal element tree | |
| RSC routes | out of scope: islands are SSR-only; a project with any `render = "rsc"` page does not enable islands (RSC keeps `"use client"`) | one mechanism per app. |

## Interaction replay

An `interaction` island has no handlers until hydrated. Triggers: `pointerover`, `focusin`, `touchstart`, `click`, `keydown` (first one wins). Hydration is synchronous (`flushSync(hydrateRoot)`) and a click that landed before or during the load is replayed on its target afterwards (e2e: `menu-btn`).

## Measurement: React vs Preact compat as the client runtime

`examples/site-islands`, page `/` with six island kinds, all strategies triggered, gzip of every JS response (Chromium, local workerd):

| Runtime | JS transferred (gzip) | of which runtime chunk |
|---|---|---|
| React 19.3 (`react-dom/client`) | **70.3 KB** | 67.9 KB |
| Preact 10 compat (`islands: { runtime: "preact" }`) | **12.4 KB** | 4.2 KB |

The same 9 browser tests (hydration per strategy, XSS, shared chunk, streaming, strict CSP) pass on both.

**Default stays `react`**, opt in to `preact`. Preact/compat is 5.7x smaller and passed every test, but: (1) it needs `preact` installed in the app, (2) the page is rendered by real React on the server and hydrated by Preact: ids from `useId` differ by design, React-19-only APIs (`use`, `useActionState`, `useOptimistic`, form `action` functions) are not guaranteed, and the alias is global to the client build (a `hydrate = true` page in the same app also runs on Preact). That is a trade the app owner should choose knowingly; flipping the default is one line in `vite.ts` if the owner prefers size over exactness.

## Performance review (2026-10-02, Foundation product + home page)

Question: local Lighthouse on the Foundation product page gave vanilla 99, islands-react 88, islands-preact 85, RSC 75. Is hydration costly? Details and raw numbers: the CMS starter repository's islands comparison.

**Root cause of the lab gap: Lighthouse's simulated throttling (Lantern), not hydration.**
* Unthrottled, the browser sees the same page: observed LCP 241 ms (vanilla) vs 237 ms (islands); the LCP element is the hero `<img>` in the HTML, no island touches it.
* Lantern rebuilds the LCP dependency graph from every request that *finished before the observed LCP* (~240 ms on localhost) and replays it on a 1.6 Mbps / 4x CPU model as render-blocking. Island JS (80 KB gz) lands inside that window on a fast server, vanilla's 8 KB barely registers. Same page with Lighthouse's *applied* throttling (`--throttling-method=devtools`): vanilla 99, islands-react 99, no JS 99. Stripping all scripts from the simulated run gave 98.
* The score is bimodal for identical runs (84 to 98) depending on which side of the cut-off a request ends, so "preact slower than react" (85 vs 88) was noise inside a 81-98 spread, not a finding. Local numbers also moved ~10 points with machine load (shared CPU).
* On workers.dev (real RTT, edge image resize, Lighthouse mobile, median of 5) the gap does not exist:

| page | vanilla | islands react | islands react + modulepreload | islands preact + modulepreload | RSC |
|---|---|---|---|---|---|
| product perf (runs) | 100 (5x100) | 100 (5x100) | 100 (5x100) | 100 (5x100) | 98 (100 98 98 96 98) |
| product LCP ms / TBT ms | 1268 / 0 | 1389 / 0 | 1267 / 0 | 1400 / 0 | 2141 / 26 |
| home perf (runs) | 99 (99 99 100 99 99) | 98 (97 98 98 98 98) | 97 (5x97) | 98 (98 98 98 100 98) | 97 (98 97 97 97 97) |
| home LCP ms / TBT ms | 2153 / 0 | 2447 / 0 | 2616 / 0 | 2312 / 0 | 2464 / 12 |
| client JS transferred (product) | 8.3 KB | 85.4 KB | 84.1 KB | 22.5 KB | 89.1 KB |

**Real defect found and fixed: a 4-hop module waterfall.** entry (`islands-*.js`) -> framework chunk -> `rolldown-runtime` -> island chunks -> `jsx-runtime`, each hop discovered only after the previous one arrived. Fix: `_islands.json` now lists the closure, and the page gets `<link rel="modulepreload">` for the runtime closure plus the chunks of the `load` islands it rendered (`idle`/`visible`/`interaction` islands are not preloaded: they are fetched when they fire). Verified on workers.dev (Slow-4G profile, 150 ms RTT / 1.6 Mbps, resource timing): all chunk requests start at the same instant (~690 ms) instead of in 4 steps (678 / 846 / 1086 / 1911 ms), the `menu` and `cart` chunks are in at ~1070 ms instead of ~2135 ms. **But hydration time did not improve** (median of 7: menu + cart hydrated at 2102 ms vs 2027 ms before, within noise): the critical path is the 66 KB gz react-dom chunk, which is bandwidth bound on that link. Modulepreload is kept (it removes the round-trip chain and costs 7 short `<link>` tags), but it is not what makes islands fast; the runtime size is.

**Default runtime decision: stays `react`.** Rule used: preact/compat becomes the default only if it is clearly better on live Lighthouse AND every Foundation islands function passes on it. Live Lighthouse: preact 100 / 98 vs react 100 / 98 (product / home), TBT 0 for both: not clearly better. Functions: 6 of 7 identical on both runtimes against the SSR head (the 7th, add to cart, differs only because the CMS cart endpoint answered 502 "cart unavailable" during the run; the pre-change build shows the same diff, so it is environmental, not the runtime). Where preact does win, and it is large, is time to hydrated on a slow link: same Slow-4G profile, `menu` + `cart` hydrated at 1149 ms (preact) vs 2027 ms (react), last script done at 1389 vs 2267 ms, 22.5 vs 85.4 KB JS. Guidance: choose `islands: { runtime: "preact" }` when real users are on slow mobile links and the island code does not use React-19-only APIs; the score does not show it, the stopwatch does.

**Strategy guidance (also in [../islands.md](../islands.md)).** `load` is the default and every `load` island is preloaded: keep it for controls the user can touch in the first seconds (menu, add to cart). Use `idle` for secondary widgets (quick view, variant select), `visible` for anything below the fold, `interaction` for dialogs. A page whose islands are all non-`load` still pays for the runtime script and its closure; it does not pay for the island chunks until they fire.

## Vue (added 2026-10-02)

The contract (`islands: { wrap, mount }`) was enough; two core touches. (1) `ISLAND_FILE` also matches `*.island.vue`. (2) An SFC is not JS, so the `pre` AST rewrite cannot see its default export: `islandVueTransform` runs with `enforce: "post"`, on the main module only (`?vue` sub-block requests are skipped), after plugin-vue compiled it, and takes the strategy from the SFC source (under the dev server the compiled main module re-exports the script block instead of containing it). The prerender server gets the same plugin (found the hard way: the static page was first built without wrappers because only the tsx transform was registered there). `@cf-lite/vue/islands` wraps with `h("cfl-island", ..., [h(Inner, attrs)])` (`inheritAttrs: false`; attrs are the props; a default slot throws via the same `children` check), `@cf-lite/vue/islands-client` mounts with `createSSRApp(Inner, props).mount(el)`. Verified: Chromium on workerd, static + streamed SSR, four strategies, no Vue hydration warnings. Not measured: bundle size vs React (Vue runtime is shared by all islands; the preload-helper chunk of the example is 26.6 KB gz).

## Non-goals (v1)

* `children` / slots across the boundary (Astro has slots; here: render children inside the island or split it).
* Per-use strategy override, `client:only` (no SSR) islands, islands in Svelte/Solid adapters (Vue was added through the same contract, see below; Svelte and Solid were not attempted, blockers in [../islands.md](../islands.md)).
* Shared state between islands (use a module-level store or events; islands are separate roots).

## Test map

* unit: `packages/cf-lite/test/islands.test.ts` (props validation, source rewrite, plugins, stream injection, convention, doctor), `client-islands.test.ts` (strategies under happy-dom).
* browser + workerd + strict CSP: `e2e/islands.spec.ts` (`PW_ONLY=site-islands npx playwright test`).
* non-island apps byte-identical: `sha256` of `dist/` for 10 examples before/after (see PR description).

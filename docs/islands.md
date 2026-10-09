# SSR islands

Status: **experimental** (React, Preact and Vue adapters). Runs: build (Vite), Worker / prerender (server HTML), browser (only the islands you wrote). Design and measurements: [design/islands.md](design/islands.md).

A page is rendered on the server as usual. Components that need to be interactive live in `*.island.tsx` files; only those are sent to the browser and hydrated, each on its own schedule. A page without islands ships **no JavaScript**.

```tsx
// app/islands/Counter.island.tsx - a normal React component
import { useState } from "react";

export const client = "visible"; // optional: "load" (default) | "idle" | "visible" | "interaction"
export default function Counter({ start = 0 }: { start?: number }) {
  const [n, setN] = useState(start);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}
```

```tsx
// app/routes/index.tsx - render = "static" or "ssr", hydrate left false
import Counter from "../islands/Counter.island";

export const render = "static";
export default function Home() {
  return <main><h1>Shop</h1><Counter start={2} /></main>; // server HTML now, JS when visible
}
```

That is the whole API: name the file `*.island.tsx|jsx` (Vue: `*.island.vue`, see below), `export default` the component, import it like any other. The Vite plugin does the rest (no config; active when an adapter that supports islands is used and island files exist).

## Strategies

| `client` | Hydrates | Use for |
|---|---|---|
| `load` (default) | as soon as the island runtime is loaded | above-the-fold controls |
| `idle` | `requestIdleCallback` (2 s cap; 200 ms timeout fallback) | secondary widgets |
| `visible` | when within 200 px of the viewport (`IntersectionObserver`) | below-the-fold: charts, carousels, comments |
| `interaction` | on the first `pointerover` / `focusin` / `touchstart` / `click` / `keydown`; a click that arrives early is replayed | menus, dialogs, "quick view" |

The island's own chunk is fetched only when its strategy fires, except `load` islands: their chunks, the island runtime and the framework chunk get `<link rel="modulepreload">` hints in the page so the browser fetches them in one round trip instead of four. Pick the weakest strategy that still feels instant: `load` for what a user can touch immediately, `idle` for secondary widgets, `visible` below the fold, `interaction` for menus and dialogs. What dominates hydration on slow links is the framework size, see the next section.

## Props

Props are serialised into the HTML (`data-p`) and must be plain JSON: strings, numbers, booleans, `null`, arrays, plain objects. Anything else throws at render time with the island id and the prop path (functions, React elements, **`children`**, `Date`, `Map`, class instances, `NaN`). Over 8 KiB logs a warning in dev, over 64 KiB throws; `cf-lite doctor` flags built pages with props over 8 KiB (CFL017). Pass an id and fetch the rest from the island.

Islands cannot take `children`. Render them inside the island, or split the island.

## Rules worth knowing

* `hydrate = true` pages hydrate as a whole, so islands there are plain components (no island runtime is added). Use one mechanism per page.
* Islands are separate roots: share state through a module-level store or DOM events, not React context.
* Nested islands: only the outermost hydrates on its own; inner ones are part of its tree.
* An island file must `export default` the component. `export const client` must be a string literal.
* Not supported in `render = "rsc"` apps (use `"use client"` there).
* The Svelte adapter does not implement islands. Not attempted, with this expected blocker: Svelte 5 `hydrate()` expects the hydration markers its own `render()` wrote around the component root, which a component nested inside a page's server output does not have. It needs adapter-specific server wrapping, not just the two modules of the contract.

## Vue (`*.island.vue`)

Same rules, with an SFC. Put the strategy in the plain `<script>` block (it cannot live in `<script setup>`); props are the component's props and must be plain JSON, slots cannot cross into the browser (an island that receives a slot throws at render):

```vue
<!-- app/islands/Counter.island.vue -->
<script lang="ts">
export const client = "idle"; // optional, default "load"
</script>
<script setup lang="ts">
import { ref } from "vue";
const props = withDefaults(defineProps<{ start?: number }>(), { start: 0 });
const n = ref(props.start);
</script>
<template><button @click="n++">{{ n }}</button></template>
```

The plugin wraps the *compiled* SFC (after `@vitejs/plugin-vue`), the server renders `<cfl-island>` around the component, and the browser hydrates it with `createSSRApp(Component, props).mount(el)`. Notes: an SFC cannot contain a literal closing script tag in a string (write `"<\/script>"`); the `runtime: "preact"` option is React-only and has no effect on Vue. Example `examples/site-islands-vue`, Chromium + workerd spec `e2e/islands-vue.spec.ts` (static and streamed SSR pages, all four strategies, escaping, no hydration warnings), unit tests `test/islands-vue.test.ts`.
* CSP: works with `security()`; the island `<style>` and `<script src>` are hashed (static pages) or nonced (SSR pages).
* Dev (`cf-lite dev`) hydrates whole pages, so strategies are not simulated; build and preview to see real timing.

## Auto-islands (React, opt-in)

Naming files `*.island.tsx` stays the explicit way. If you would rather write plain React and let the build decide:

```ts
cfLite({ renderer: react(), islands: { auto: true } }) // or { auto: { client: "idle", exclude: ["app/legacy"] } }
```

The build reads every `.tsx|jsx` outside `app/routes`, tests, build output and `exclude`, classifies each exported component by what it uses and wraps the **interactive** ones as islands (same wrapper, same `_islands.json`, same strategies):

| verdict | what it uses | result |
|---|---|---|
| static | no hooks, handlers or browser globals | plain server HTML, no JS |
| ssr | only `use`, `useContext`, `useId`, `useMemo`, `useCallback`, `useDebugValue` | plain server component |
| island | state, effects, refs, transitions, React 19 actions, `on*` handlers, `window`/`document`/..., any other hook (assumed browser-side), `"use client"` | island |

Default strategy for auto islands is **`visible`** (an above-the-fold island hydrates right away; one below the fold costs nothing until scrolled to); override per module with `export const client = "idle"` (applies to every auto island of that module), or globally with `auto: { client }`. Ids: `app/components/Counter` (default export) and `app/components/Widgets#Like` (named export). Named exports, `export { X as Y }` and `export default Name` are all handled; the module's own references keep the raw component, so only importers get the island.

Guard rails, because nobody wrote a marker:

* **No throw on props that cannot cross.** Auto islands are *soft*: a function, element or `children` prop makes that one use render as a plain component (inside whatever tree it sits in; in dev one console line says so). So an interactive `Row` that gets `onPick={fn}` from an interactive `Picker` simply becomes part of Picker's island. Explicit `*.island.tsx` files still throw, as documented above.
* **Components that take `children`** are never wrapped (reported once at build: `Widgets.tsx#Panel: interactive but not an island: takes children`). Split the interactive part into its own component that takes plain props.
* **Opt out** a module with `export const island = false` (a literal). Routes, layouts, `_not-found`, `*.test.tsx` are never scanned.
* A page under `hydrate = true` hydrates whole, as before; islands there are plain components.
* Needs the adapter's optional `islands.detect` (React implements it; others ignore `auto`). Hook lists: `react({ islands: { serverHooks: ["useContent"], clientHooks: [...] } })`.

Example `examples/site-islands-auto` (no island file anywhere), Chromium + workerd spec `e2e/islands-auto.spec.ts`, unit tests `packages/cf-lite/test/islands-auto.test.ts`, `packages/react/test/detect.test.ts`. Auto-islands are as experimental as islands themselves: the wrapper is exactly the same, so the JS shipped for a component is identical to writing it as `*.island.tsx`.

## Smaller client runtime (optional)

```ts
cfLite({ renderer: react(), islands: { runtime: "preact" } }) // bun add preact
```

The browser bundle then runs on `preact/compat` (measured 12.4 KB vs 70.3 KB gzip for the same six islands) while the server keeps using React. Trade-offs (ids from `useId` differ, React-19-only APIs are not guaranteed) in [design/islands.md](design/islands.md). Lighthouse (even on a real edge) rates both runtimes the same, but on a 1.6 Mbps / 150 ms profile preact hydrated the header islands at 1.1 s vs 2.0 s for react, so prefer it when your users are on slow mobile links.

## Adding islands to another adapter

Set `islands: { wrap, mount }` on the `UiAdapter`: `wrap` exports `island(Component, id, strategy)` (renders `<cfl-island>` + `encodeProps` from `cf-lite/islands`, keeps the raw component on `.inner`), `mount` exports `mount(el, Component, props, sync?)`. See `packages/react/src/islands*.ts` (about 20 lines). Optional `islands.detect(source, file)` (returns `[{ export, strategy? , skip? }]` per exported component it finds interactive) is what `islands.auto` calls; core never parses UI code, so auto-islands are adapter-specific.

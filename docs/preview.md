# Component preview (`/__preview`)

Built in, dev only, no extra dependency. `cf-lite dev` serves `/__preview`: every component under `app/` and every named prop set in a `*.states.ts` file, rendered **by your own UI adapter in the real Worker runtime** (SSR, islands hydrated), with viewport toggles and deep links. It is the pattern library that does not drift, because it renders the component you ship.

Storybook, Ladle and similar tools stay optional (decision in [roadmap-dx.md](roadmap-dx.md) section 4); this page is the default.

## Write states

Put `Name.states.ts` next to `Name.tsx` (or `Name.vue`). Each key is a state; each value is the props, or a function returning them (sync or async):

```ts
// app/patterns/atoms/Button/Button.states.ts
import { defineStates } from "cf-lite/preview";
import Button from "./Button";

export default defineStates(Button, {
  default: { label: "Add to cart" },
  ghost: { label: "Details", variant: "ghost" },
  disabled: { label: "Sold out", disabled: true },
  late: async () => ({ label: (await loadLabel()) }), // props may be computed
});
```

`defineStates(Component, states, { title?, group? })` only types the props against the component (function components; SFCs and classes get an untyped record) and returns `{ component, states }`. You can also write the plain shape: `export const states = { ... }` in a file next to the component (the sibling `Name.tsx`, `Name.island.tsx`, or `index.tsx` of the folder is used).

A component **without** a states file is still listed and rendered once with no props (`default`). That is enough to see which components exist; add a states file when it needs props.

## What is discovered

Under `app/`, skipping `app/routes`, dot/underscore folders and `node_modules`:

| File | Becomes |
|---|---|
| `Capitalised.tsx` / `.jsx` / `.vue` (the adapter's route extensions) | a component, id = path under `app/` without extension |
| `Name.states.ts(x)` / `.js` | its states; the component is the sibling file or `defineStates`' first argument |
| `Name.island.tsx` | a component marked "island" (its server HTML is wrapped in `<cfl-island>` and **hydrated in the frame**) |
| `app/preview.setup.ts` | optional: loaded by every frame (global CSS, fonts - what pages get from `app/main.tsx`) |

Folder-per-component collapses: `patterns/atoms/Button/Button.tsx` has id `patterns/atoms/Button`, group `patterns/atoms`. Atomic folders are optional; see [coming-from-mvc.md](coming-from-mvc.md) and `cf-lite add patterns`. Adding or removing a file is picked up while the dev server runs.

## URLs

| URL | What |
|---|---|
| `/__preview` | index: sidebar (filter box, groups, states), viewport buttons (Full / Mobile 375 / Tablet 768 / Laptop 1280), `HTML` tab, "Open frame" |
| `/__preview?c=<id>&s=<state>&vp=375&tab=html` | deep link; the URL follows the UI. No `s` = every state of the component stacked |
| `/__preview/frame/<id>?s=<state>` | one state as a full document (your `index.html` shell with its styles, the setup module, the island runtime) |
| `/__preview/frame/<id>?s=<state>&fragment=1` | only the component's HTML: what [`cfl export`](export.md) writes |
| `/__preview/api/manifest` | JSON: components, state names, errors, mocks, `adapterBind` |

A render error shows the stack in the frame (HTTP 500; `fragment=1` returns the message). A states file that exports no component and has no sibling is listed with its error instead of breaking the index.

## Dev only, by construction

The generated `.cf-lite/preview.ts` is imported behind `import.meta.env.DEV`; a build drops the branch, so the production Worker contains no preview code, no component states and no `/__preview` entry in `run_worker_first` (the glob is dev-only). `scripts/preview-e2e.mjs` builds an app and asserts all three; [`cf-lite doctor`](doctor.md#cfl018) fails if the built Worker contains the runtime anyway (CFL018). Nothing is generated for an app with no component or no UI adapter.

With [draft mode](draft-mode.md) configured, the draft routes also live under `/__preview/<page>`. In dev, the exact paths `/__preview`, `/__preview/frame/*` and `/__preview/api/*` belong to the component preview; everything else falls through to draft mode, and production is unaffected (the preview is not there).

## Adapters

Rendering a component with props needs `bind(Component, props)` on the adapter's server module. React, Preact and Vue have it; **Svelte does not** (its server entry renders a fixed `Root.svelte`): the index says so and `cfl export` stops with the same message. A custom adapter adds one function:

```ts
export const bind = (Component: unknown, props: Record<string, unknown>) => () => createElement(Component, props);
```

## Limits

* Props are rendered as given; context providers your pages get from a layout are not applied (`layouts: []`). Wrap in the states file or the component if a pattern needs a provider.
* Islands hydrate by their real runtime in the frame (all four strategies), but dev has no production chunking; judge timing in a build.
* Vite may print `Failed to run dependency scan ... @alias/...` at build time when you use path aliases. The build is correct (it resolves them); the message comes from Vite's esbuild scan, which does not read `resolve.alias` for the Worker environment, and applies to a hand-written `resolve.alias` the same way.

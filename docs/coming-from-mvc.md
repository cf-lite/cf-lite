# Coming from MVC + Vite patterns

For teams that build server-rendered pages with Razor / Twig / JSP and a Vite "pattern library" (atoms, molecules, organisms, an HTML preview site, a pipeline that hands CSS/JS to the backend). The mapping below keeps that way of working and removes the two chores: retyping markup per component, and a pattern site that is not the real thing. Nothing here requires leaving your backend; each step stands on its own.

## The mapping

| You have | In cf-lite |
|---|---|
| `src/atoms|molecules|organisms/<name>/index.tsx` | `app/patterns/{atoms,molecules,organisms}/<Name>/<Name>.tsx` (folders optional, any depth) |
| Pattern/story pages with mock data | `<Name>.states.ts`: named prop sets, shown at [`/__preview`](preview.md) |
| A dev server that renders patterns with HMR | `cf-lite dev` (the real Worker runtime); `/__preview` is a route of it |
| `msw` / `_data/*.ts` mocks | `mocks/` + `MOCK=1`: [route-level JSON and handlers](mocks.md), also for `fetch()` in loaders |
| Pre-rendered pattern HTML the backend dev reads | [`cfl export`](export.md): one fragment per state + manifest + asset manifest, diff-clean |
| Built CSS/JS committed or handed over by a bot PR | `assets.json` from `cfl build` lists the files (names, bytes, sha256) |
| Global ambient types, `@/` imports | tsconfig `paths`, mirrored into Vite automatically |
| `data-rct` islands (client-render only) | [SSR islands](islands.md): `*.island.tsx`, server HTML + hydration by `load`/`idle`/`visible`/`interaction` |

## Start

```sh
bun create cf-lite my-patterns -- --template patterns     # react; or any app: cf-lite add patterns
bun run dev            # /__preview
bun run dev:mock       # MOCK=1: /api/hello answers from mocks/api/hello.json
bun run patterns:export
```

`cf-lite add patterns` (idempotent, never overwrites, `--dry-run` works) writes:

```
app/patterns/README.md
app/patterns/atoms/Button/Button.tsx          (Button.vue for Vue)
app/patterns/atoms/Button/Button.states.ts
app/preview.setup.ts                          global CSS/fonts for preview frames
mocks/api/hello.json
tsconfig.json   paths: "@/*" -> app/*, "@patterns/*" -> app/patterns/*
package.json    scripts: dev:mock, patterns:export
```

It needs a UI adapter that can bind props (react, preact, vue, solid); run `cf-lite add react` first otherwise.

## Folder conventions

* One component per folder: `Name/Name.tsx`, `Name/Name.states.ts`, optional `Name/Name.css`. A flat `patterns/Name.tsx` works too.
* Use the atomic levels if the team thinks in them; they are only folder names (group = the folder in the preview sidebar). `molecules` import `atoms` through the alias: `import Button from "@patterns/atoms/Button/Button"`.
* Components start with a capital letter; helpers (`utils.ts`, `types.ts`) and `*.test.tsx` are not listed.
* Interactive pieces are `Name.island.tsx` files; state them with `Name.states.ts` as usual and the preview hydrates them.
* Aliases come from tsconfig `paths` (one list for the editor and the bundler; the prerender step reads it too). Only `"@/*": ["./app/*"]`-style wildcards and exact keys; `extends` is not followed.

## What stays the same, what changes

* **Backend keeps ownership** of routing, auth and CMS rendering. cf-lite is the front-end build: patterns, states, assets and (optionally) the pages. [Integrating with a .NET backend is not shipped](export.md#using-it-from-a-backend): the export is the contract, not a library.
* **States are the contract.** A designer, QA and the backend dev open the same URL (`/__preview?c=patterns/atoms/Button&s=disabled`); CI runs `cfl export --check` so a changed pattern is a visible diff.
* **Mocks are first-class dev data, not production code.** Both mocks and the preview are compiled out of builds ([doctor CFL018](doctor.md#cfl018)).

Known gaps vs a mature pattern tool: no addon ecosystem, no visual-regression snapshots, no a11y panel (run `axe` in your Playwright tests, see [a11y.md](a11y.md)), no per-state viewport/background controls beyond the three presets, Svelte unsupported in the preview. If you need Storybook or Ladle you can run them next to this; nothing here depends on them.

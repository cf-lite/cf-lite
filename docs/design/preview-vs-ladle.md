# Design: built-in `/__preview` vs Ladle (measured comparison)

Status: **evidence only, no decision.** The owner decides. Measured 2026-10-06 in a scratch copy outside the repo (nothing here changes code, versions or dependencies). User docs of the built-in preview: [../preview.md](../preview.md).

Labels on every figure: **OBSERVED** (measured here; n and machine given), **DOC-ONLY** (read from a URL on 2026-10-06, not run here), **ESTIMATED** (judgement, no measurement). What could not be measured is listed in [section 10](#10-what-was-not-measured).

## 0. Decision log (where the preview decision came from)

| Date (2026) | What | Source | Status today |
|---|---|---|---|
| 10-02 | Roadmap compared Storybook 9, Ladle, Histoire, a built-in route and plain HTML fixtures. Ladle row: "Light (Vite-native, CSF stories); React only; browser, no workerd; same CSF files, fewer features". Recommendation: built-in `/__preview` as default, Storybook as an opt-in `add storybook` recipe. The table says its Storybook/Ladle/Histoire figures are "general knowledge, **not measured here**". | PR [#40](https://github.com/cf-lite/cf-lite/pull/40) (merged 01:57Z), [roadmap-dx.md section 2](../roadmap-dx.md#2-component-preview-both-lines) | Superseded in detail by #54 (states, not JSON fixtures) |
| 10-02 | **Decided (owner):** "build our own built-in preview (`/__preview` + JSON fixtures), easy and feature-complete enough for real use. Storybook/Ladle-style tools only as optional plugins (`add storybook` / `add ladle`), never the default." Phase P4 = `add storybook` / `add ladle` (opt-in). | PR [#41](https://github.com/cf-lite/cf-lite/pull/41) (merged 02:07Z), [roadmap-dx.md section 4 item 2](../roadmap-dx.md#4-decided-2026-10-02-owner), [section 3 P4](../roadmap-dx.md#3-phasing) | In force |
| 10-02 | Built: `/__preview`, `MOCK=1`, `cfl export`, pattern conventions. States are typed `*.states.ts` (`defineStates`), not the JSON fixtures floated in section 2. | PR [#54](https://github.com/cf-lite/cf-lite/pull/54) (merged 16:33Z), [roadmap-dx.md section 6](../roadmap-dx.md#6-built-early-the-dx-kit-2026-10-02), [CHANGELOG.md](../../CHANGELOG.md) "DX kit" | Shipped |
| 10-06 | This document: first **measured** Ladle numbers. `add ladle` (P4) is **not built**; no Ladle code, config or dependency exists anywhere in the repo. | this file | Open question |

So: Ladle was named as an optional plugin and never chosen, as default or otherwise. The "lightweight library was picked" memory has no source in the repo history; the closest real text is the Ladle row of the 10-02 table and the P4 line above.

## 1. Setup and method

Machine **M1** (all OBSERVED rows): Intel Xeon E5-2696 v4 2.2 GHz, 16 vCPU, 31 GB RAM, Linux 6.8, Node v24.20.0, npm 11.19.0, Bun 1.4.0, Playwright Chromium 1243, no other load. Cold start and HMR were run one tool at a time.

Under test: cf-lite 0.4.0 built from `origin/main` (83d6908), Vite 8.3.2, React 19.3.0, **@ladle/react 5.1.1** (npm `latest`, the newest stable release). Two scratch apps under `/tmp`, both copies of `examples/site-patterns` installed with `npm` from `npm pack` tarballs (no publish): **A** = app only; **B** = A + `npm i -D @ladle/react`.

The same 3 components in both:

| Component | States | Source |
|---|---|---|
| `Button` (atom) | default, ghost, disabled | `examples/site-patterns/app/patterns/atoms/Button` |
| `ProductCard` (molecule, imports `Button` through the `@patterns/*` alias, data from `mocks/api/products.json`) | default, sold-out, expensive (computed props, a function state) | same example |
| `Hero` (a Line B-style block: presentational, JSON props, `hero.schema.json`, On-Page-Edit attributes) | default, no-image, no-cta, edit-mode | Line B repo, `origin/master`, read-only; component simplified to be self-contained |

10 states in total. A reads them from `*.states.ts`; B from hand-written CSF-style `*.stories.tsx` (10 stories, 3 files; the generated variant is in [section 7](#7-the-hybrid-option)). Ladle needed three non-default settings to work at all (OBSERVED, they cost a round of debugging): `stories: "app/**/*.stories.*"` (default glob is `src/**`; with the wrong glob `ladle build` succeeds and produces **0 stories**), a Ladle-only Vite config (`.ladle/vite.config.mjs`), and `.ladle/components.tsx` to load `app/styles.css`.

## 2. Install footprint

| Measure | A: cf-lite + React (preview built in) | B: A + Ladle 5.1.1 | Delta | Label |
|---|---|---|---|---|
| Packages in lockfile | 142 | 607 | **+465** | OBSERVED (n=1 install, deterministic on disk; M1) |
| `node_modules` size | 297 MB | 537 MB | **+240 MB** | OBSERVED (n=1, `du -sm`; M1) |
| Install time (warm npm cache) | 8.3 s | 15.0 s | +6.7 s | OBSERVED (n=1; M1) |
| Vite copies | 1 (8.3.2) | 2 (8.3.2 + a private 6.4.3 inside `@ladle/react`) | +1 | OBSERVED (`npm ls vite`) |
| Install scripts to approve (npm 11 blocks them) | esbuild, workerd | + `@swc/core`, a second esbuild | +2 | OBSERVED |
| Dev-dependency delta of the built-in preview | **0 packages**: it ships inside `cf-lite` (dist `preview*.js` 17,049 bytes, src 343 lines in 4 files) | n/a | 0 | OBSERVED (file sizes, `wc -l`) |

Ladle's direct dependency list is 40 packages (Koa, MSW, Babel x7, MDX, axe-core, two Vite React plugins, chokidar, ...), DOC-ONLY: `npm view @ladle/react dependencies`, 2026-10-06. Its Vite is a **dependency** (`^6.0.5`), not a peer: it does not conflict with this repo's `vite ^8` (peer range of the cf-lite packages is `^8.0.0`), it just runs a second, older Vite. `peerDependencies`: `react >=18`, `react-dom >=18` (so React 19 is fine, OBSERVED rendering below).

## 3. Cold start and edit-to-visible latency

n=5 per tool, median (min-max) in ms, M1. Cold = Vite caches deleted before each run (`node_modules/.vite`, plus cf-lite's `.cf-lite/.wrangler`). t0 = process spawn. "First render" = the Button is visible in headless Chromium (a user reload is simulated every 0.7 s when the page is not ready, the same loop for both).

| Measure | `cf-lite dev` + `/__preview` | `ladle serve` | Label |
|---|---|---|---|
| HTTP ready | **3,984** (3,868-4,124) | **1,688** (1,576-2,002) | OBSERVED n=5 |
| First component visible | **4,367** (4,213-4,528) | **2,913** (2,669-3,721) | OBSERVED n=5 |
| Edit file -> change reaches the server render | 71 (68-92) | n/a (browser HMR) | OBSERVED n=5 |
| Edit file -> change visible in the **open page, no action** | **never** (waited 3 s each, n=5; an earlier 15 s wait also saw nothing) | **68** (66-78) | OBSERVED n=5 |
| Edit -> visible after a manual page reload | 231 (214-243) | not needed | OBSERVED n=5 |

Reading: Ladle starts about 1.4 s faster (it has no workerd to boot). cf-lite's server-side edit pickup is as fast as Ladle's HMR (about 70 ms) but **the open preview page does not update itself**: the frame is a server render, and `preview.ts`/`modules/preview.ts` contain no reload or HMR subscription. That is a real gap, small to fix (section 8). cf-lite's own docs claim only that added or removed files are picked up, not live edits ([../preview.md](../preview.md) "Adding or removing a file is picked up while the dev server runs").

## 4. Static build and "works with no server"

| Measure | `ladle build` | Static gallery (`cfl build` + `cfl export` + the Line B `build-preview-site.mjs`) | Label |
|---|---|---|---|
| Time | 5.6 s (5.58-5.80), n=5 | `cfl build` 2.85 s + `cfl export` 4.75 s (throw-away dev server inside) + 0.05 s page generation = **~7.7 s**, n=5 | OBSERVED, M1 |
| Output | 496,060 bytes, 12 files (460 KB entry JS, one chunk per story file, 11.9 KB CSS) | **9,106 bytes, 13 files** (10 state pages + index + `_headers` + 451 B CSS) | OBSERVED, n=1 (deterministic) |
| What the output is | A React app that renders **in the browser**; the HTML holds no component markup | The **server-rendered HTML** of each state, in iframes; no JS at all (islands show static HTML, not hydrated) | OBSERVED (`curl`, file listing) |
| Opened as `file://` | **Does not render** (absolute `/assets/...` URLs, module script) | Page HTML renders, **CSS missing** (the generated link is root-absolute `/assets/index-*.css`): unstyled button, `rgb(239,239,239)` instead of `rgb(37,99,235)` | OBSERVED n=1, Chromium |
| Assets-only Worker (`wrangler dev --assets <dir>`, no `main`) | **Works**, styled, story renders | **Works**, styled | OBSERVED n=1, workerd 2026-10-01 |
| Needs a server | static host / assets Worker | static host / assets Worker | OBSERVED |

Two caveats the numbers hide:

* The gallery script as it exists in the Line B repo reads `assets.json` CSS entries as strings (that repo overrides the file with site URLs). Run against a stock `cfl export` (objects `{file, bytes, sha256}`), it printed `href="[object Object]"`; I patched the file to strings and copied the built CSS next to the pages for the measurement above. A gallery shipped by cf-lite should own this (S, section 8).
* Ladle also loads the app's own `vite.config.ts` by default. With the cf-lite config in place, the first `ladle build` ran the Cloudflare plugin under Ladle's Vite 6 and wrote `wrangler.json`, `_headers` and `.assetsignore` into the Ladle output (OBSERVED once, before the dedicated config). A Ladle integration must ship its own Vite config.

## 5. Compatibility

| Question | `/__preview` | Ladle 5.1.1 | Label |
|---|---|---|---|
| React 19 | Yes | Yes: peer `react >=18`; rendered all 10 stories on React 19.3.0 | OBSERVED (Ladle), docs |
| Repo's Vite (`^8.3.1`) | Native (the app's own Vite) | Not shared: private Vite 6.4.3; Vite 8 plugins in the app config (cf-lite, `@cloudflare/vite-plugin`) cannot run in it, so the app config must be bypassed; `vite-tsconfig-paths` (built in) resolved the `@patterns/*` alias | OBSERVED |
| Preact / Vue / Svelte / Solid | `bind()` exists for React, Preact, Vue, Solid; **Svelte has none** (index says so, `cfl export` stops) | **React only**: "Ladle supports only React" ([ladle.dev/docs](https://ladle.dev/docs/), 2026-10-06) | DOC-ONLY |
| Runtime fidelity | Renders in **workerd** through the app's real SSR adapter; markup present without JS (`curl` of the frame returns `<button ... class="btn btn--ghost">Details</button>`) | Browser only: Vite dev page, empty `#ladle-root`; `curl` of a story page contained **0** matches for the button text | OBSERVED |
| Islands and hydration | Island markup is `<cfl-island data-i=... data-p=...>` SSR output, hydrated by the real runtime in the frame (observed markup for `Counter` `from-ten`) | The island is just a React component mounted client-side; the `<cfl-island>` wrapper, SSR output and hydration path are never exercised | OBSERVED (cf-lite markup), reasoning (Ladle) |
| Hono routes and `MOCK=1` | `MOCK=1 cf-lite dev` served `/api/products` as `application/json`; the preview and pages share it | `ladle serve` answered `/api/products` with **200 `text/html`** (SPA fallback); no Hono, no `mocks/` folder. Ladle's own mocking is MSW (browser service worker, own handlers) | OBSERVED |
| Real bindings (D1/KV/R2) in a component | As available in dev workerd (not exercised here) | None (browser) | DOC-ONLY / not measured |
| Provider/layout context | Not applied (`layouts: []`, documented limit) | Via `.ladle/components.tsx` provider | docs, DOC-ONLY |

## 6. Feature matrix

| Feature | `/__preview` (OBSERVED from source/docs of this repo) | Ladle 5.1.1 (DOC-ONLY unless noted) |
|---|---|---|
| Viewports | Full / Mobile 375 / Tablet 768 / Laptop 1280 buttons, `vp=` in the URL | Width addon (key `w`), state kept in the URL ([addons](https://ladle.dev/docs/addons), [hotkeys](https://ladle.dev/docs/hotkeys)) |
| Dark mode, RTL | **None** (the page chrome follows `prefers-color-scheme`; no toggle for the component, no `dir`) | Dark theme (`d`), RTL (`r`) |
| Controls / args | **None** | Controls addon for `args`/`argTypes` (`c`) |
| a11y checks | **None** | axe-core addon (`a`) |
| Interaction tests | **None** | **None documented**: no play-function feature in the docs list or in the 9 addon sources of 5.1.1 (a11y, action, control, ladle, mode, rtl, source, theme, width; OBSERVED listing); the recipe is Playwright against story URLs |
| Visual regression | None built in; `/__preview/api/manifest` + `frame/<id>?s=` URLs are enough for a Playwright screenshot loop (ESTIMATED S) | Not built in; documented Playwright recipe over `meta.json` ([visual-snapshots](https://ladle.dev/docs/visual-snapshots)) |
| Deep links | `?c=&s=&vp=&tab=`; one frame URL per state | `?story=<id>&mode=preview` (OBSERVED), addon state in the URL |
| Search | Sidebar filter box | Sidebar search (`/`) |
| Source view | **HTML tab** = exported markup of the rendered state | Story-source addon (`s`): the story's JSX, not the rendered HTML |
| Razor / fragment parity view | **Yes**: `frame/<id>?s=&fragment=1` is exactly what `cfl export` writes | **No** (client DOM only; nothing equals the exported fragment) |
| Story format | `*.states.ts`: `defineStates(Component, { name: props \| () => props })`, typed against the component, sync or async states | CSF-like named exports (`export const Default = () => <C .../>`), Ladle's `Story` type, MDX stories; must be statically analysable |
| One file for preview **and** Line B export (`generatedStates`) | **Yes**: the same `*.states.ts` feeds `/__preview`, `cfl export` and the schema-derived Razor template states | **No** without an adapter (section 7); `generatedStates` returns computed template specs, not CSF exports |
| HMR on edit | **No** (section 3) | Yes, 68 ms |
| Docs pages (MDX), background, actions, MSW | No | Yes |

## 7. The hybrid option

Idea: `*.states.ts` stays the single source (typed, shared with `cfl export` and `generatedStates`); a small generator writes a static `*.stories.tsx` next to each states file so Ladle is a pure optional viewer. Prototype in the scratch app B (OBSERVED): a 19-line script (`gen-ladle-stories.mjs`) loads each `*.states.ts` with esbuild (to read state **names**, because Ladle finds stories by parsing exports, so they cannot be dynamic), and emits

```tsx
import def from "./Button.states";
const C = def.component as any;
export default { title: "patterns/atoms/Button/Button" };
export const Ghost = () => <C {...(def.states["ghost"] as object)} />;
```

Result: 9 stories from the 10 states in 3 states files, `ladle build` OK (0.47 MiB), and 2 sampled generated stories (`blocks--hero--edit-mode`, `productcard--sold-out`) rendered in Chromium. Not covered by the prototype and therefore **not** claimed: watch mode (new state -> regenerate), `.island.tsx` handling, titles for plain `export const states` files, Vue/Preact/Solid/Svelte (Ladle cannot render them at all).

Known limits: (1) a **function state is skipped** (`expensive` in `ProductCard`: a sync story cannot await it; ~1 in 10 states here); (2) React only; (3) client-side rendering only: no SSR, no islands, no Hono mocks; (4) generated files must be gitignored and a Vite-8-vs-6 split config maintained; (5) the full footprint of section 2 (+465 packages, +240 MB, 5 audit findings) applies to anyone who opts in.

## 8. Cost to build and maintain (ESTIMATED, S < 1 day, M 1-3 days, L > 3 days)

**Direction A: keep and grow the built-in preview.** Cost is only for the gaps found.

| Gap (measured above) | Cost | Note |
|---|---|---|
| Live refresh of the open page on edit | **S** | Frame already re-renders in 70 ms; needs a reload signal from the dev server to the index page |
| Gallery shipped by cf-lite (`cfl export --gallery`), correct asset URLs, relative so it also works from `file://` | **S** | Folds in the Line B script (about 40 lines); fixes the `[object Object]` and root-absolute CSS findings |
| Dark and RTL toggles for the frame | **S** | `data-theme` / `dir` on the frame root + two buttons |
| Visual regression recipe (Playwright over the manifest) | **S** | Docs + a generator; no new dependency in cf-lite |
| Source tab for the component (not only HTML) | S-M | |
| a11y panel (axe) | M | Needs axe-core as an optional dev dependency; ~1 package |
| Controls / args UI | M | Derive from the TS props or the schema; the Line B schema already exists |
| Interaction tests (`play`-style) | L | Probably better as a Playwright recipe against frame URLs (S) than a runtime |
| Cold start 4.0 s vs 1.7 s (workerd boot) | M, uncertain | Not a regression risk; only a comparison |
| Ongoing | S/yr | 343 lines of preview source + `scripts/preview-e2e.mjs`, no third-party API to track |

**Direction B1: Ladle as the default.** Replaces the preview.

| Work | Cost |
|---|---|
| Migrate every `*.states.ts` to CSF (or run the generator), drop `defineStates` typing and async states | M per app, L across Line B |
| Lose workerd/SSR fidelity, island hydration, `MOCK=1` sharing (re-implement mocks as MSW handlers) | M, and a permanent fidelity loss |
| Lose Preact/Vue/Svelte/Solid previews (4 of 5 adapters) | Not recoverable inside Ladle |
| Line B: keep `cfl export` fragments, the Razor parity view and `generatedStates` reuse | L (a second path, or the hybrid generator) |
| Track Ladle: Vite 6 vs 8 split, MSW 2 breaking changes, Node floor, single maintainer | M/yr, ESTIMATED |

**Direction B2: `add ladle` plugin (roadmap P4).** A recipe that writes `.ladle/config.mjs` (glob, own Vite config), `.ladle/vite.config.mjs`, `.ladle/components.tsx`, the package.json devDependency and the generator: **S-M** (prototype above is 19 lines + 3 small config files). The user pays the section 2 footprint; cf-lite ships none of it.

**Hybrid (B2 + generator) productised:** watch mode, function states (resolve once at generation time, or warn), island files, tests, docs, version pin: **M**. Maintenance: S-M/yr (re-verify against each Ladle major).

## 9. Maintenance and risk

| Item | `/__preview` | Ladle | Label |
|---|---|---|---|
| Licence | MIT (repo) | MIT | OBSERVED (`npm view`, GitHub API) |
| Releases | with cf-lite | 5.0.0 2024-12-24, 5.0.1 2025-01-03, 5.0.2 2025-03-20, 5.0.3 2025-05-02, 5.1.0 2025-10-02, **5.1.1 2025-11-04 (latest, 11 months before 2026-10-06)** | OBSERVED (`npm view @ladle/react time`) |
| Repo activity | n/a | Last push 2026-06-28; 8 commits on main after 5.1.1 incl. "upgrade all dependencies to latest major+minor"; so a new release looks pending, not guaranteed. ~3.0 k stars, 46 open issues, not archived | OBSERVED (GitHub API 2026-10-06) |
| Bus factor | the cf-lite team | One person: 394 of the 445 commits by the top-10 contributors, the next has 19; npm owners: that person + a CI bot | OBSERVED (GitHub contributors API) |
| Breaking-change history | none yet (0.x) | 5 majors in 30 months: 1.0 2022-06, 2.0 2022-07 (Vite 3, ESM only), 3.0 2023-09 (SWC, Node 20, React 18+), 4.0 2023-11 (Vite 5, **MSW 2 handlers must be rewritten**), 5.0 2024-12 (Vite 6). Pattern: each major = a Vite major bump | DOC-ONLY: GitHub release notes `tajo/ladle`, 2026-10-06 |
| `npm audit` (2026-10-06) | A: **0 vulnerabilities** | B: **5 high, 0 critical** (`braces` ReDoS via `micromatch` -> `fast-glob` -> `globby` -> `@ladle/react`; `fixAvailable: false` while the pinned chain stays), all dev-time | OBSERVED n=1 each, M1 |
| Lock-in | Low: `*.states.ts` are plain props; the fragments are plain HTML | Low-medium: CSF-like files are portable to Storybook-style tools; MSW handlers and `.ladle/` config are not | ESTIMATED |
| Cross-vendor view of the gaps | not done | not done | n/a |

## 10. What was not measured

* **`generatedStates` end to end.** It lives in the Line B repo with its Razor template machinery; only the `Hero` component and schema were reproduced. Whether the schema-derived template states could back CSF stories was **not** run (the section 6 "no without an adapter" is from reading its docs/types).
* **Ladle versus real bindings** (D1/KV/R2/Queues) and **Hono middleware** in components: Ladle has none by construction; the built-in preview's behaviour with bindings was not exercised here.
* **HMR under load** (hundreds of stories), cold start with a large app, warm-cache start, a different machine or CPU count: n=5 on one machine; spread is shown, no confidence interval.
* **Storybook** (not part of this question) and **Histoire**.
* **Ladle features** (controls, a11y, RTL, dark, search) were not exercised in a browser, only read from the docs and the installed package's addon list. The "no interaction tests" claim is an absence in the docs and addon list, not a behaviour test.
* **Gallery in CI** (per-PR hosting of either output) and **file:// support with relative URLs** were not tried beyond the two observations above.
* The Ladle numbers use a Ladle-specific Vite config; with the app config shared, numbers and output differ (section 4 caveat), and were not re-timed.
* The cf-lite figure of 3 states for `Button` etc. is the sample used; large state counts were not compared.

## 11. Decision table (recommendation only)

| | A. Keep and grow built-in | B1. Ladle as default | B2. `add ladle` plugin (not default) | C. Hybrid: `*.states.ts` source + generated stories |
|---|---|---|---|---|
| Install footprint | 0 packages | +465 pkgs, +240 MB for everyone | 0 unless opted in | 0 unless opted in |
| Runtime fidelity (workerd, SSR, islands, mocks) | Full | Lost | Full in built-in; browser-only in Ladle | Full in built-in; browser-only in Ladle |
| Adapters covered | React, Preact, Vue, Solid (Svelte: no `bind`) | React only | same as built-in (Ladle part: React only) | same |
| Line B / Razor parity (`cfl export`, `generatedStates`) | Yes, one file | Needs a second path | Yes | Yes, one file |
| Features Ladle has and we lack (dark/RTL, controls, a11y, live refresh) | Gaps, S-M each | Included | Via Ladle, for React teams only | Via Ladle, for React teams only |
| Build cost | S-M per gap | L (migration) | S-M | M |
| Ongoing risk | Ours, small | Single-maintainer upstream, Vite 6/8 split, 5 audit findings | Only for opt-ins | Only for opt-ins; generator to maintain |
| Matches the 2026-10-02 decision | Yes | **No** (it says "never the default") | Yes | Yes |

**Recommendation (not a decision): A now, with C as the opt-in later.** Fix the cheap measured gaps in the built-in preview first (live refresh, a gallery that works from any static host, dark/RTL toggles: three S items), because they close most of what Ladle visibly does better in this test, and keep `*.states.ts` as the one source that already feeds the preview, `cfl export` and `generatedStates`. Ship Ladle only as an optional `add ladle` recipe fed by a generator (C), and only when a React team asks for controls or a11y panels. Ladle as the default (B1) is the one option the numbers argue against: +465 packages and +240 MB, no SSR/workerd/islands/mocks, React only, one upstream maintainer, 11 months since the last release and 5 high `npm audit` findings, in exchange for features that cost S-M each to add here. Ladle's real strengths in this test are start-up speed (about 1.4 s faster), 68 ms live updates and its addon set.

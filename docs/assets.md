# Fonts, default `_headers`, script strategies

## Fonts (`cf-lite/fonts`)

Build-time self-hosted fonts, the `next/font` equivalent. Nothing is fetched at build or at runtime: fontsource packages are read from `node_modules`.

```ts
// vite.config.ts
import cfLite from "cf-lite/vite";
import { fonts } from "cf-lite/fonts";

export default defineConfig({ plugins: [
  cfLite({ renderer: react() }),
  fonts({ family: "Inter", weights: [400, 700], subsets: ["latin", "vietnamese"] }),   // bun add -d @fontsource/inter
] });
```

```css
body { font-family: var(--font-inter); }   /* "Inter", "Inter Fallback", sans-serif */
```

What the build does for each `fonts()` entry:

- copies the `woff2` files to `<assetsDir>/fonts/<family>-<subset>-<weight>-<style>-<hash>.woff2` (content hash; `dev` serves the same URLs). They are covered by the default `_headers` (immutable, 1 year).
- injects into every HTML shell (prerendered, SPA and SSR shells alike) `<link rel="preload" as="font" type="font/woff2" crossorigin>` for the **first subset** (`preload: false` disables) and an inline `<style>` with one `@font-face` per file (`font-display: swap` by default, `unicode-range` for the standard subsets).
- generates `@font-face { font-family: "Inter Fallback"; src: local("Arial"), local("Liberation Sans"), local("Arimo"); size-adjust; ascent-override; descent-override; line-gap-override }` from the font's own `head`/`hhea`/`OS/2`/`cmap`/`hmtx` tables (parsed from the WOFF2; English-letter-frequency weighted average width against Arial metrics), so the fallback occupies the same space as the web font and the swap causes no layout shift. `fallback: "serif" | "monospace"` picks Times New Roman / Courier New as the base.
- defines `--font-<id>` (override with `variable`), `fallbackStack` appends extra families.

| option | default | |
|---|---|---|
| `family` | required | CSS family name; fontsource id = lower-cased, spaces to `-` |
| `source` | `"fontsource"` | `"fontsource-variable"` (`@fontsource-variable/<id>`, one `wght` file per subset) or `"local"` (`files: [{ path, weight, style, subset }]`) |
| `weights` / `styles` / `subsets` | `[400]` / `["normal"]` / `["latin"]` | a missing file fails the build naming it |
| `display` | `"swap"` | `font-display` |
| `preload` | `true` | preload the first subset's files |

Not implemented: `source: "google"` (downloading from Google Fonts at build). Fontsource ships the same catalog as npm packages, which is offline and deterministic; add the package instead.
Several families: pass several `fonts()` entries. Only preload fonts used above the fold: each listed weight of the first subset is preloaded.

Tests: `test/fonts.test.ts` (offline fixtures, a real OFL font for the parser), `e2e/fonts.spec.ts` (Playwright/Chromium: font delayed 600 ms, layout-shift observer; with the generated fallback the container height is identical before and after the swap, CLS 0 vs 0.0005 without).

## Default `_headers`

`cfLite()` writes `_headers` into the client build output (skip with `cfLite({ headers: false })`):

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

followed by your own `public/_headers` verbatim, so your rules add to / override it by header name. HTML and other un-hashed files keep the Workers static-assets default (`public, max-age=0, must-revalidate`), so no extra rule is emitted for them (a `/*` rule would merge with the immutable one on `/assets/*`). `assetsDir` follows Vite's `build.assetsDir`. `defaultHeaders()` / `mergeHeaders()` are exported from `cf-lite/modules/headers-default` for tools (WP-ROUTECONF) that compile `_headers` themselves.
Static paths never reach the Worker: this is the assets layer only.

## Script strategies (`head.script`)

```ts
export const head = { script: [
  { src: "https://cdn.example/analytics.js", strategy: "idle" },   // after requestIdleCallback (setTimeout 200 ms fallback)
  { src: "/widget.js" },                                           // "defer" is the default for src
  { src: "/a.js", strategy: "async" }, { src: "/b.js", strategy: "blocking" },
  { content: "window.dataLayer = []" },                            // inline, emitted as-is
] };
```

Merges across layouts/pages like `meta`/`link` (key: `src`, inline: content; inner wins). `idle` scripts are inserted by one small inline loader, not fetched by the parser. Partytown-style `worker` is not offered. **CSP**: `injectHead(html, head, { nonce })` stamps the nonce on every emitted script, including the idle loader, so a nonce-based CSP (WP-SECURITY) works; for static pages without a nonce allow the loader by hash. On SPA navigation scripts are appended once (a `src` already on the page, or inline content already run, is skipped; scripts are never removed).

# Images: `<Image>`, transformations, pre-sizing

`next/image` equivalent, Cloudflare-native: a per-adapter `<Image>` component that emits `srcset`, intrinsic `width`/`height` (no layout shift) and
`loading`/`fetchpriority`, plus two transform backends. All of it is opt-in; nothing is added to a Worker that does not import it.

| | backend `"cdn-cgi"` | backend `"binding"` (default) | `"none"` |
|---|---|---|---|
| URL | `/cdn-cgi/image/width=640,quality=75,format=auto/<src>` | `/_img?src=<src>&w=640&q=75` | `src` unchanged |
| Runs in | Cloudflare edge, **zero Worker CPU**, cached at the edge | your Worker via the `IMAGES` binding, cached with the Cache API | - |
| Needs | a zone on a **custom domain** with Images transformations enabled | `images: { binding: "IMAGES" }`; works on `workers.dev`, R2 and allow-listed remote sources | pre-sized files |
| Format | `format=auto` (AVIF/WebP by `Accept`) | negotiated from `Accept` (`avif` > `webp` > source type) | - |

Pricing/limits of transformations (free unique-transformation quota, paid Images plan beyond it) change: check the Cloudflare Images pricing page before
relying on them *(flagged for the owner: backend 1 needs a real zone; usage beyond the free tier needs a paid Images plan)*.

## Use

```tsx
import { Image } from "@cf-lite/react/image";   // preact | vue the same; svelte: import Image from "@cf-lite/svelte/Image.svelte"

<Image src="/img/hero.png" alt="" width={1600} height={800} sizes="(min-width: 800px) 800px, 100vw" priority />
```

- `width`/`height` are required (they reserve the box; `fill` = absolutely positioned in a positioned parent, no dimensions).
- With `sizes`: `srcset` has a width descriptor per whitelisted width. Without: `1x, 2x`.
- `priority` -> `loading="eager"`, `decoding="sync"`, `fetchpriority="high"` (React 19 also hoists a `<link rel=preload as=image>`). Default is `lazy` + `async`.
- `blurDataURL` (LQIP) is shown as a background until the image paints. Generate the tiny placeholder yourself; cf-lite does not bundle an encoder.
- `unoptimized`, `.svg` and `data:` sources skip the optimizer. Extra props (`class`, `data-*`, `style`) pass through.
- Not a component framework? `imgTag()`/`imageAttrs()` from `cf-lite/modules/images` return the same thing as an HTML string / attribute map.

## Config: one object, two places

```ts
// app/images.ts
export const imagesConfig = { backend: "binding", widths: [320, 640, 800, 1600], allowHosts: ["images.example.com"], r2: ["MEDIA"] } satisfies ImagesConfig;
```
```ts
// vite.config.ts  (binding backend: mounts GET /_img and adds it to assets.run_worker_first)
cfLite({ renderer: react(), conventions: [images(imagesConfig)] })     // import { images } from "cf-lite/conventions/images"
```
Pass it to components with `config={imagesConfig}` or set it once with `configureImages(imagesConfig)` at startup. The config must be JSON-serialisable
(it is written into `.cf-lite/app.ts`). No convention? Mount it yourself: `app.get("/_img", imagesHandler(cfg))` and add `/_img` to `run_worker_first`.
wrangler needs `"images": { "binding": "IMAGES" }` and, for same-origin sources, `assets.binding: "ASSETS"`; the Vite plugin warns when `images` is missing.

## Security model of `/_img`

Everything the URL controls is whitelisted, so it cannot be used to mint unbounded transforms or to fetch arbitrary URLs.

- `w` must be in `widths`, `q` in `qualities` (default `[75]`): anything else is `400` *before* the source is touched. No cache-busting by random widths.
- Sources: same-origin `/path` (via `ASSETS`; `..`, `%2e`, `\`, `//`, control chars, `/_img` and `/cdn-cgi/` rejected), `r2:<BINDING>/<key>` (binding must be in `r2`),
  or `https://host/path` where host matches `allowHosts` (`cdn.x.com` or `*.x.com`). Remote: https only, no credentials, no port, **redirects are not followed**
  (`3xx` = `502`), 8 s timeout, IP literals / `localhost` / `*.local` / `*.internal` refused even if listed.
- Only raster image content types are transformed; SVG, HTML (an SPA fallback for a missing file) and everything else is `415`. `maxBytes` (default 15 MiB) via `Content-Length`.
- Response: `Cache-Control` 1 day + SWR (`immutable` for hashed `/assets/*` sources; override with `cacheControl`), `Vary: Accept`, `X-Content-Type-Options: nosniff`.
  Errors are `no-store` JSON.
- Cache API: key = normalised `(src, w, q, negotiated format)`; second identical request returns `x-cf-lite-image: HIT` without re-running the transform. The Cache API is
  per-colo and is **not** populated on `workers.dev`-only zones in every case; on a custom domain it is. Treat it as an optimisation, not a guarantee.
- Missing `IMAGES` binding: `501` (default) or `onMissingBinding: "passthrough"` (serves the original, `no-store`; handy in `vite dev`).

## Build-time metadata / pre-sized assets (backend `"none"`)

`cf-lite/vite-images` reads intrinsic dimensions from the file header (PNG/JPEG/GIF/WebP, no dependency):

```ts
import { imagesPlugin } from "cf-lite/vite-images";   // vite.config.ts: plugins: [imagesPlugin(), cfLite(...)]
import hero from "./hero.jpg?meta";                      // { src: "/assets/hero-3f2a.jpg", width: 1600, height: 800 }
<Image {...hero} alt="" config={{ backend: "none" }} />
```

It does **not** generate resized variants: that needs an encoder (sharp/libvips/wasm) and cf-lite's rule is no bundled native dependency. Pre-size with your
own tool (or rely on a runtime backend); `backend: "none"` then serves your files as-is with correct dimensions.

## Tests

`packages/cf-lite/test/images.test.ts` (URLs, whitelist, SSRF matrix, format negotiation, cache HIT with a fake binding), per-adapter `test/image.test.ts`
(SSR markup), `scripts/images-e2e.mjs` (real `IMAGES` binding under workerd via `examples/site-images`), `e2e/images.spec.ts` (Playwright: box reserved with
images blocked, layout-shift = 0).

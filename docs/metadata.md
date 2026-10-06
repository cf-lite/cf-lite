# Metadata: SEO head, sitemap/robots/manifest, icons, OG images

All opt-in and Cloudflare-native. Nothing is added to a Worker that does not use it (the generated app only mounts what the project has).

## `seo()`: openGraph / twitter / canonical / JSON-LD sugar

```ts
import { seo } from "cf-lite/modules/seo";
export const head = ({ params, data }) => seo({
  title: data.title, description: data.summary, path: `/posts/${params.slug}`,
  image: `/posts/${params.slug}/opengraph-image.png`, openGraph: { type: "article", publishedTime: data.date },
  jsonLd: { "@type": "BlogPosting", headline: data.title },
});
```

It returns an ordinary `head` object (meta/link/script), so it merges across layouts, prerenders, SSRs and works with JavaScript off.
`path`/`image` become absolute with the site origin: `SITE_URL` (build env / Worker var), `configureSite("https://example.com")`, or `siteUrl:` per call; with no origin they stay relative.
`twitter:card` defaults to `summary_large_image` when there is an image. `noindex: true` adds `robots`. JSON-LD gets `@context: schema.org` and is escaped (`<`, U+2028/9) so it can never close the script.
`absoluteUrl(path)` is the canonical helper.

## Sitemap, robots, manifest

| File | Result |
|---|---|
| none (just `SITE_URL` at build) | **static** `sitemap.xml` written by `cf-lite build`: every prerendered URL (incl. `paths()`) + fixed-path ssr/spa pages. A page opts out with `export const sitemap = false`. |
| `server/sitemap.ts` (default export `(c) => SitemapEntry[]`, may be async: read D1) | `GET /sitemap.xml` from the Worker, Cache API edge-cached (`options.ttl`, default 1 h, `x-cf-lite-sitemap: HIT|MISS`), `Last-Modified` = newest `lastmod`. Replaces the static one. |
| `server/robots.ts` (`RobotsConfig` or `(c) => RobotsConfig`) | `GET /robots.txt`, with `Sitemap:` line. |
| `server/manifest.ts` (`defineManifest({...})`) | `GET /manifest.webmanifest`. |

Splitting: over 50,000 URLs or ~45 MB a file becomes a **sitemap index** (`sitemap.xml`) over `sitemap-1.xml`, `sitemap-2.xml`, ... (URLs are de-duplicated). `alternates: [{ hreflang, href }]` emits `xhtml:link` (for i18n).

**Previews are never indexed**: on a `*.workers.dev` host `robots.txt` answers `Disallow: /` and every Worker response carries `X-Robots-Tag: noindex, nofollow`
(`previewHosts` in the robots options changes the patterns). Static assets served by the asset layer are not Worker responses: put a `noindex` header for preview hosts in `_headers` if you deploy previews on a custom domain.

## Icons

`app/icon.{png,svg,ico,jpg}`, `app/favicon.ico`, `app/apple-icon.png` are emitted as content-hashed assets and linked in the HTML shell (`rel=icon` / `apple-touch-icon`), served from `/app/...` in dev.

## Dynamic OG images: `_og.tsx`

`app/routes/posts/[slug]/_og.tsx` is served at `/posts/:slug/opengraph-image.png` (1200x630 by default):

```tsx
export const og = { fonts: [{ name: "Inter", url: "/fonts/Inter-Bold.ttf", weight: 700 }] };   // TTF/OTF/WOFF (not WOFF2); satori needs >= 1 font
export default ({ params }) => <div style={{ display: "flex", ... }}>{params.slug}</div>;      // flexbox subset of CSS; no JS/hooks
```

Architecture (so the wasm never bloats the app): the app Worker only evaluates your JSX to a plain element tree (`serializeOg`) and posts it over an **`OG` service binding**
to `packages/cf-lite/og-worker` (satori + resvg-wasm, ~1.3 MiB gzipped, its own Worker). Deploy it once (`cd packages/cf-lite/og-worker && wrangler deploy`) and bind it:

```jsonc
"services": [{ "binding": "OG", "service": "cf-lite-og" }]
```

`cf-lite doctor`/build warns when an `_og.tsx` exists without the binding. The app Worker size is unchanged when no `_og.tsx` exists (`ogHandler` is imported only then).

Caching: Cache API keyed by URL (`x-cf-lite-og: HIT` on the second request); `Cache-Control` is `immutable` for a year when the URL carries `?v=<hash>` (put the content hash in the URL you emit), else a day + stale-while-revalidate.
`x-cf-lite-og-hash` is the SHA-256 of the render input; output is deterministic for a fixed input (checked byte-for-byte in `scripts/metadata-e2e.mjs`).
Optional `og.r2 = "BUCKET"` also stores PNGs at `og/<hash>.png` so a cold colo or evicted cache does not re-render.
Fonts are plain files in `public/` (or the build-time `cf-lite/fonts` output if it is a non-WOFF2 face); the OG Worker fetches them once per isolate.

Notes on the OG Worker: satori's harfbuzz dependency builds JS->wasm trampolines at runtime, which Workers forbid; `og-worker/src/harfbuzz.ts` (wrangler `alias`) serves precompiled ones
(`src/fn-sigs`, regenerate with `scripts/gen-fn-sigs.mjs`) and instantiates hb from the bundled module. It imports harfbuzzjs from the hoisted repo `node_modules`.
Alternative backend (not implemented): the Browser Rendering binding (heavier, paid plan).

## Flagged for the owner
- Deploying `cf-lite-og` to a real account (and the `OG` binding in a real app) is a manual step; nothing here touches an account.
- Worker size limits for the OG Worker (1.3 MiB gzipped today) should be re-checked against the plan limits before use *(verify: 3 MiB free / 10 MiB paid, gzipped)*.

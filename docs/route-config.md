# Route config: redirects, rewrites, headers

`cfLite({ routeConf })` compiles a Next-style table at build time (WP-ROUTECONF). Nothing is called at runtime that the
assets layer can do for free.

```ts
// vite.config.ts
import cfLite from "cf-lite/vite";
import { defineRouteConf } from "cf-lite/config";

export default defineConfig({ plugins: [cfLite({ routeConf: defineRouteConf({
  redirects: [
    { source: "/old", destination: "/new", status: 301 },
    { source: "/blog/:slug", destination: "/posts/:slug", status: 301 },
    { source: "/docs/:rest*", destination: "/guide/:rest*" },                     // default status 308
    { source: "/app", destination: "/login", status: 307, missing: [{ type: "cookie", key: "sess" }] },
  ],
  rewrites: [
    { source: "/up/:path*", destination: "https://api.example.com/v1/:path*" },  // proxied by the Worker
    { source: "/m/:id", destination: "/api/hello", has: [{ type: "header", key: "user-agent", value: "Mobile.*", regex: true }] },
  ],
  headers: [{ source: "/:path*", headers: { "X-Frame-Options": "DENY" } }],
  security: { "X-Content-Type-Options": "nosniff" },   // applied to /* ahead of `headers` (hook for WP-SECURITY presets)
}) })] });
```

## Where each rule runs

| Rule | Compiled to | Cost |
|---|---|---|
| Static / `:placeholder` / splat redirect (no conditions) | `dist/client/_redirects` (generated rules first, then your `public/_redirects`) | assets layer, **no Worker invocation** |
| Redirect with `has` / `missing` | Worker table + `run_worker_first` glob for that path only | Worker, only for matching paths |
| Rewrite (internal path or other origin) | Worker table + glob for that path only | Worker |
| Headers | `_headers` (appended to the default one) **and** applied to responses the Worker produces | assets layer / Worker |

Conditions: `{ type: "header" | "cookie" | "host" | "query", key?, value?, regex? }`; `has` = all must match, `missing` = all must not.

## Limits and overflow

Assets-layer caps (*verify against current Cloudflare docs*): 2,000 static redirects, 100 dynamic redirects, 100 header rules.
Exceeding a cap is a **build error with a report** (counts per class); the suggested remedy is account-level Bulk Redirects
(a zone feature) - cf-lite never calls the API for you. Unsupported patterns (e.g. a splat that is not the last segment) also
fail the build rather than guess.

## Dev parity

`vite dev` applies the same table through a connect middleware (same `modules/routeconf` runtime), so redirects, rewrites and
headers behave in dev as they do deployed (previously `_redirects` was ignored in dev).

## Tests

`test/routeconf.test.ts` (golden `_redirects` / `_headers` / worker table) and `scripts/routeconf-e2e.mjs` (built worker under
workerd plus `vite dev`).

Not done / future: i18n-aware rules (WP-I18N), `basePath`, regex sources beyond the forms above.

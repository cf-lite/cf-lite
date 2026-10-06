# Middleware

`server/middleware.ts` is one [Hono middleware](https://hono.dev/docs/guides/middleware) that runs in front of every page and `/api` route it matches.
Cloudflare-native twist: the `matcher` is also compiled into `assets.run_worker_first`, so a path it does not cover is served by Cloudflare without
waking the Worker (no CPU, no invocation). Next/OpenNext runs middleware on every request; here only matched paths pay.

```ts
// server/middleware.ts
import type { MiddlewareHandler } from "hono";

export const config = { matcher: ["/admin/:path*", "/api/private/:path*", "!/admin/public/:path*"] };

const gate: MiddlewareHandler = async (c, next) => {
  if (!c.req.header("cookie")?.includes("sess=")) return c.text("sign in first", 401);
  await next();
};
export default gate;
```

A working copy is `examples/site-gated` (tests: `scripts/middleware-e2e.mjs`).

## Matcher

`config.matcher` is a string or an array of strings, read **statically** (keep it a literal in the file). Patterns:

| Pattern | Matches | `run_worker_first` |
|---|---|---|
| `/about` | exactly `/about` | `/about` |
| `/admin/:path*` | `/admin` and everything below | `/admin`, `/admin/*` |
| `/admin/:path+` | everything below `/admin`, not `/admin` | `/admin/*` |
| `/u/:id` | exactly one segment | `/u/*` (glob over-approximates; the in-Worker regex is exact) |
| `/docs/*` | everything below `/docs/` | `/docs/*` |
| `!/admin/public/:path*` | exclusion: never matches, even if a positive pattern does | `!/admin/public`, `!/admin/public/*` |

Wildcards are only valid as the **last** segment; anything else (Next's regex groups such as `/((?!api).*)`) is a build error, not a guess — write it as positives + `!` negatives.
Only negatives, or no `matcher` at all = *broad / gated-site mode*: every path, except hashed build output: `["/*", "!/assets/*"]`. Add your own `!` entries for public static prefixes
(`!/favicon.ico`, `!/images/*`) so they stay free.

The same patterns are compiled to regexes inside `.cf-lite/app.ts`, so a request that reaches the Worker for another reason (`/api/hello`, an SSR page) still skips the middleware
unless it matches.

## Order

```
request -> [static assets, if run_worker_first doesn't cover it]  (Worker never runs)
        -> server/worker.ts            (your own code, e.g. a `root` Hono with `root.use(...)`, runs FIRST)
        -> .cf-lite/app.ts: server/middleware.ts  (if matched)
        -> /api/*  and  page routes (SSR / cached)
```

The generated `app` is a normal Hono app, so anything you put in `server/worker.ts` *before* `root.route("/", app)` runs before the middleware, and a
`root.notFound(c => c.env.ASSETS.fetch(c.req.raw))` lets a gated *static* file be served from the assets binding once the gate has let the request through
(set `assets.binding` in wrangler). The middleware can short-circuit by returning a response; call `await next()` to continue. It cannot rewrite the URL for the
static-asset layer - that happens before the Worker.

## run_worker_first details

- Your `wrangler.jsonc` `assets.run_worker_first` array is **concatenated** with cf-lite's (SSR route globs + matcher globs). cf-lite prunes its own entries against
  yours, because Cloudflare rejects a rule that a same-polarity `...*` rule already covers ("makes it redundant"). If a broad matcher would swallow one of *your* entries
  (for example `/api/*` next to `/*`), the build stops and names it: delete the hand-written entry - cf-lite generates the list.
- Limit: **100 entries** (duplicates count), 100 characters each *(Cloudflare docs; issue cloudflare-docs#32977)*. Above 100 cf-lite falls back to `["/*", "!/assets/*"]` and warns at startup.
  Every matched path reaches the Worker in that mode, including static files.
- A negative glob only works alongside at least one positive one (always true here).
- `assets.run_worker_first: false` in wrangler makes matched static paths skip the middleware; the startup check (`[cf-lite] ...`, the `cf-lite doctor` hook) warns.
- Dev: the same globs apply under `vite dev`; adding/removing a matcher entry that changes the glob list restarts the dev server automatically.

## Not supported (on purpose)

No `NextResponse.rewrite`, no per-request matchers (`has`/`missing`), no regex matchers. Group-level middleware arrives with route groups (WP-ROUTE).

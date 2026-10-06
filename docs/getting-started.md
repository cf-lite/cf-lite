# Getting started

Short on time? [Quickstart in 10 minutes](#quickstart-in-10-minutes) below; the rest explains what you just made.

From zero to a deployed Worker in about ten minutes. cf-lite is open source (MIT), version 0.x. Currently on npm: all seven packages (`cf-lite`, `create-cf-lite` and the five adapters) at 0.4.2 (checked 2026-10-06 with `npm view <package> version`, [published.md](published.md)). `create-cf-lite` 0.4.0 had a bug when run through `npx` / `npm create`; 0.4.1 and 0.4.2 fix it. The commands below scaffold from a clone of this
repository; `bun create cf-lite` / `npx create-cf-lite@0.4.2` replaces step 1.

You need Bun 1.4+ (install: <https://bun.sh>) and, to deploy, a Cloudflare account (`bunx wrangler login`). Local dev needs no account at all: `vite dev` runs your
code in workerd with local D1/KV/R2/Queues/Durable Objects.

Node is not a requirement for installing, building, testing or deploying. The one exception is the local dev server (`cf-lite dev`, `cfl export`, `wrangler dev`): Miniflare's requests hang under Bun ([workers-sdk#15717](https://github.com/cloudflare/workers-sdk/issues/15717), [bun#42231](https://github.com/oven-sh/bun/issues/42231)), so `cf-lite dev` runs itself on Node 22+ when it finds `node` on PATH. Drop that exception when the upstream issues close; see [bun-first.md](bun-first.md).

## Quickstart in 10 minutes

```bash
git clone <this repo> cf-lite && cd cf-lite && bun install --frozen-lockfile && bun run build        # 1. once (~2 min)
bun packages/create-cf-lite/index.mjs examples/my-app --template blog --ui preact --no-install   # 2. scaffold
bun install && bun run --filter my-app dev                                          # 3. http://localhost:5173, edit app/routes/index.tsx
cd examples/my-app && bunx cf-lite doctor                                      # 4. expect no errors
bun run build && bunx cf-lite analyze                                          # 5. Worker size + client JS per page
bunx wrangler login && bun run deploy                                          # 6. needs a Cloudflare account; skip to stay local
```

Each step has a failure mode listed in [troubleshooting.md](troubleshooting.md). Next: pick a [recipe](recipes.md), or add a binding with `bunx cf-lite add d1 --dry-run`.

## 1. Create an app

```bash
git clone <this repo> cf-lite && cd cf-lite && bun install --frozen-lockfile && bun run build      # once
bun packages/create-cf-lite/index.mjs examples/my-app --template blog --ui react --no-install
bun install && bun run --filter my-app dev
```

`--template` is `minimal | blog | saas | api | realtime | ai-chat | patterns` (see [dx.md](dx.md)); `--ui` is `react | preact | vue | svelte | solid | htmx | none`
([adapters.md](adapters.md)). `examples/*` is a Bun workspace, so one `bun install` links `cf-lite` and `@cf-lite/*`.

## 2. The shape of an app

```
app/routes/index.tsx           /              SPA shell (static asset, Worker never runs)
app/routes/about.tsx           /about         export const render = "static"  -> prerendered, zero JS
app/routes/blog/[slug].tsx     /blog/:slug    export const render = "ssr"     -> Worker, loader + streamed HTML
app/routes/_layout.tsx                        nested layouts
server/api/hello.ts            /api/hello     a Hono sub-app (typed client via hc<ApiType>)
server/middleware.ts                          gate + matcher -> run_worker_first ([middleware.md](middleware.md))
wrangler.jsonc                                bindings, routes, compatibility date (you own it)
```

Everything under `.cf-lite/` is generated (`cf-lite prepare`); never edit it. Only paths that need code are sent to the Worker
(`assets.run_worker_first`); everything else is answered by Workers static assets. Details: [design.md](design.md), [routing.md](routing.md), [conventions.md](conventions.md).

## 3. The everyday loop

```bash
bun run dev                # vite dev: HMR + workerd with your bindings
bunx cf-lite add d1         # bindings and features are added by command (idempotent; --dry-run shows the diff)
bunx cf-lite doctor         # static checks, codes CFL001-CFL018 ([doctor.md](doctor.md)); something broke? [troubleshooting.md](troubleshooting.md)
bunx cf-lite types          # typed routes + Env from wrangler.jsonc ([typegen.md](typegen.md))
bun run build && bunx cf-lite analyze     # Worker size + client JS per page
bun run test                   # @cf-lite/testing runs inside workerd ([testing.md](testing.md))
```

## 4. Add what you need

Each capability is an opt-in module (import nothing = 0 bytes in the Worker) with its own page:

| I want | Page |
|---|---|
| a login, sessions, OAuth, Turnstile | [auth.md](auth.md) |
| forms with no-JS fallback, validation, CSRF, uploads | [actions.md](actions.md) |
| D1 / KV / R2 / Hyperdrive | [storage.md](storage.md) |
| cron, Queues, Workflows, inbound email, `after()` | [background-jobs.md](background-jobs.md) |
| edge caching, ISR | [caching.md](caching.md), [isr.md](isr.md) |
| redirects, rewrites, headers, CSP, rate limiting | [route-config.md](route-config.md), [security.md](security.md) |
| SEO head, sitemap, OG images, fonts, images | [metadata.md](metadata.md), [assets.md](assets.md), [images.md](images.md) |
| locales | [i18n.md](i18n.md) |
| WebSockets / Durable Objects | [realtime.md](realtime.md) |
| Workers AI / Vectorize | [ai.md](ai.md) |
| logs, errors, Web Vitals, tracing | [observability.md](observability.md) |

Coming from Next.js? Read [migration-from-nextjs.md](migration-from-nextjs.md). Copy-paste solutions to common tasks: [recipes.md](recipes.md).

## 5. Deploy

```bash
bun run deploy                                   # fresh build + wrangler deploy
bunx cf-lite deploy --gradual 10,50,100 --health-url https://my-app.example.workers.dev/api/health
bunx cf-lite deploy --preview-alias pr-42         # preview that refuses production bindings/routes
bunx cf-lite secrets push .env.production         # names only are printed
```

See [deploy.md](deploy.md). `cf-lite add ci` writes GitHub workflows (preview per PR, approval-gated production). A `*.workers.dev` URL is automatically `noindex`.

## Plans and accounts

Workers Free is enough to start. Features that depend on your Cloudflare plan are called out on each page; the ones to know up front:
**Queues** works on Workers Free with a daily operations cap (see [background-jobs.md](background-jobs.md#queues)), Image Transformations, Workers Logs
volume and Durable Object storage have their own quotas, and custom domains need a zone on your account. Nothing in cf-lite creates accounts or credentials for you.

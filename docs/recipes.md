# Recipes

Short, copy-pasteable solutions. Each one points at the page with the full reference and, where one exists, a working example app in `examples/`.

## A protected dashboard

```bash
bunx cf-lite add auth        # server/auth.ts, server/api/auth.ts, D1 migration, .dev.vars.example
```

```ts
// server/middleware.ts
export const config = { matcher: ["/dashboard/:path*", "/api/dashboard/:path*"] };
export default async (c, next) => { if (!getSession(c).userId) return c.redirect("/login"); await next(); };
```

`session()` must be mounted before the middleware (for example in `server/worker.ts`). Only the matched paths reach the Worker. See [auth.md](auth.md), [middleware.md](middleware.md); `examples/site-gated`.

## A form that works without JavaScript

```tsx
export const render = "ssr";
export const actions = { send: defineAction(schema, async (v, c) => { await save(c.env, v); return { ok: true }; }) };
export default ({ data }) => <form method="post" action="?/send"><input name="email" />{data.actionData?.errors?.email}<button>Send</button></form>;
```

Invalid input re-renders with status 422 and field errors; `return undefined` redirects 303 back. Add `<Form>` (`@cf-lite/react/form`) for fetch-based submits. [actions.md](actions.md); `examples/site-forms`.

## A blog with an always-fresh list and cached pages

Static posts via `paths()`, an SSR index with `export const cache = { maxAge: 60, swr: 600, tags: ["posts"] }`, and `purgeTags(env, "posts")` from the action that publishes.
[caching.md](caching.md), [routing.md](routing.md); `examples/site-blog`.

## Regenerate pages after an edit without redeploying

`isr({ maxAge, swr, tags })` on the route, `revalidateTag(env, "post:42")` after the write. Copies live in R2, regeneration runs through a Queue.
[isr.md](isr.md); `examples/site-isr`.

## Send email in the background, retry and dead-letter

```bash
bunx cf-lite add queue emails
```

```ts
// server/queues/emails.ts
export default defineQueue<{ to: string }>({ each: async (body, msg, env) => { await sendMail(env, body.to); } });
// anywhere: await queues.emails.send({ to })
```

Set `max_retries` and `dead_letter_queue` on the consumer. Queues is available on the Workers Free plan (daily operations cap). [background-jobs.md](background-jobs.md#queues); `examples/site-jobs`.

## A nightly job

`bunx cf-lite add cron nightly`, then `export const schedule = "0 3 * * *"` in `server/cron/nightly.ts`. `runScheduled()` from `@cf-lite/testing` tests it. [background-jobs.md](background-jobs.md).

## Upload a file to R2 safely

`saveUpload(env.FILES, form.get("file"), key, { maxBytes, allowTypes })` inside an action (size/type/sniff limits, 413/415 on violation); serve with `serveObject()`; presigned URLs for large files. [actions.md](actions.md), [storage.md](storage.md).

## Localised site

```ts
cfLite({ i18n: { locales: ["en", "vi"], default: "en" } })   // pages under app/routes/[locale]/
```

Detection only on `/`; `i18nHead()` adds hreflang; the sitemap gets alternates. [i18n.md](i18n.md); `examples/site-i18n`.

## A strict CSP without `'unsafe-inline'`

`cfLite({ security: { preset: "strict" } })` hashes inline scripts/styles for static pages; `security()` middleware nonces SSR pages. Start with `reportOnly: true`. [security.md](security.md).

## Rate limit a public endpoint

```ts
app.post("/login", rateLimit({ limiter: (c) => doLimiter(c.env.LIMITER_DO, { limit: 5, period: 300 }), key: "ip", failOpen: false }), login);
```

Workers `ratelimit` binding (approximate), or `RateLimiterDO` (exact). 429 + `Retry-After`. [security.md](security.md).

## Live chat / presence

`bunx cf-lite add do room`, extend `HibernatingRoom`, connect with `connectChannel()` (auto-reconnect, resume). [realtime.md](realtime.md) (experimental).

## Streaming AI answer

`bunx cf-lite add ai-chat`: a route, a client and the `ai` binding; `createAI(env)` streaming through `sseResponse`. Routed through AI Gateway when `AI_GATEWAY_ID` is set. [ai.md](ai.md) (experimental).

## Test a route, an action and a cron in workerd

`cfLiteTest()` in `vitest.config.ts`, `testApp()` + `loginAs()` + `fakeQueue()` in tests; one `@cf-lite/playwright` test asserts which paths invoked the Worker and runs axe. [testing.md](testing.md).

## Safe rollout

`cf-lite deploy --gradual 10,50,100 --health-url <url>`: a failing health check triggers `wrangler rollback`. PR previews: `--preview-alias pr-N`. [deploy.md](deploy.md).

## Find out why the app is big or slow

`cf-lite build && cf-lite analyze` (Worker modules, client JS per page), `cf-lite doctor --budget 300`. [dx.md](dx.md), [doctor.md](doctor.md).

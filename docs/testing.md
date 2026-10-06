# Testing cf-lite apps

Two packages (both unpublished until the 1.0 release work; use them from the monorepo / a local tarball for now):

- **`@cf-lite/testing`** - unit/integration tests that run *inside workerd* via `@cloudflare/vitest-pool-workers`, against your real wrangler bindings.
- **`@cf-lite/playwright`** - browser e2e fixtures: boot `wrangler dev`, assert *which requests reach the Worker*, axe accessibility checks.

## Setup (vitest in workerd)

```bash
bun add -d @cf-lite/testing vitest@^4.1 @cloudflare/vitest-pool-workers
```

```ts
// vitest.config.ts
import { cfLiteTest } from "@cf-lite/testing/config";
export default cfLiteTest({
  migrations: "./migrations",                       // optional: D1 migrations dir
  bindings: { E2E_LOGIN_SECRET: "test-secret" },    // test-only vars/secrets
});
```

```jsonc
// package.json
"scripts": { "test": "cf-lite prepare && vitest run" }   // `.cf-lite/app` (imported by your worker) must exist
```

The preset reads `./wrangler.jsonc` (option `wrangler`, `environment`), so KV/D1/R2/DO/queue bindings, crons and compatibility flags are the ones you deploy with.
Tests live in `test/**/*.test.ts` (option `include`). `vitest` must be 4.x (the pool does not support 5 yet).

> The pool bundles its own workerd, which can lag `wrangler`. If your `compatibility_date` is newer than that workerd supports, the preset clamps it and prints a
> warning (override with `compatibilityDate`), so the tests still boot - re-check after bumping the pool.

### Storage isolation

Before every test the preset calls `reset()` (wipes KV, R2, D1, DO storage) and re-applies your D1 migrations, so tests never see each other's data and can be run in
any order. Opt out with `isolateStorage: false` (state then persists across a file).

## API (`@cf-lite/testing`)

```ts
import { testApp, loginAs, runScheduled, fakeQueue, fakeWorkflow, applyMigrations } from "@cf-lite/testing";
import worker from "../server/worker";
```

| Helper | What it does |
|---|---|
| `testApp()` | `{ fetch(path, init), with(headers), cookies, env, settle() }`. No options: goes through the real `main` of your wrangler config. `testApp({ worker, env })`: calls your worker's default export directly so you can **override bindings** (fakes, `undefined` to simulate a missing secret). Set-Cookie headers are replayed on later requests (per app = one browser). |
| `loginAs(app, "alice")` | POSTs to the `e2eLogin()` route (`/__e2e/login`, `x-e2e-secret` from `E2E_LOGIN_SECRET`); the session cookie lands in `app.cookies`. Use one `testApp()` per user. |
| `runScheduled(worker, { cron, time })` | Fires `scheduled()` like the cron trigger (frozen `scheduledTime`) and awaits `waitUntil`s. |
| `fakeQueue(name)` | Drop-in Queue producer: `.messages/.bodies`, `expectSent(subset)`, `expectNoneSent()`, `clear()`, and `deliver(consumer)` to run recorded messages through a `queue()` handler (returns ack/retry state). |
| `fakeWorkflow(name)` | Drop-in Workflow binding: `.created`, `expectCreated(paramsSubset)`, instances with `status/pause/terminate`. Workflow *bodies* are not executed - test the steps as plain functions. |
| `applyMigrations(db?)` | Re-apply migrations manually (the preset already does per test). |

```ts
it("gate + side effects", async () => {
  const JOBS = fakeQueue("jobs");
  const app = testApp({ worker, env: { JOBS } });
  expect((await app.fetch("/api/notes")).status).toBe(401);
  await loginAs(app, "alice");
  await app.fetch("/api/notes", { method: "POST", body: JSON.stringify({ body: "hi" }) });
  JOBS.expectSent({ kind: "note", owner: "alice" });
});
```

Full working examples: `examples/demo/test/api.test.ts` (API, bearer gate, cron, isolation, fakes) and `packages/testing/fixture/` (session gate, D1 + migrations, queue/workflow producers, consumer, cron).

## Browser e2e (`@cf-lite/playwright`)

```ts
import { test, expect } from "@cf-lite/playwright";
test.use({ appOptions: { dir: "." } });           // boots `wrangler dev` once per worker process; baseURL is set for you

test("static pages never run the Worker", async ({ page, app }) => {
  await page.goto("/about/");
  await app.expectWorkerPaths([]);                 // exact set of paths that invoked the Worker since resetHits()
});
test("home is accessible", async ({ page, a11y }) => { await page.goto("/"); await a11y(); });
```

- "Which requests hit the Worker" reads one log line from your worker entry: `console.log("[worker]", new URL(req.url).pathname)` (the demo has it; change the
  regex with `workerLogPattern`). This is how cf-lite proves static/prerendered/SPA routes cost zero invocations.
- `a11y({ failOn, include, exclude, disableRules, tags })` runs axe-core (WCAG 2.0-2.2 A/AA) and throws listing every violation at or above `failOn` (default `"serious"`).
  `checkA11y(page, opts)` is the same without the fixture. Disable rules only with a comment saying why.
- Point at an already running server with `appOptions: { baseURL }`. Build first (`cf-lite build`): `wrangler dev` serves `dist/`.

## Running in this repo

```bash
bun run test:workers          # @cf-lite/testing fixture + examples/demo tests, in workerd
bun run test:playwright-pkg   # @cf-lite/playwright: a11y fixture (seeded violation must fail) + Worker-invocation assertions
```

## Not covered yet

CI wiring (`.github/workflows` belongs to the release work package), `scheduled()`/`queue()` through the *real* runtime entry (`SELF.scheduled`), and executing Workflow
step bodies. Until the packages are published, consume them via workspace links or `npm pack`.

## Runtime: Bun and Node

`bun run test` (root) runs the unit tests under Bun (`bun --bun vitest run`) and the two `*-workerd.test.ts` files (they spawn `wrangler dev`) on Node. `@cloudflare/vitest-pool-workers` runs fine under Bun. Node stays for anything that serves requests through Miniflare (`test:e2e`, `test:dev`, `test:browser`, `perf:check`) and for `test:coverage`. Why and how to retire it: [bun-first.md](bun-first.md).

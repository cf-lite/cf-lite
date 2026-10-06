# Mock layer (`MOCK=1`)

Route-level JSON and handler mocks for **dev**, no dependency. The same files serve pages, the browser, `fetch()` calls inside loaders and components, and [`/__preview`](preview.md). Production builds contain none of it.

```sh
MOCK=1 cf-lite dev        # or: cf-lite dev --mock   (bun run dev:mock after `cf-lite add patterns`)
```

Without `MOCK=1` the files are ignored (the preview index still lists them and says how to turn them on).

## Files

Everything under `mocks/`, matched by path (cf-lite's route syntax):

| File | Answers |
|---|---|
| `mocks/api/products.json` | `GET /api/products` with the JSON as body |
| `mocks/api/products/[id].json` | `GET /api/products/:id` |
| `mocks/api/orders.post.json` | `POST /api/orders` (suffix `.get .post .put .patch .delete`; JSON files default to GET) |
| `mocks/api/search.ts` | any method; `export default (ctx) => ...` |
| `mocks/api/files/[...rest].json` | `GET /api/files/*` |
| `mocks/shop.example.com/stock.json` | `GET https://shop.example.com/stock`: a first folder with a dot is another **origin** |
| `mocks/_*`, `*.d.ts`, other extensions | ignored (use `_helpers.ts` for shared code) |

Most specific route wins (static segments before `:param`, `:param` before a catch-all, a method before `*`). Two files for the same method + path are an error naming both.

A handler gets `{ request, url, params, query, body }` (`body` = parsed JSON for `application/json`, text otherwise, `undefined` for GET). Return a value (JSON 200), a `Response` (any status/headers/stream) or `undefined` (204):

```ts
// mocks/api/products/[id].ts
import { defineMock } from "cf-lite/modules/mock";

export default defineMock(({ params }) =>
  params.id === "1" ? { id: 1, name: "Oak shelf" } : new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } }));
```

Every mocked answer carries `x-cfl-mock: <file>` and logs `[cf-lite] mock GET /api/products <- mocks/api/products.json`.

## What is intercepted

1. **Requests to the app**: a middleware in front of your routes (after your `middleware.ts`) answers a matching same-origin request; no match falls through to the real route.
2. **`fetch()` inside the Worker**: `globalThis.fetch` is wrapped once per isolate. A request that a mock matches never leaves the Worker: same-origin paths (`fetch(new URL("/api/products", c.req.url))` in a loader) and any host that has a `mocks/<host>/` folder. Everything else, including the same path on another origin, goes to the real network.
3. **Preview**: `/__preview` frames run with the same wrapper, so a component that fetches renders against the mocks. For static props, import the JSON in the states file (`import products from "../../../mocks/api/products.json"`): one file feeds the route and the pattern.

Editing a mock file takes effect without a restart; adding or removing one regenerates `.cf-lite/mocks.ts`.

## Dev only

`MOCK` is a compile-time constant (`__CFL_MOCK__`, true only for `vite dev` with `MOCK=1|true`) and the mock gate is behind `import.meta.env.DEV`: `MOCK=1 cf-lite build` still produces a Worker without mocks. Enforced by `scripts/preview-e2e.mjs` (no mock string in the built Worker) and [`cf-lite doctor`](doctor.md#cfl018) (CFL018). Nothing is generated for an app without a `mocks/` folder.

Not included on purpose: request delays, random data, record/replay, schema validation, WebSocket mocks. A handler is plain TypeScript; add them there.

# Server actions, forms and CSRF

Mutations are a route's own business: a page that exports `actions` also answers `POST <route>?/<name>`. There is no RPC layer and no flight protocol —
it is an HTML form posting to the Worker, which works before JavaScript loads and with JavaScript off. JavaScript only *enhances* it.

```tsx
// app/routes/contact.tsx
import { defineAction, fail } from "cf-lite/modules/actions";
import { redirect } from "cf-lite/navigation";

export const render = "ssr";                       // actions need a Worker: ssr routes only (a static/spa page with `actions` is a build error)
export const loader = () => ({ count: 3 });

export const actions = {
  send: defineAction(schema, async (value, c) => { await save(c.env.DB, value); return { ok: true }; }),
  go: () => { throw redirect("/thanks"); },
};

export default function Contact({ data }: { data: { count: number; actionData?: { ok?: boolean; errors?: Record<string, string[]> } } }) {
  return <form method="post" action="?/send">…{data.actionData?.errors?.email?.[0]}</form>;
}
```

* `action="?/send"` picks `actions.send`; `action="?/"` (or a bare POST) picks `actions.default`. `formaction="?/go"` on a button works too.
* Hono routing is generated: `.get(path, …)` + `.post(path, …)` in `.cf-lite/app.ts`. The POST side is never wrapped by `cf-lite/modules/cache`; the GET side keeps its `export const cache`.
* The route is added to `run_worker_first` like any ssr page, so static assets are unaffected.

## What an action may return

| Action does | no-JS response | JS (`x-cf-lite-action`) response |
|---|---|---|
| `throw redirect("/x")` | `303 Location: /x` (the default 307 is upgraded to 303; 308/303 are kept) | `200 {"type":"redirect","location":"/x"}` |
| `return fail(422, data)` | page re-rendered, status 422, `data.actionData = data` | `200 {"type":"failure","status":422,"data":…}` |
| `return value` | page re-rendered (200), `data.actionData = value` | `200 {"type":"success","data":value}` |
| `return undefined` | `303` back to the page (Post/Redirect/Get; `?/name` is stripped, other query params kept) | `{"type":"redirect","location":<page>}` |
| `return new Response(…)` | sent as-is | sent as-is |
| `throw notFound()` | nearest `_not-found` (404) | `{"type":"error","status":404}` |
| any other throw | nearest `_error` boundary, status 500, digest only (no detail in production) | `{"type":"error","status":500}` |

The re-render calls the route's `loader` again and merges: `data = { ...loaderData, actionData }` (a non-object loader result becomes `data.data`).
Because `data` already reaches every adapter's page component (and hydration), no adapter change is needed. Use object-shaped loader data.

## Validation

`defineAction(validator, handler)` accepts any [Standard Schema](https://standardschema.dev) (zod ≥ 3.24, valibot, arktype — `defineAction(z.object({...}), …)`) or a plain
`(input) => ({ value } | { errors })` function. `FormData` becomes an object (repeated keys and `name[]` → arrays, files stay `File`). Invalid input never reaches the handler:
the page re-renders with **422** and `actionData = { errors: { field: ["message"] }, values }` (`values` = what was typed, minus files and secret-looking fields: `pass|secret|token|card|cvv|otp`).
Root-level issues land under `_form`. Annotate a function validator's return type (`(input): Validation<T> => …`) so the handler's `value` is typed. `defineAction` is optional; a raw `(formData, c) => …` action is fine.

## CSRF (always on for actions, and usable anywhere)

`cf-lite/modules/csrf`, no token state. A non-safe request passes only if:

1. `Sec-Fetch-Site` is `same-origin` or `none`; `cross-site`/`same-site` (a sibling subdomain) is refused; else
2. `Origin` equals the request origin (scheme, host and port), or is in `allowedOrigins`; `Origin: null` and partial-host lookalikes are refused; else
3. with neither header the request is refused (browsers always send one on a cross-origin POST) unless `allowMissingOrigin: true` (server-to-server callers); and
4. the `Content-Type` must be `application/x-www-form-urlencoded` or `multipart/form-data` (anything else → 415; `text/plain` and JSON are what cross-site tricks use to dodge preflight).

Only `POST` reaches an action: there is no `_method` override, and a `GET ?/save` never runs one. Action names are checked with `Object.hasOwn` (`?/constructor`, `?/__proto__` are 404).
Refusals log `[cf-lite] action blocked <path>: <reason>` and answer a fixed 403/415 body. Configure per route:

```ts
export const actionConfig = { allowedOrigins: ["https://partner.example"], maxBodyBytes: 1_000_000 };
```

Outside actions: `app.use("*", csrf())` (server/middleware or an API sub-app). Combine with `SameSite=Lax` (+ `__Host-`) cookies from `cf-lite/modules/session`.
A double-submit **token** is deliberately not included: fetch metadata + Origin cover every browser that supports the Worker-era web; add a token yourself only for cross-origin embeds.

## Files

`<form method="post" enctype="multipart/form-data" action="?/upload">`; in the action:

```ts
upload: async (form, c) => {
  const r = await saveUpload(c.env.FILES, form.get("file"), `uploads/${crypto.randomUUID()}`, { maxBytes: 5e6, allowTypes: ["image/*"], sniff: true });
  return { uploaded: r.key };           // an UploadError (413/415/400) that escapes becomes a re-render with { error } and that status
}
```

`formData()` buffers the request (capped by `maxBodyBytes`, default 4 MiB, checked against `Content-Length` before parsing), so this path is for ordinary uploads. Large files: `cf-lite/modules/r2`
`uploadStream` / `multipartHandler` / presigned URLs (docs/storage.md), which never buffer.

## Revalidating cached pages

Call the cache module from an action: `await purgeTags(c.env, "board")` or `purgePaths(c.env, "/board")` (needs the KV/D1 tag ledger, docs/caching.md). The e2e
(`scripts/actions-e2e.mjs`) checks HIT → action → fresh render. A global Cache-Purge-API variant belongs to WP-CACHE.

## JavaScript enhancement

`cf-lite/modules/form` `enhance(form, options)` (framework-free) — attaches to a `<form method="post">` and, on submit: builds `FormData` (incl. the submitter's name/value), sends it with `fetch`
(`x-cf-lite-action: 1`), sets `data-pending` + `aria-busy` and disables the submit controls, **ignores further submits while pending**, then

* `redirect` → `visit()`: client-side for an SPA route, a real navigation otherwise (ssr/static pages are documents); `success` → form reset; `failure`/`error` → nothing, your `onResult` renders it;
* `optimistic(data)` runs synchronously first; the function it returns is called to roll back on failure/error;
* `onSubmit({ form, data, submitter })` can cancel (return `false`) or add fields; a `cf-lite:action` event bubbles from the form with the result;
* if the fetch itself fails or the answer is not an action result (network down, a proxy's HTML), the form is submitted natively so the server renders the outcome.

Per adapter:

| Adapter | Import | Usage |
|---|---|---|
| React / Preact | `@cf-lite/react/form`, `@cf-lite/preact/form` | `<Form action="?/save" optimistic={…} onResult={…}>`; `useFormStatus()` → `{ pending, result }` inside it |
| Vue | `@cf-lite/vue/form` | `app.directive("enhance", vEnhance)`; `<form method="post" action="?/save" v-enhance="{ onResult }">` |
| Svelte | `@cf-lite/svelte/form` | `<form method="post" action="?/save" use:enhance={{ onResult }}>` |

Only React and Preact have ready-made components; the others share the same `enhance()` core and are covered by its tests, not by per-adapter e2e (see "Not done yet").

## Not done yet / limits

* `actions` code is bundled into the client route chunk (same as `loader` today) because route modules are shared; keep secrets and heavy server-only imports in `server/*` modules that the action calls. A build-time strip is planned with WP-TYPEGEN/ROUTE-b.
* The `actions` export is detected by `export const actions` (regex, like the other conventions); `export { actions }` re-exports are not seen.
* A successful action with nothing to return does a full document reload in JS mode (the loader data is server-side); return data instead for an in-place update.
* Server-side idempotency keys (beyond the client guard) and Turnstile wiring (needs AUTH's `modules/turnstile` in a form) are not built in; `turnstile` can be called at the top of an action.

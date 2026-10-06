# Typed routes, loader/action data, and `Env`

`cf-lite prepare` (also run by every `dev`/`build` through the Vite plugin) writes `.cf-lite/typed-routes.d.ts` from the file conventions. It augments
`Register` in `cf-lite/href`, so the helpers below know your real routes. No generated file (no routes yet) = everything falls back to `string`.

(Not `routes.d.ts`: TypeScript drops a `.d.ts` from `include` when a `.ts` of the same base name — the generated `routes.ts` — sits next to it.)

Make sure your `tsconfig.json` includes `".cf-lite/**/*"` (every template and example does; the bare `".cf-lite"` form is silently skipped by tsc because it is a dot-directory).

## `href()`

```ts
import { href } from "cf-lite/href";

href("/");                                          // "/"
href("/blog/:slug", { slug: "hello world" });       // "/blog/hello%20world"
href("/docs/*?");                                   // "/docs"
href("/docs/*?", { "*": "guide/intro" });           // "/docs/guide/intro"
href("/search", undefined, { query: { q: "x", tag: ["a", "b"] }, hash: "top" }); // "/search?q=x&tag=a&tag=b#top"
```

The first argument is a route **pattern** (the form `cf-lite` uses everywhere: `:param`, `*` = catch-all >= 1 segment, `*?` = optional catch-all; the
catch-all param is named `"*"`). `href("/nope")`, a missing param, an unknown param, or a non-string param is a compile error; a missing required
param also throws at runtime. Pages (`app/routes/**`) and `server/routes/**` handlers are in the table; `server/api/**` is not (use `hono/client`'s `ApiType`).

## `<Link to>`

In the react / preact / solid / vue adapters (and `@cf-lite/svelte/Link.svelte`, via its ambient declaration in `@cf-lite/svelte/env`) `to` has type `LinkTo`: a concrete path matching a known route (with optional `/`, `?query`, `#hash`), an
`http(s)://` / `mailto:` / `tel:` URL, `#hash`, `?query`, or the result of `href()`. A typo such as `to="/blgo/x"` does not compile. A dynamic string needs
`href()` (or a cast).

## `useParams` / `navigate`

```tsx check
import { useParams, navigate } from "@cf-lite/react/client";   // or @cf-lite/preact/client
const { slug } = useParams("/blog/:slug");      // { slug: string }; the pattern is a type witness only (compile error for unknown routes)
const all = useParams();                        // Record<string, string> (as before)
navigate("/blog/hello");                        // `to` is LinkTo: known route / external URL / href(...) - navigate("/blgo") does not compile
```

Types live in `cf-lite/href` (`UseParams`, `Navigate`). Breaking note for apps with a generated table: `navigate(someString)` needs `href()` or a cast. 
The same typing applies to the other adapters:

```ts check
import { useParams, navigate } from "@cf-lite/vue/client";      // useParams returns a computed ref
const params = useParams("/blog/:slug");                        // ComputedRef<{ slug: string }>
const slug = params.value.slug;                            // string
navigate("/blog/hello");
```

- **Solid** (`@cf-lite/solid/client`): identical to React (`useParams("/blog/:slug").slug`, typed `navigate`).
- **Vue** (`@cf-lite/vue/client`): `useParams(pattern)` returns `ComputedRef<Params<pattern>>`; `useParams()` stays `ComputedRef<Record<string, string>>`.
- **Svelte**: there is no `useParams`; pages and layouts get `params` as a prop (type it with `PageProps<"/blog/:slug">`). `navigate` from `@cf-lite/svelte/client` is typed like the others.
  `Link.svelte` is typed from the ambient `@cf-lite/svelte/env` declaration (`to: LinkTo`), so the `.svelte` file stays plain JS.

`test/typegen.test.ts` compiles the real vue / solid / svelte adapter sources against a generated route table (valid calls pass, typos fail).

## Loader / action data

```tsx
import type { PageProps, InferData, InferActionData } from "cf-lite/href";
import type * as route from "./[slug]";   // or typeof import(...)

export default function Post({ params, data }: PageProps<"/blog/:slug">) {
  data.title;                      // from `loader`
  data.actionData?.errors;         // from `actions` (fail(422, { errors }) -> { errors })
}

type Loaded = InferData<typeof route>;              // Awaited<ReturnType<loader>>, undefined when there is none
type Posted = InferActionData<typeof route>;        // union over every action of the returned data; Response/redirect excluded
```

A plain-object loader result is spread into `data` (with `actionData` alongside, exactly what the runtime passes); any other result (array, string, ...)
arrives as `data.data`. `PageProps<P>` reads the route module through the generated `modules` table, which covers `.ts/.tsx/.js/.jsx` pages
(`.vue`/`.svelte` pages have no `typeof import` — use `InferData` on your own type there).

## `Env` from wrangler

```sh
cf-lite types            # writes .cf-lite/typed-routes.d.ts and .cf-lite/worker-configuration.d.ts (wrangler types)
cf-lite types --check    # CI: exit 1 when Env no longer matches wrangler.jsonc
cf-lite types --env staging
```

`cf-lite prepare` does the same (and only warns if wrangler fails). The command runs `wrangler types --include-runtime=false --strict-vars=false`:
bindings and vars only, so `@cloudflare/workers-types` stays the single source of runtime types, and `vars` are `string` (a hand-written
`server/env.d.ts` with the same property types keeps merging; delete it once the generated `Env` covers you). Add `typecheck: "cf-lite prepare && tsc --noEmit"`.

Not generated: `.cf-lite/` is git-ignored build output. `wrangler types` is a local command (no account/network needed).

# Generators and seed (`cfl g`, `cfl seed`)

`cfl g page|api|component|test <name>` writes the files a recipe would have you write by hand, following the frozen conventions ([routing.md](routing.md), [preview.md](preview.md), [mocks.md](mocks.md), [testing.md](testing.md)). Same contract as `add`:

* plain file writer: the output is code you own, there is no runtime;
* idempotent, **never overwrites** (an existing file is reported `keep`);
* `--dry-run` writes nothing and lists the files (`+ path`);
* `--json` prints one object on stdout (also for errors, exit code 1), the surface the LLM layer / `cfl mcp` will call ([roadmap-dx.md](roadmap-dx.md) section 5.1).

UI adapter (`react|preact|vue|svelte`) is read from `vite.config.*`; `--ui x` overrides. `page` and `component` need one; `api` and `test` do not.

| Command | Writes | Options |
|---|---|---|
| `cfl g page posts/[id]` | `app/routes/posts/[id].tsx` (`.vue`/`.svelte` per adapter): `render`, `head`, optional `loader`, `params` typed | `--render static` (default) `\|ssr\|spa`, `--loader` |
| `cfl g api items` | `server/api/items.ts` (Hono sub-app: list / get / validated POST), mounted at `/api/items` by the api convention | `--mock` also `mocks/api/items.json` (the `MOCK=1` fixture), `--seed` also `seeds/items.d1.json` |
| `cfl g component Card` | `app/components/Card.tsx` + `Card.states.ts` (`defineStates`: `default`, `long`, `empty`) so `/__preview` and `cfl export` show it immediately | `--island` (`Card.island.tsx`, react/preact), `--folder` (`Card/Card.tsx`), `--dir app/patterns/atoms` |
| `cfl g test items` | `test/api/items.test.ts` (`testApp()`: list, 404, POST validation); for a page `test/routes/<name>.test.ts` (renders, 200 HTML); for a component `test/components/Card.states.test.ts` (states are data: `default` exists, each resolves to props) | `--kind page\|api\|component` (default: detected from the files that exist) |

Svelte has no preview `bind()` yet, so its component gets no states file (the command says so). Names are validated: pages use route-file segments (`about`, `posts/[id]`, `docs/[...rest]`, `(group)/pricing`), components are PascalCase, api names are lowercase with dashes; `--dir` must stay under `app/` and outside `app/routes`.

```sh
cfl g api posts --mock --seed --dry-run --json   # plan as data, nothing written
cfl g api posts --mock --seed && cfl g test posts
cfl g component ProductCard --folder --dir app/patterns/molecules
```

`--json` shape: `{ ok, generator, name, ui, dryRun, files: [{ path, action: "create"|"keep", content }], notes: [] }`; on failure `{ ok: false, error }`. With `--json` and no `--dry-run` the files are written and the same report printed.

Output is pinned by snapshot tests (`packages/cf-lite/test/generators.test.ts`, one snapshot per adapter for page and component): a generator that drifts from a convention fails CI, and changing a template is a visible diff.

## Seed

`cfl seed [name] [--remote --yes] [--db BINDING] [--env x] [--dry-run] [--json]` loads `seeds/` in file-name order:

| File | Does |
|---|---|
| `NAME.sql` | `wrangler d1 execute <db> --file seeds/NAME.sql` |
| `NAME.d1.json` `{ "table", "rows": [{col: value}], "db"? }` | one `INSERT OR REPLACE` per row (re-runnable when the table has a primary key); table and column names must be plain identifiers, values are escaped |
| `NAME.kv.json` `{ "binding", "entries": [{ "key", "value", "expiration_ttl"? }] }` | `wrangler kv bulk put` (object values are stored as JSON text) |

Local by default. `--remote` changes live data and is refused without `--yes` (preview it first with `--remote --dry-run`); seed is never part of natural-language mode. The database is the app's only D1, or `--db <binding>`. R2 seeding is not implemented. `--dry-run --json` includes the generated SQL / KV bulk body.

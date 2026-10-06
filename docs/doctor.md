# `cf-lite doctor`

Static checks of an app directory: `cf-lite doctor [--strict] [--json] [--budget <KiB>]`. `--fix` applies the safe autofixes (only `CFL003` when the date is *missing*, `CFL006`, `CFL011`, `CFL012`; plain file edits, comments kept, never installs, never overwrites a value you set), then re-checks; `--fix --dry-run` prints the diff and changes nothing. Exit code 1 when any `error` is found
(`--strict`: also on `warn`). It only reads files; nothing is changed. Each finding has a stable code, listed here with what it means and the fix.
Wrangler config is read from `wrangler.jsonc` / `wrangler.json` (top level; `env.*` sections are not merged).

## CFL001
**error** - no `wrangler.jsonc`/`wrangler.json` in the directory, or it does not parse. Run doctor in your app directory; `bun create cf-lite` makes one.

## CFL002
**warn** - only a `wrangler.toml` exists. `cf-lite db`, `add` and `doctor` read JSONC only; convert the file.

## CFL003
**error** - `compatibility_date` is missing, not `YYYY-MM-DD`, or (warn) in the future (wrangler rejects dates newer than the installed workerd). Set it to a recent date.

## CFL004
**warn** - `compatibility_date` is older than 180 days. New scaffolds pin a date at most 90 days old. Bump it, run your tests, and read the compatibility-date changelog for behaviour changes.

## CFL005
**warn** - a binding (D1, KV, R2, Hyperdrive, queue producer, DO, service, AI, Images, rate limiter, assets binding, `vars`) is declared in wrangler but absent from `interface Env` (looked up in `worker-configuration.d.ts`, `server/env.d.ts`, `env.d.ts`, `src/env.d.ts`); or there is no `interface Env` at all. Add it, or generate the types with `wrangler types`.

## CFL006
**info** - `interface Env` has an UPPER_CASE member with no wrangler binding, var, or `.dev.vars` / `.dev.vars.example` entry. Usually a secret set with `cf-lite secrets push`; list it in `.dev.vars.example` to silence.

## CFL007
**warn** - `assets.run_worker_first` is `true` or `["/*"]` without negations, so the Worker runs (and is billed) for static files too. Scope it to `["/api/*"]` (cf-lite adds SSR route globs itself) or negate asset paths.
**error** - `run_worker_first` is set but there is no Worker (`main`) to run.

## CFL008
**warn** - `server/cron/*` handlers exist but `triggers.crons` is empty (they never fire); `triggers.crons` with no handlers and no `worker.ts`; or `server/queues/*` handlers without a wrangler `queues` producer/consumer entry. Fix with `cf-lite add cron|queue <name>`.

## CFL009
**error** - a Durable Object binding whose class has no `migrations` entry (`new_classes`/`new_sqlite_classes`); deploy fails. `cf-lite add do <name>` writes both. Bindings to another script (`script_name`) are exempt.

## CFL010
**warn/error** - gzipped size of the last build's Worker exceeds the budget (default 1024 KiB, `--budget`), or (error) the 3 MiB free-plan limit. Only checked when a build exists. `cf-lite analyze` shows the largest modules.

## CFL011
**info** - a D1 binding has no migrations directory (`migrations/` or its `migrations_dir`). `cf-lite db new init` creates the first migration.

## CFL012
**warn** - `cfLite({ draft })` is enabled but `DRAFT_SECRET` is not declared in wrangler `vars`, `.dev.vars` or `.dev.vars.example`; `/api/draft/enable` fails closed with 503. Generate a value with `openssl rand -base64 32` (>= 32 chars) and set it as a secret.

## CFL013
**error** - `SSO_PUBLIC_KEYS` is declared but `SSO_AUDIENCE` is not. `cf-lite/modules/sso` requires an expected `aud`: without it every verify is a config error (`requireSso` answers 500, `verifySsoToken` returns `{ ok: false, config: true }`). Add `SSO_AUDIENCE` as a plain var, set to the `aud` your issuer mints.

## CFL014
**error** - the app has `render = "rsc"` pages but wrangler `compatibility_flags` has neither `nodejs_compat` nor `nodejs_als`. `getRequest()` / `getEnv()` from `cf-lite/rsc` use `AsyncLocalStorage`, which workerd only provides with one of those flags; the failure shows up at request time. See [rsc.md](rsc.md).

## CFL015
**error** - the app has `render = "rsc"` pages but `package.json` lacks one of the pinned RSC dependencies (`@vitejs/plugin-rsc`, `react`, `react-dom`, `react-server-dom-webpack`, `rsc-html-stream`), uses a range instead of an exact version, has `react` / `react-dom` / `react-server-dom-webpack` on different versions, or has `react` below the patched floor (19.2.8, or any 19.3+). cf-lite follows vinext's ranges and pins exactly; copy the versions from `examples/site-rsc/package.json`.

## CFL016
**warn** - a `Content-Security-Policy` with a `script-src` lacking `'unsafe-inline'` is in `_headers`, the app has `render = "rsc"` pages, and no `security()` middleware is present to stamp nonces. RSC pages carry inline scripts (bootstrap + Flight payload); without a nonce the browser blocks them and the page never hydrates. Use `security()` (nonce is applied to every inline RSC script; such responses bypass `cache`/`isr`) or `export const hydrate = false` for pure server pages.

## CFL017
**warn** - a built page (`dist/client/**/*.html`) has an island (`*.island.tsx`) whose props are larger than 8 KiB. Island props are JSON inlined in the HTML (`data-p`), parsed before hydration and sent on every request of an SSR page; render-time hard limit is 64 KiB. Pass an id and fetch the data from inside the island, or trim the props to what the first paint needs. Only runs when a build exists.

## CFL018
**error** - the built Worker contains the `/__preview` runtime or the mock layer (`cf-lite/modules/preview`, `cf-lite/modules/mock`). cf-lite generates both behind `import.meta.env.DEV`, so a normal build drops them (checked by `scripts/preview-e2e.mjs`); this fires when you import one of those modules yourself from `server/` or `app/` code, which ships it. Remove the import. Only runs when a build exists.

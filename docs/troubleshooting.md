# Troubleshooting

Two indexes: by `cf-lite doctor` code, then by the text you see. Run `bunx cf-lite doctor` first; it only reads files and each code has a full page entry in [doctor.md](doctor.md).

## By doctor code

| Code | Level | One line | Fix |
|---|---|---|---|
| CFL001 | error | no/unparseable `wrangler.jsonc` | run in the app directory ([doctor.md](doctor.md#cfl001)) |
| CFL002 | warn | only `wrangler.toml` | convert to JSONC ([doctor.md](doctor.md#cfl002)) |
| CFL003 | error | bad/missing/future `compatibility_date` | set a recent date ([doctor.md](doctor.md#cfl003)) |
| CFL004 | warn | `compatibility_date` > 180 days old | bump + test ([doctor.md](doctor.md#cfl004)) |
| CFL005 | warn | binding missing from `interface Env` | `bunx cf-lite types` ([doctor.md](doctor.md#cfl005)) |
| CFL006 | info | `Env` member with no binding/var | list in `.dev.vars.example` ([doctor.md](doctor.md#cfl006)) |
| CFL007 | warn/error | `run_worker_first` too broad / no Worker | scope to `["/api/*"]` ([doctor.md](doctor.md#cfl007)) |
| CFL008 | warn | cron/queue handler without wrangler entry | `cf-lite add cron\|queue <name>` ([doctor.md](doctor.md#cfl008)) |
| CFL009 | error | Durable Object class without `migrations` | `cf-lite add do <name>` ([doctor.md](doctor.md#cfl009)) |
| CFL010 | warn/error | Worker gzip over budget (3 MiB hard) | `cf-lite analyze` ([doctor.md](doctor.md#cfl010)) |
| CFL011 | info | D1 binding without migrations dir | `cf-lite db new init` ([doctor.md](doctor.md#cfl011)) |
| CFL012 | warn | `DRAFT_SECRET` not declared | set a >= 32 char secret ([doctor.md](doctor.md#cfl012)) |
| CFL013 | error | `SSO_PUBLIC_KEYS` without `SSO_AUDIENCE` | add the var ([doctor.md](doctor.md#cfl013)) |
| CFL014 | error | RSC page without `nodejs_compat` | `cf-lite add rsc` ([doctor.md](doctor.md#cfl014)) |
| CFL015 | error | RSC dependency not exactly pinned | copy versions from `examples/site-rsc` ([doctor.md](doctor.md#cfl015)) |
| CFL016 | warn | strict CSP + RSC without `security()` | add `security()` ([doctor.md](doctor.md#cfl016)) |
| CFL017 | warn | island props > 8 KiB | pass an id, fetch inside ([doctor.md](doctor.md#cfl017)) |
| CFL018 | error | preview/mock layer in built Worker | remove your import ([doctor.md](doctor.md#cfl018)) |

## By symptom or error text

| You see | Cause | Fix |
|---|---|---|
| `cf-lite add: run it in your app directory (no package.json here)` | wrong cwd | `cd` into the app (`examples/my-app`) |
| `cf-lite add: no vite.config.ts found` | `add tailwind`/UI adapters edit `vite.config.ts` | create one, or add by hand ([dx.md](dx.md)) |
| `cf-lite add rsc: RSC is React-only` | no `@cf-lite/react` in `vite.config` | `bunx cf-lite add react` first ([rsc.md](rsc.md)) |
| `cf-lite: could not load HTML shell` | `index.html` lost its `id="root"` | restore the root element |
| `dist/client/index.html missing` on an API-only app | prerender needs a shell | keep a minimal `index.html` ([field-notes.md](field-notes.md)) |
| `no components found under app/` (`cfl export`) | nothing to render | add `app/components/Name.tsx` or `Name.states.ts` ([export.md](export.md)) |
| `this UI adapter cannot render components` | Svelte has no `UiServer.bind` | use react, preact or vue for preview/export ([preview.md](preview.md)) |
| `cf-lite dev` says it needs Node | Miniflare hangs under Bun, so the dev server runs on Node ([bun-first.md](bun-first.md)) | put Node 22+ on PATH |
| `cf-lite: command not found` right after `bun install --frozen-lockfile` | workspace bin symlink is created before `dist/` exists | `bun run build && bun install` |
| `/api/draft/enable` answers 503 | `DRAFT_SECRET` missing (CFL012) | [draft-mode.md](draft-mode.md) |
| `requireSso` answers 500 / `SSO_ISSUER not configured` | SSO env incomplete (CFL013) | set `SSO_ISSUER`, `SSO_PUBLIC_KEYS`, `SSO_AUDIENCE` |
| RSC page renders but never hydrates | CSP blocks inline scripts (CFL016) | [rsc.md](rsc.md) |
| Worker billed for static files | `run_worker_first` too wide (CFL007) | scope it ([middleware.md](middleware.md)) |
| `wrangler` deploys the wrong env or domain | stale `.wrangler/deploy/config.json` or inherited `CLOUDFLARE_ENV` | deploy only through `cf-lite deploy [--env x]` ([deploy.md](deploy.md), [field-notes.md](field-notes.md)) |
| Typed routes / `Env` out of date | generated files stale | `bunx cf-lite types` ([typegen.md](typegen.md)) |
| Page behaves differently after build | dev serves via Vite, build via workerd | `bun run build` then run the built output; see [testing.md](testing.md) |

Still stuck: [field-notes.md](field-notes.md) lists real friction found in use; [recipes.md](recipes.md) has task-shaped answers.

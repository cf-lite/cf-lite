# Deploy: gradual rollouts, previews, env/secrets, placement

All of it is a thin layer over `wrangler` (`versions upload`, `versions deploy`, `rollback`, `secret bulk`). Nothing runs in your Worker except the optional `defineEnv`.

## `cf-lite deploy`

| Command | What it does |
|---|---|
| `cf-lite deploy [--env x]` | fresh build for that env + `wrangler deploy` (unchanged) |
| `cf-lite deploy --gradual 10,50,100 [--health-url URL] [--soak 30] [--interval 5] [--max-failures 0]` | build, `wrangler versions upload` (0% traffic), then `versions deploy old@90 new@10`, probe, `old@50 new@50`, probe, `new@100`. `100` is appended when missing |
| `cf-lite deploy --env preview --preview-alias pr-7` | `versions upload --preview-alias pr-7`: a preview URL, no production traffic |
| `--dry-run` | prints the plan; builds and deploys nothing |

**Health gate.** At each partial step the URL is probed every `--interval` s for `--soak` s; a status >= 500, a network error, or more than `--max-failures` failing probes aborts. **Rollback**: `wrangler rollback <previous-version> -y`; the new version ends at 0%. A failing `versions deploy` step also rolls back. If the rollback itself fails the error says so and prints the manual command. With no `--health-url` the steps are promoted without a gate (a warning is shown in the plan). Probe with `/_health` (a route returning 200 only when D1/KV respond) rather than `/`.

First deploy of a Worker (no current version) goes straight to 100%.

Caveats *(verify on your account)*: the current version is read from `wrangler deployments list --json`; Durable Object class migrations cannot be gradually deployed (wrangler refuses, deploy normally); a gradual deploy is per-Worker, so split-traffic users can hit either version: keep D1 migrations backward compatible (expand, deploy, contract).

### Preview safety

`--preview-alias` refuses to run unless `wrangler.jsonc` has `env.<name>`, and errors when that env re-declares any production `d1_databases`/`kv_namespaces`/`r2_buckets`/`hyperdrive`/`queues`/`vectorize`/`services` id/name, or claims `routes`. Wrangler does not inherit bindings into `env.*`, so a bare preview env is isolated but has no bindings: that is a warning, give it its own D1/KV/R2 ids. Cron triggers on a preview warn. Previews should send `X-Robots-Tag: noindex` (set it in the preview env `vars` and in your headers middleware).

## CI templates

`cf-lite add ci` writes `.github/workflows/preview-cf-lite.yml` (per PR, alias `pr-<n>`, comments the URL, fork PRs skipped) and `production-cf-lite.yml` (push to `main`, GitHub Environment `production` with required reviewers = the approval gate, then `--gradual 10,50,100`). Never overwrites. You add: secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (least privilege: Workers Scripts edit + the specific resources), variable `HEALTH_URL`, the `production` environment.

## Typed env: `cf-lite/modules/env`

```ts
import { defineEnv, envGuard } from "cf-lite/modules/env";
import { z } from "zod"; // any Standard Schema lib, or plain (v) => parsed functions
const env = defineEnv({ API_KEY: z.string().min(20), ORIGIN: (v) => new URL(String(v)).origin });
app.use("*", envGuard({ API_KEY: z.string().min(20) })); // 500 "Server misconfigured", names logged, never values
const { API_KEY } = env(c.env); // validated once per isolate
```

Fails closed: the error lists every missing/invalid name, never a value. Extra bindings pass through.

## `cf-lite secrets push [--file .dev.vars] [--env x] [--only A,B] [--dry-run] [--force]`

Parses the dotenv file, refuses if it is not in `.gitignore` (or has empty values), logs names only, and gives wrangler the *file path* (`wrangler secret bulk`), never argv values. wrangler's own output is withheld. Secret names that exist remotely but not locally are not deleted.

## Smart Placement: `cf-lite add placement`

Adds `"placement": { "mode": "smart" }` (comments kept; existing placement untouched). Helps Workers making several round-trips to one backend (D1 primary, Hyperdrive); it moves Worker execution, not assets, and can add latency for users far from the backend when the Worker is mostly static. Measure before keeping it.

## Deploy smoke (nightly CI)

`.github/workflows/deploy-smoke.yml` (nightly and `workflow_dispatch`, hosted runner) builds `examples/site`, deploys it to workers.dev as `cfl-smoke-<run id>`, checks `/`, `/about/`, `/api/hello` and `/blog/hello` (status codes only), measures the p50 round trip of 30 requests (limit 1500 ms from the runner), then **always** deletes the worker (and confirms the API answers 404) and sweeps any `cfl-smoke-*` worker older than one day. It uses the repo secret `CLOUDFLARE_API_TOKEN` (Workers-scoped) and the variable `CLOUDFLARE_ACCOUNT_ID`. The heavier `perf-budget --live` stays a manual run ([performance-budgets.md](performance-budgets.md)): it re-measures locally too and would deploy a second worker per night.

## Not covered / needs a human

Real gradual/preview runs on an account, Action secrets and any production deploy are a human decision. Service-binding typed clients (`server/services`) are the roadmap's stretch item and are not implemented yet.

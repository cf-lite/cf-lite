# Contributing to cf-lite

Thanks for looking. cf-lite is deliberately small: **Vite + Hono + Workers static assets, no runtime**. Changes that add
a runtime layer between user code and workerd are unlikely to be accepted - see [`docs/design.md`](docs/design.md) first.

## Setup

Bun 1.4+ ([bun.sh](https://bun.sh); CI pins 1.4.0). Node 22+ is needed only for what runs Miniflare (`wrangler dev`, `vite dev`, the `test:e2e` / `test:dev` / `test:browser` scripts, the coverage run; see [docs/bun-first.md](docs/bun-first.md)). `npm test`-style commands are `bun run`; never write `npm run X -w pkg` in a script (Bun re-runs it forever), use `bun run --filter pkg X`.

```bash
git clone <this repo> && cd cf-lite
bun install --frozen-lockfile
bun run build          # tsc for the core + the four UI adapters (dist/ is git-ignored)
```

A fresh clone needs only that one `bun install`: `bun run typecheck` builds first and then runs a second, near-instant `bun install --frozen-lockfile`, because the workspace `cf-lite` bin can only be linked once `dist/` exists.

The repo is an npm-workspaces monorepo: `packages/*` (published) and `examples/*` (demo + one app per UI adapter).

## Tests - run what your change touches

| command | what it covers | needs |
|---|---|---|
| `bun run typecheck` | `tsc --noEmit` for every package and example | - |
| `bun run test` | build + vitest unit tests | - |
| `bun run test:e2e` | builds demo, every adapter app and every `create-cf-lite --ui` scaffold, runs them under local workerd and asserts *which requests reach the Worker* | network (bun install of scaffolds) |
| `bun run test:dev` | `vite dev` behaviour (SSR route add/remove restart, dev SSR per adapter) | - |
| `bun run test:browser` | Playwright (chromium) shared suite against the demo, the four adapter apps, the htmx example and an axe gate on the docs site | `bunx playwright install chromium` |
| `bun run test:browser:all` | the same in chromium + firefox + webkit (local only; CI is chromium-only) | `bunx playwright install firefox webkit` (+ `sudo bunx playwright install-deps webkit`); `PW_DEMO_PORT` if 18999 is taken |
| `bun run perf:check` | build time / cold start / request p50 / Worker size vs `bench/budgets.json` (local or cron, not CI) | - |

CI (`.github/workflows/ci.yml`) runs all of them on every push and PR.

## Guidelines

* A new adapter must implement the contract in [`docs/adapters.md`](docs/adapters.md) and get an example app under
  `examples/` wired into `e2e/site.spec.ts`, `scripts/run-sites.mjs` and `scripts/dev-ui-e2e.mjs`.
* Behaviour that decides *what runs in the Worker* needs an e2e assertion, not only a unit test.
* Performance claims need numbers from `bench/` and an honest caveat; see `bench/methodology.md`.
* Keep commits focused; describe the why. Update `CHANGELOG.md` for user-visible changes.
* By contributing you agree your contribution is licensed under the MIT license of this repo.

## Security

Report vulnerabilities privately - see [`SECURITY.md`](SECURITY.md).

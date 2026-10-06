# AGENTS.md - working in a cf-lite app or in this repo

cf-lite is a Vite plugin + CLI for Cloudflare Workers apps (file routes, Hono API, opt-in modules). Docs: `docs/` (index `docs/README.md`); one-line page index: `llms.txt` (generated; do not edit).
Open source (MIT), version 0.x. Maintaining this repository (docs, releases, CI, dependency audit)? Start at [`agents/README.md`](agents/README.md); this page is the Do and Don't list for app code.

## Do

- Add capabilities with the CLI, not by hand: `bunx cf-lite add <d1|kv|r2|queue|cron|do|auth|ci|tailwind|ai|images|...> [--dry-run]`. Every target is idempotent and never overwrites your files. Preview with `--dry-run` first.
- After any change run `bunx cf-lite doctor` (codes `CFL001`-`CFL018`, [docs/doctor.md](docs/doctor.md)) and `bunx cf-lite types` when routes or `wrangler.jsonc` bindings change.
- Routes are files: `app/routes/**` (pages; `export const render = "static" | "ssr"`), `server/api/<name>.ts` (one Hono sub-app per file), `server/middleware.ts`, `server/worker.ts` (your own root app). See `docs/conventions.md`.
- Deploy only through `bunx cf-lite deploy [--env <name>]` (fresh build for that env), never a bare `wrangler deploy` after an old build.
- Component work: put states in `Name.states.ts`, look at them in `/__preview` (dev only), data via `mocks/` + `MOCK=1`; `cfl export` writes fragments.
- Tests: `bun run test` runs inside workerd via `@cf-lite/testing` (`docs/testing.md`).

## Don't

- Don't edit `.cf-lite/` (generated) or hand-write binding entries that `add` can write; comments in `wrangler.jsonc` are preserved by `add`.
- Don't read or print secrets: `.dev.vars`, `.env*`, tokens. Declare names in `.dev.vars.example`; push with `cf-lite secrets push` (prints names only).
- Don't import `cf-lite/modules/preview` or `cf-lite/modules/mock` from app code (ships dev tooling; doctor CFL018).
- Don't add `unsafe-inline` to CSP to "fix" RSC; use `security()` (CFL016).
- Don't claim something works without running it; paste the command and its output.

## In this repo (monorepo)

- Build first: `bun run build`. Unit tests `bun run test`; e2e `bun run test:e2e`; dev tooling `bun run test:dev`.
- Docs gates: `bun run docs:check` (links, anchors, CFL ranges vs `doctor.ts`) and `bun run llms:check`. After editing any `docs/*.md` run `bun run llms:gen` and commit `llms.txt`.
- Opt-in rule: importing a module you don't use must cost 0 bytes in the Worker (`bun run size:check`).
- One PR per task. Docs-only PRs run only the cheap docs lint.

## Where things are

`packages/cf-lite/src/` CLI + plugin + modules - `packages/create-cf-lite/templates/` scaffolds - `examples/` apps - `scripts/*-e2e.mjs` end-to-end - `docs/troubleshooting.md` when something breaks.

@agents/README.md

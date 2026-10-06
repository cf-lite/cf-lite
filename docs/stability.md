# Stability and versioning

cf-lite is **0.x** (open source, MIT; packages on npm at 0.4.0 or later, see [published.md](published.md)). This page states the policy the 1.0 release will follow and what holds today. Targets that are not yet enforced by CI are marked *(planned)*.

## What is public API

Covered by semver from 1.0: the `exports` map of every package (`cf-lite`, `@cf-lite/*`, `create-cf-lite`), CLI commands and flags, file conventions
(`app/routes`, `server/*`, `_layout`/`_loading`/`_error`/`_not-found`), and the shapes users import from generated files (`.cf-lite/app`, typed routes).
Private: everything else under `.cf-lite/`, unexported `src/*`, and the generated code's internals.

## Tiers

| Tier | Meaning | Today |
|---|---|---|
| stable | semver, deprecations live >= 1 minor with a warning | not yet declared (0.x: minor versions may break, each with an upgrade note) |
| experimental | may change in any release | `modules/realtime` presets beyond the base class, `modules/ai`, `modules/vectors`, OTel, OG images |

Experimental pages say so in their title. Promotion needs at least one production app.

## Breaking changes

Every breaking change ships with a codemod in `cf-lite upgrade` ([dx.md](dx.md)) or a manual step in [upgrading.md](upgrading.md), and a CHANGELOG entry.

## Support matrix (what CI exercises today)

Bun 1.4 (every PR: install, build, typecheck, unit tests, docs tooling), Node 24 (every PR: Miniflare-based e2e, coverage) and Node 22 (weekly), Vite 8, `@cloudflare/vite-plugin` 1.x, wrangler 4.x, Hono 4.x, React 19, Preact 10, Vue 3.5, Svelte 5, Solid 1.9. Scaffolds pin a
compatibility date; `cf-lite doctor` warns beyond 180 days ([doctor.md](doctor.md), CFL004).

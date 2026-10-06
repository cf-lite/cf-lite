# Developer experience: `add`, templates, `doctor`, `analyze`, `upgrade`

## Templates (`create-cf-lite`)

```sh
bun create cf-lite my-app -- --template saas      # minimal | blog | saas | api | realtime | ai-chat | patterns
bun create cf-lite my-app -- --template blog --ui react
```

| Template | What you get | UI default |
|---|---|---|
| `minimal` | API + your own page (renderer `none`), `--ui` picks an adapter | none |
| `blog` | SSR posts with `seo()`, dynamic `server/sitemap.ts`, robots, manifest, `SITE_URL` | preact |
| `saas` | `add auth` (sessions + OAuth + D1 accounts migration) + `add queue emails` + a protected `/api/dashboard` | preact |
| `api` | Hono RPC routes with `rateLimit`, HMAC-SHA256 webhook endpoint that fails closed without `WEBHOOK_SECRET` | none |
| `realtime` | hibernating WebSocket chat room (Durable Object), from `cf-lite/templates/realtime` | none |
| `ai-chat` | streaming chat page over the Workers AI binding (billed per use; remote in dev) | none |
| `patterns` | pattern library: `app/patterns/{atoms,molecules,organisms}`, `*.states.ts`, `/__preview`, `mocks/`, `cfl export`, `@/` + `@patterns/` aliases ([coming-from-mvc.md](coming-from-mvc.md)) | react |

A template is a directory under `packages/create-cf-lite/templates/<name>/` laid over the `minimal` base, plus `template.json`
(`ui`, and `add` steps that run the same code as `cf-lite add`). Each template's `scripts/scaffold-e2e.mjs` run builds it under workerd and probes it.

## `cf-lite add <target>`

`d1|kv|r2|hyperdrive` (bindings), `patterns` (pattern folders + states + mocks + aliases, [coming-from-mvc.md](coming-from-mvc.md)), `do|cron|queue|workflow|email <name>`, `auth`, `placement`, `ci`, `tailwind`, `ai`, `images`, `turnstile`, `rsc`, and UI adapters
(`react|preact|vue|svelte|solid|htmx`). Every target is **idempotent** (second run changes nothing), never overwrites a file you own, keeps comments in
`wrangler.jsonc`, and prints what it changed.

`--dry-run` (every target): runs the real code against a scratch copy of the app and prints the difference - `+ path` new file, `~ path` edited with `+line` / `-line` -
without touching your directory. It cannot drift from the real run because it *is* the real run.

- `add tailwind`: Tailwind 4 via `@tailwindcss/vite`; adds the plugin to `vite.config.ts`, `app/styles.css` (`@import "tailwindcss"`) and a `<link>` in `index.html`.
  For a UI adapter that imports CSS from the entry, `import "./styles.css"` there instead and drop the `<link>`.
- `add ai` / `add images`: wrangler binding (`AI`, `IMAGES`), `Env` typing; `ai` also scaffolds `server/api/ai.ts`.
- `add turnstile`: `server/api/signup.ts` guarded by `turnstile()` and a `TURNSTILE_SECRET` in `.dev.vars.example` (Cloudflare's always-pass test key for dev).

- `add rsc`: opts a **React** app into [render = "rsc"](rsc.md): the exact-pinned dependencies (`@vitejs/plugin-rsc`, `react`, `react-dom`, `react-server-dom-webpack`, `rsc-html-stream`; `cf-lite doctor` CFL015 checks them),
  `nodejs_compat` in `wrangler.jsonc` (merged into existing `compatibility_flags`, comments kept; CFL014), and starter files `app/routes/rsc.tsx` (server component + Suspense + `getRequest()`), `app/routes/_layout.rsc.tsx`,
  `app/islands/counter.tsx` (`"use client"`), never overwriting yours. Refuses an app without `@cf-lite/react` in `vite.config.ts` (run `cf-lite add react` first).

## `cfl` (alias), `cfl export`, `cf-lite dev --mock`

`cfl` is a second `bin` entry of the same CLI. `cfl export` writes HTML fragments per component state ([export.md](export.md)); `cf-lite dev --mock` = `MOCK=1 cf-lite dev` ([mocks.md](mocks.md)); `/__preview` is the dev-only component browser ([preview.md](preview.md)).

## `cfl init`

```sh
cfl init                                   # asks: UI adapter, bindings/features, agent files
cfl init --yes --ui react --with d1,kv,queue:emails   # no prompts (also the default when stdin is not a TTY)
cfl init --yes --no-agents --no-fix --no-install --dry-run
```

One pass over steps that already exist: `add <ui>`, then each `--with` item as `add <item>` (`d1|kv|r2|hyperdrive|tailwind|ai|images|turnstile|rsc|auth|ci|patterns`, and
`queue|cron|do|workflow|email` as `kind:<name>`), `.dev.vars.example` (never overwritten), the agent files (below), then `doctor` with its safe fixes. Items are validated
before anything is written. Every prompt has a flag (`--ui`, `--with`, `--no-agents`, `--no-fix`); a flag answers its prompt, `--yes` takes defaults for the rest (no UI change, no extras).
Because each step is the real `add`, `init` is idempotent and `--dry-run` is the same scratch-copy diff as `add --dry-run`. It does not create a project: that is `bun create cf-lite`.

## `cfl add agents`: files for coding agents

Written by `init`, or alone with `cfl add agents`. One source (`AI_SOURCE` in `src/ai-assets.ts`: rules + commands, plus the app's UI and bindings) is rendered to
`AGENTS.md` (canonical), `CLAUDE.md` (`@AGENTS.md` import, appended to an existing file once), `.claude/skills/cf-lite/SKILL.md` (Claude Code skill) and
`.github/copilot-instructions.md`. Existing files are kept, never rewritten. Content: use `cfl` instead of hand-editing `wrangler.jsonc`, `--dry-run` first, files are the router,
secrets never in the repo, run `cfl doctor`, never deploy unasked. A test asserts every target carries every rule.

## `cf-lite doctor`

See [doctor.md](./doctor.md): every finding code (`CFL001`-`CFL018`) and its fix. `cfl doctor --fix` applies the safe subset (`CFL003` missing date, `CFL006` secrets listed in `.dev.vars.example`, `CFL011` empty first migration, `CFL012` `DRAFT_SECRET=`); `--fix --dry-run` prints the diff.

## `cf-lite analyze`

After `cf-lite build`: Worker size (raw + gzip, largest modules) and **client JS per page** - the gzip size of every JS file an HTML page loads,
following static imports from its entry scripts (lazy `import()` chunks are not counted, which is what the browser downloads up front).
`--json` for CI. Pair with `doctor --budget` for a size gate.

## `cf-lite upgrade`

`cf-lite upgrade [--to x.y.z] [--dry-run] [--no-install]`: runs the codemods between the version your `package.json` declares and the target (default: the installed cf-lite),
bumps `cf-lite` and `@cf-lite/*` ranges (never downgrades), installs, and prints manual steps. Codemods are idempotent, text-level (no AST dependency) and
report a manual step instead of guessing when a file is shaped unusually.

| id | from -> to | does |
|---|---|---|
| `0.3-renderer` | < 0.3 | `renderer: "react"` -> `renderer: react()` + import; `Link`/`mount` from `cf-lite/client` -> `@cf-lite/<ui>/client` |
| `0.4-sso-env` | < 0.4 | adds `SSO_ISSUER`/`SSO_PUBLIC_KEYS` to `.dev.vars.example` when `modules/sso` is used; the values themselves are a manual step |

Rule for maintainers: every breaking change ships a codemod in `src/upgrade/codemods.ts` (with before/after fixtures in `test/fixtures/upgrade/`) or an entry in
`NO_AUTOMATED_PATH`.

## Generators and seed

`cfl g page|api|component|test <name>` and `cfl seed` (every generator has `--dry-run` and `--json`): see [generators.md](generators.md).

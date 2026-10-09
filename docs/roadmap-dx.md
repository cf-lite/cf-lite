# Developer toolkit roadmap (LINE 1: open, generic)

Status: proposal, 2026-10-02, against `main` after #30. Nothing here is committed scope, **except what the 2026-10-02 DX-kit PR built early (section 6)**. **No publish / npm / open-source decision is taken or implied**;
"open" only means the generic, framework-agnostic line (no Optimizely). The Optimizely line (LINE 2) is a separate roadmap and is built on this one.
Parent plan: [roadmap-1.0.md](roadmap-1.0.md) (WP-DX, WP-DOCS, WP-TESTING).

## Principle (the owner)

> The user should find it easy: everything that can be predefined / pre-set-up, we do. Easy enough to start, open enough to use.

Rules that follow from it: one command gets a working, deployable app; every default is overridable; every generator is a plain, idempotent, `--dry-run`-able
file writer (the existing `add` contract), so the output is code the user owns, not a runtime.

## Entry gate (LIFTED 2026-10-02, see section 4 decision 5)

Originally: build **only after** the product is stable and the process/knowledge is standardized. Concretely, all of:
1. 1.0 readiness audit passed ([roadmap-1.0.md](roadmap-1.0.md) section 2; [stability.md](stability.md) API frozen for `add`/conventions/generated code shape).
2. The file conventions and generated-code shape ([conventions.md](conventions.md), [typegen.md](typegen.md)) are frozen: a generator must not chase a moving target.
3. Recipes ([recipes.md](recipes.md)) cover the tasks the generators will automate; a generator is a recipe made executable, never the other way round.
4. >= 3 real apps ran >= 30 days (same bar as 1.0) so the "predefined" choices come from evidence, not guesses.
Before the gate: only S-size items marked **now** below (docs and cleanups that need no frozen API).

## 1. CLI (`cf-lite` binary; `cfl` alias decided, not yet present - see section 4)

`bin` is `cf-lite` only today (`packages/cf-lite/package.json`). Commands today: `dev prepare|types build deploy secrets add doctor analyze upgrade db` (`packages/cf-lite/src/cli.ts`).

| Capability | What exists (link) | Gap / work | Size |
|---|---|---|---|
| `init`: complete, lean Cloudflare setup | `npm create cf-lite` + templates minimal/blog/saas/api/realtime/ai-chat ([dx.md](dx.md), `packages/create-cf-lite/templates/`); `add d1\|kv\|r2\|hyperdrive\|queue\|cron\|do\|workflow\|email\|auth\|ci\|tailwind\|ai\|images\|turnstile` (`src/add*.ts`, `wrangler-edit.ts`) | One interactive `init` that picks bindings (KV/R2/D1/Queue) in a single pass, writes secret placeholders + `.dev.vars.example`, runs `doctor` at the end. Mostly composes existing `add` steps | M |
| `doctor` | CFL001-CFL018 (`src/doctor.ts`, [doctor.md](doctor.md)); doc ranges are now checked against `doctor.ts` by `npm run docs:check` | Add `--fix` for the safe subset; "post-init" profile; each code keeps a doc page | S-M |
| Generators: route/page, component, API, test | Route files are conventions ([routing.md](routing.md)), `cf-lite/testing` + Playwright ([testing.md](testing.md)); typed routes regenerate on `prepare` ([typegen.md](typegen.md)) | `cf-lite g page\|api\|component\|test <name>`: same machinery as `add` (idempotent, never overwrite, `--dry-run`); writes component + fixture + test together | M |
| Sync / seed sample data | `cf-lite db` ([`cli-db.ts`](../packages/cf-lite/src/cli-db.ts)), D1 migrations | `cf-lite seed` runs `seeds/*.json|sql` against local D1/KV/R2 (and `--remote` with confirm); generators emit a seed file | M |
| Natural-language mode | none | LLM plans a list of **generator invocations** and calls the same CLI (`cf-lite g ... --json`); no free-form code. Needs `--json` plan/dry-run output (already close: `--dry-run` prints diffs) | M, after generators |
| AI assets | [ai.md](ai.md) is the *runtime* AI binding, not agent files | `init` writes `AGENTS.md` (+ `CLAUDE.md` import), a Claude Code / Copilot skill, `llms.txt`/`llms-full.txt` generated from `docs/` (the docs site `site/` is the source). Content = conventions + "use `cf-lite g`, don't hand-write wrangler" | S-M |
| Docs: quickstart, recipes, troubleshooting | [getting-started.md](getting-started.md), [recipes.md](recipes.md), [doctor.md](doctor.md), [field-notes.md](field-notes.md) | Single "quickstart in 10 min" tied to `init`; troubleshooting page indexed by CFL code and by error text; recipes get a "or run: `cf-lite g ...`" line | S |

Design constraints: generators live in new files per target (SEAMS pattern, no edits to shared `generate.ts`); every one gets golden `--dry-run` output + run-twice-no-diff test (WP-DX acceptance).

## 2. Component preview (both lines)

Need: see each component in isolation with realistic data, in the real runtime, with the least setup for a human **and** for an LLM that has to write/maintain it.

| Option | Setup / bundle cost | React 19 + Vite + Workers SSR | LLM-friendliness | Verdict |
|---|---|---|---|---|
| Storybook 9 | Heavy: ~dozens of devDeps, own Vite builder + config, separate build/dev server, CSF files per component | Works with React 19 + Vite, but renders in a browser iframe, **not** Workers SSR; Cloudflare bindings absent | Many files, story API to learn; LLMs write CSF well but it is 2 sources of truth | Optional adapter for teams that already use it, never the default |
| Ladle | Light (Vite-native, CSF stories) | React only; browser, no workerd | Same CSF files, fewer features | Same as above, lighter |
| Histoire | Light, Vite-native | **Vue/Svelte oriented**; not React 19 first-class | n/a for React lines; fine for the Vue adapter | Only as a Vue-adapter option |
| **Built-in `/__preview` route** | ~0 deps: a dev-only route generated by the Vite plugin, stripped from the prod build (same mechanism as `vite-strip.ts`) | **Yes by construction**: it is the app's own SSR in workerd, any UI adapter (`react\|preact\|vue\|svelte`) | One convention: `Foo.tsx` + `Foo.fixtures.json`; no framework API | **Recommended default** |
| Plain HTML/handlebars fixtures | None | Not the real component | Easy but renders a copy, drifts from the real thing | Rejected: tests the wrong thing |

Storybook/Ladle/Histoire cost and compatibility statements above are from general knowledge, **not measured here**; before the gate, measure install size + cold start on one example (`examples/site-*`) and fill in numbers.

**Recommendation.** Fixtures as plain JSON next to the component (`components/Card.tsx`, `components/Card.fixtures.json` = `{ "default": {props}, "empty": {props} }`).
`cf-lite g component Card` writes both, plus a test that renders every fixture (so fixtures are also the unit-test data). Dev server serves `/__preview` (index) and
`/__preview/Card?fixture=empty`, rendered by the real adapter; production build drops the route (add a doctor check that fails if `__preview` is in the built Worker).
An LLM only has to read/write JSON + the component; no story DSL. Storybook stays an opt-in `add storybook` recipe, not part of the core.

## 3. Phasing

| Phase | Gate to start | Content | Effort | Main risk |
|---|---|---|---|---|
| P0 **done** (dx0, 2026-10-02) | none | Fix doc drift ([dx.md](dx.md) CFL range), write quickstart/troubleshooting, `AGENTS.md` (hand-made) + `llms.txt` (generated by `scripts/gen-llms.mjs`, CI drift check) | S | content rots -> `docs:check` + `llms:check` in CI |
| P1 (built 2026-10-02, `feat/dx1-init`) | entry gate (lifted) | `init` (compose `add`) + `doctor --fix` + AI assets emitted by `init` | M | defaults wrong for some apps -> keep every prompt skippable (`--yes`) |
| P2 | P1 + frozen conventions | `g page\|api\|component\|test` + fixtures + `/__preview` + `seed` | M-L | generator output drifting from conventions -> golden tests |
| P3 **built** (dx3, 2026-10-02; [llm.md](llm.md)) | P2 | tool surface + `cfl mcp` + `cfl ask`, consent, eval set | M | model proposes unsafe plans -> allow-list of generators only, always dry-run first |
| P4 | P2 | `add storybook` / `add ladle` adapters (opt-in) | S | maintenance of third-party versions |

## 4. Decided 2026-10-02 (the owner)

1. **Binary:** add the `cfl` alias; `cf-lite` stays too (alias is a second `bin` entry, no npm action implied).
2. **Preview:** build our own built-in preview (`/__preview` + JSON fixtures), easy and feature-complete enough for real use. Storybook/Ladle-style tools only as optional plugins (`add storybook` / `add ladle`), never the default.
3. **Natural-language mode comes AFTER generators:** features and stability first (P3, as phased above; design in [section 5](#5-llm-layer-design-three-modes-one-tool-surface)).
4. **LLM:** use the LLM/agent the developer already has; ship a minimal backup for when none exists. The toolset + presets must cover every feature, so the LLM is only a thin natural-language layer that calls them (allow-listed generators, `--json`, dry-run first) - never a source of free-form code. Full design: [section 5](#5-llm-layer-design-three-modes-one-tool-surface).
5. **Entry gate: LIFTED 2026-10-02** (owner: waiting becomes the blocker). Build now, in the phase order of section 3. The gate conditions in "Entry gate" above stay as the *quality bar* each generator is tested against (frozen conventions, recipes first, golden tests), not as a reason to wait. Earlier text: first of 1.0 RC1 or the end of the 30-day soak (~2026-10-31).

6. **A CMS-specific head** stays outside the core package: cf-lite core does not depend on it, and nothing for it ships in the published packages.
7. **Terms and consent for the LLM layer:** the toolkit ships its own terms. On first use of `cfl ask` / `cfl setup assist` the CLI shows a short notice (what is sent, to which provider, a link to that provider's data-use terms, a link to our toolkit terms) and requires explicit consent once, stored locally; `cfl ask --terms` reprints it. Docs never claim "private" beyond what the provider's terms say. (Details: [section 5.5](#55-privacy-safety-failure-behavior).)
8. **`cfl mcp` ships inside the CLI** (single install); no separate `@cf-lite/mcp` package. A dev tool should not be fussy; too many choices confuse users.

Nothing else open at line level.

## 5. LLM layer design: three modes, one tool surface

Status: design proposal, 2026-10-02 (the owner's idea, completed here). Builds nothing before the entry gate; the **tool surface** (section 5.1) is what gets built first, because modes 1 and 2 need no model at all.
Rule kept from the decisions: the toolset + presets cover every feature; the LLM is a thin natural-language layer that only calls them. Never free-form code, never shell.

### 5.1 One tool surface

Every capability is one typed tool: `init`, `add <target>`, `g page|api|component|test`, `seed`, `doctor` (+`--fix`), `preview` (list/open fixtures), `analyze`, `upgrade --dry-run`.
Each tool has a JSON Schema for its arguments, a `--dry-run` that returns the file diff as JSON (exists today for `add`, see [dx.md](dx.md)), and an idempotent apply. The CLI, the MCP server and the NL mode are three front doors to the *same* functions - no behavior lives in the front door. A tool that cannot be described by a schema is not a tool yet.

### 5.2 The modes

| | Mode | Who is the LLM | What we ship | Cost / key |
|---|---|---|---|---|
| 1 | **Agent (default)** | The developer's own harness (Claude Code, Copilot, Cursor, ...) | Skill, `AGENTS.md`, `llms.txt` (see section 1, AI assets) **and** `cfl mcp`: an MCP server, part of the same CLI install (no separate package), exposing the section 5.1 tools with their schemas (stdio, local, no network) | none from us, no key |
| 2 | **Manual** | none | Plain deterministic `cfl ...` commands (also what every mode ultimately runs) | none |
| 3 | **Fallback NL** | A small model on the *user's* Cloudflare account, or their own key | `cfl ask "<text>"`; optional `cfl setup assist`; optional dev-server "ask" box | user's own Workers AI usage / own key |

Mode 1 needs the least invention: MCP is the standard way for an agent to call typed tools, and the shipped assets tell the agent "use these tools, do not hand-edit `wrangler.jsonc`". Mode 3 exists only for a developer who codes by hand and has no agent.

### 5.3 Fallback NL mode (`cfl ask`)

Flow: user text + minimal context -> model returns **tool calls** (JSON-schema function calling) -> CLI validates each call against the schema and an allow-list -> prints the **plan** and the **file diff** (the tools' own dry-run) -> applies only after confirm (or `--yes`).

Backends, in order of preference:
1. **Workers AI via the account the user already logged into with wrangler**: REST `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/<model>` with `Authorization: Bearer <token>`; the token needs Workers AI Read + Edit; a successful response is `{ "result": {...}, "success": true, "errors": [], "messages": [] }` ([REST API docs](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)). Account id and token come from the user's existing wrangler/env setup via the repo's no-print secret handling; we never store them. *Unverified:* how to obtain a Workers-AI-scoped token from a plain `wrangler login` OAuth session (wrangler's OAuth scopes may not include Workers AI); the fallback is the user creating a scoped token once, which `cfl setup assist` would walk through.
2. **Assistant Worker with an AI binding in the user's account**, deployed by `cfl setup assist` (a tiny Worker: `env.AI.run(...)`, bearer-protected, optional AI Gateway id). Same model API, no REST token on the dev machine; also the backend for the **dev-server preview panel "ask" box** (the non-CLI entry point; it posts to the local dev server, which proxies to the assistant Worker, so the browser never holds credentials).
3. **BYO key** (Anthropic, OpenAI, others) for quality; key read from env only, never written by us.
4. **Optional AI Gateway** in front of any of the above for logs, caching, rate limits, retries/fallback; available on all plans ([AI Gateway docs](https://developers.cloudflare.com/ai-gateway/)). cf-lite's runtime already supports it ([ai.md](ai.md)). *Unverified:* exact gateway URL shape per provider (not on the overview page we read).

### 5.4 Model choice (research, Cloudflare docs read 2026-10-02)

Facts (each from the model's docs page, [catalog](https://developers.cloudflare.com/workers-ai/models/)):

| Model | Function calling | Context | Price per M tokens (in/out) |
|---|---|---|---|
| `@cf/qwen/qwen3-30b-a3b-fp8` | Yes (page property) | 32,768 | $0.051 / $0.335 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Yes | 24,000 | $0.293 / $2.253 |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | **not listed** on its page | 32,000 | $0.152 / $0.287 |
| `@hf/nousresearch/hermes-2-pro-mistral-7b` | named in the function-calling docs as a fine-tuned FC model | not checked | not checked |

Free allocation: 10,000 neurons/day on all tiers, then $0.011 per 1,000 neurons ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). *Unverified:* neurons per request for these models (the pricing page we read gives per-token prices, not a neuron conversion), so "how many `cfl ask` calls fit in the free tier" is **not stated** until measured. Docs describe two invocation styles: traditional (`AI.run` with `tools`, we handle the loop) and embedded (`@cloudflare/ai-utils` `runWithTools`); we use traditional, because our loop must validate and gate each call ([function calling docs](https://developers.cloudflare.com/workers-ai/features/function-calling/)). Some models (e.g. GLM, DeepSeek-v4, Kimi) need a paid plan or prepaid gateway credits - excluded from the default.

**Recommendation (to be confirmed by the eval, 5.6):**
- **Default: `@cf/qwen/qwen3-30b-a3b-fp8`.** Cheapest listed model with function calling and a 32k window; a typical `ask` is a few thousand input tokens and a few hundred output, i.e. well under a cent (estimate from the per-token prices above, not measured). MoE with ~3B active parameters suggests low latency (general knowledge, unmeasured). It also lists "Reasoning", which may add output tokens - check it can be switched off.
- **Workers AI quality tier: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`** if the default misses the gate: ~6x price, still pennies per call, 24k window (enough: we send little context).
- **BYO-key quality fallback: a current Claude or GPT model** for users who want the best tool-call reliability; most expensive, needs a key, optional via AI Gateway for caching.
- Tool-call reliability of small open models is the real risk and is **not known**: the evaluation decides the default, not this table.

### 5.5 Privacy, safety, failure behavior

- **Never sent:** `.dev.vars*`, `.env*`, wrangler secrets, tokens, anything the no-print secret tools guard. A deny-list on paths plus a redaction pass on any text we attach; `doctor` flags a project where a secret-looking file would be in the context set.
- **Minimal context:** the user's sentence, the tool schemas, the file *list*, and only the target files a tool names (for Opti: the content-type schema, not content). Nothing else.
- **Where data goes:** mode 3a/3b: the user's own Cloudflare account (Workers AI; Cloudflare's data-use terms apply - not reviewed here). 3c: the user's chosen vendor. Modes 1/2: nothing leaves the machine from us. The dev is told which at first use and must consent explicitly (next bullet).
- **Terms and consent (decided):** first `cfl ask` / `cfl setup assist` prints a short notice: what is sent (the section above), to which provider, the link to that provider's data-use terms, and our toolkit terms; it requires explicit consent once (y/N, or `--accept-terms` for CI), stores the consent locally (per user, with the provider and terms version; a changed provider or terms version asks again), and `cfl ask --terms` reprints it. No consent = no model call; modes 1 and 2 never need it. Docs and CLI output never say "private" beyond what the provider's terms say. The wording of our toolkit terms is a drafting task before P3; it is not legal advice and should be reviewed by someone qualified.
- **Never executes shell**, never writes outside the project, never calls a tool that is not in the allow-list; schema-invalid calls are rejected, not repaired.
- **Confirm by default**: plan + diff, apply on `y` or `--yes`; `--dry-run` always available. Remote-side tools (`seed --remote`, `deploy`) are excluded from NL mode entirely.
- **Model unsure / invalid / no call produced:** ask one clarifying question, or print the closest equivalent manual command (`cfl g page about --dry-run`) and stop. After 2 invalid attempts, stop with the manual command; never loop.
- **Backend unreachable / over quota:** say so, print the manual command; no silent fallback to a different vendor (that would change where data goes).

### 5.6 Evaluation plan (gate before release)

- A fixed set of >= 60 NL prompts in `packages/cf-lite/test/nl-eval/prompts.json` (67 built; run `bun scripts/nl-eval.ts`), each with the **expected tool calls** (tool + arguments, order-insensitive where independent): easy (single tool), medium (2-3 tools, defaults), hard (ambiguous -> expected outcome is a clarifying question or manual command), and adversarial (asks for shell, for secrets, for a non-existent tool -> expected: refusal / no call).
- Scoring: exact tool + schema-valid args; argument match tolerant only on free text fields (names/titles). Report per-category pass rate, tool-call-validity rate, median latency and tokens per prompt.
- **Gate (proposed):** >= 90% on easy+medium, 100% on adversarial (zero dangerous calls), hard cases never produce a wrong *applied* change. Run for each candidate (default, quality tier, one BYO) and publish the table; the default model is the cheapest that passes.
- Re-run on any tool-schema change or model change; the same prompts also serve as regression tests for the tool descriptions. **Run 2026-10-02: results table in [llm.md](llm.md#evaluation-roadmap-dx-56); the first run failed hard/adversarial. Follow-up dx3b ([llm-eval-notes.md](llm-eval-notes.md)): after description, prompt and deterministic guard/grounding fixes the default Qwen3-30B passes the gate (easy+medium 97.6%, hard 12/12, adversarial 14/14 on the 67 set; holdout 38/38, fresh 35/37); model sweep of 15 Workers AI models + Claude Sonnet 5.5, default stays Qwen3-30B. Neurons per request still unmeasured.**

### 5.7 Open points

1. Token path for mode 3a (see the unverified note) - pick "user-created scoped token" vs requiring only the assistant Worker.
2. Drafting the toolkit terms text (see 5.5); review by someone qualified.

## 6. Built early: the DX kit (2026-10-02)

Four items were pulled forward from P2 (the owner's call; the entry gate above still governs `init`, `g ...`, `seed` and the NL layer). All are generic, with no Optimizely dependency, and opt-in by file presence - an app without `*.states.ts`, `mocks/` or components under `app/` generates exactly what it did before.

| Item | Where | Decision applied |
|---|---|---|
| Built-in `/__preview` | [preview.md](preview.md) | section 4.2: own preview, dev only, stripped from builds; states are `*.states.ts` (typed `defineStates`) rather than the JSON fixtures floated in section 2 - TypeScript props are checked by the compiler and may be computed |
| Mock layer `MOCK=1` | [mocks.md](mocks.md) | route-level JSON/handlers under `mocks/`, intercepts requests and Worker `fetch()`, used by pages and the preview |
| `cfl export` (+ `cfl` alias) | [export.md](export.md) | section 4.1; diff-clean fragments + manifest + asset manifest, `--check` for CI |
| Pattern conventions + aliases | [coming-from-mvc.md](coming-from-mvc.md), `cf-lite add patterns`, `--template patterns` | atomic folders optional, tsconfig `paths` mirrored into Vite |

Built after (P2, 2026-10-02, entry gate lifted): `g page|api|component|test` with `--dry-run`/`--json` and `seed`, see [generators.md](generators.md); `init`/`doctor --fix` landed with P1. NL layer (P3) built after that: tool surface, `cfl mcp`, `cfl ask`, consent notice, 67-prompt eval, see [llm.md](llm.md) (measured results: the first run missed the 5.6 gate, the dx3b follow-up passes it, see [llm-eval-notes.md](llm-eval-notes.md); `setup assist` not built; BYO provider key and optional AI Gateway routing built in dx3b, see [llm.md](llm.md#your-own-provider-key-and-ai-gateway-opt-in)). Still open: `add storybook|ladle`. `UiServer.bind` is a new optional adapter function (react, preact, vue implement it; Svelte does not).

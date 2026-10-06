# LLM layer: `cfl mcp` and `cfl ask`

Design and decisions: [roadmap-dx.md](roadmap-dx.md) section 5. Status: built 2026-10-02 (P3). The rule behind all of it: **the toolset covers every feature; a model is only a thin natural-language layer that picks from it.** No free-form code, no shell.

## One tool surface

Every capability is one typed tool with a JSON Schema (`packages/cf-lite/src/tools.ts`). The plain CLI, `cfl mcp` and `cfl ask` are three front doors to the same functions.

| Tool | Equivalent command | Writes? |
|---|---|---|
| `generate_page` `{name, render?, loader?, ui?}` | `cfl g page` | yes |
| `generate_api` `{name, mock?, seed?}` | `cfl g api` | yes |
| `generate_component` `{name, island?, folder?, dir?, ui?}` | `cfl g component` | yes |
| `generate_test` `{name, kind?}` | `cfl g test` | yes |
| `add` `{target, name?, binding?, schedule?}` | `cfl add <target>` (always `--no-install`) | yes |
| `seed` `{name?}` | `cfl seed` (**local only**) | yes (local data) |
| `doctor`, `analyze` | `cfl doctor`, `cfl analyze` | no |

Every tool also takes `dryRun` (preview: returns the files/diff, writes nothing). Results are `{ ok, tool, dryRun, lines, files?, notes?, error? }`.

**Not tools, on purpose:** `deploy`, `secrets push`, `seed --remote`, `db apply`, `init`, `upgrade`, `dev`, `build`, and `add` targets that install frameworks (`rsc`, UI adapters). Arguments are validated against the schema (strict: unknown properties and malformed names are rejected, never repaired); names cannot contain `..` or start with `/`, `dir` must stay under `app/`.

## Mode 1: your own agent, via `cfl mcp` (default, nothing leaves your machine from us)

`cfl mcp` is an MCP server over stdio inside the same CLI install (no extra package, no network, no key). Register it in your agent, for example Claude Code:

```sh
claude mcp add cf-lite -- bunx cf-lite mcp          # run from the app directory
```

or in any MCP client's JSON config: `{ "mcpServers": { "cf-lite": { "command": "npx", "args": ["cf-lite", "mcp"] } } }`. The server is scoped to the directory it starts in. It speaks `initialize`, `ping`, `tools/list` (schemas + read-only/idempotent hints) and `tools/call`; the agent's harness owns confirmation, and every tool has `dryRun`. `cfl add agents` / `cfl init` write the `AGENTS.md` / skill that tell the agent to use it.

## Mode 3: `cfl ask "<text>"` (fallback for developers without an agent)

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers AI Read + Edit, your own account
export CLOUDFLARE_ACCOUNT_ID=...  # or account_id in wrangler.jsonc
cfl ask "add a pricing page rendered on the server, and an items api with a mock"
cfl ask --dry-run "..."           # plan + diff only
cfl ask --yes "..."               # apply without the y/N prompt
cfl ask --terms                   # reprint the notice
```

Flow: your sentence + the tool schemas + the project's **file names** -> the model returns tool calls -> each call is checked against the allow-list and schema -> the **plan** (the equivalent manual commands) and the **dry-run diff of every step** are printed -> nothing is written until you answer `y` (or pass `--yes`). If any step fails its dry run, nothing is applied.

Failure behavior (tested in `test/llm.test.ts`):

* **Model unsure** (ambiguous or missing name): it should ask one clarifying question; the CLI prints it and stops.
* **A value you did not give** (name, d1/kv/r2/hyperdrive): the model's guess is dropped and the CLI asks the question itself; nothing is planned. Options you did not ask for are listed as left out.
* **Invalid or unknown call**: rejected with the reason, fed back **once**; after 2 attempts it stops, prints the closest manual command (`cfl g page about --dry-run`) and changes nothing. Never loops.
* **Backend unreachable, 401/403, rate limit or daily allocation reached**: says which, changes nothing, prints that no other provider was tried (a silent switch would change where your data goes).
* At most 5 calls per request. A refusal (shell, secrets, deploy, remote data, files outside the project) is the expected answer to such requests.

Model: default `@cf/qwen/qwen3-30b-a3b-fp8` (override `--model` or `CFL_ASK_MODEL`). It runs through the REST API on **your** account, so its usage is billed to you (Workers AI free allocation: 10,000 neurons/day, see Cloudflare's pricing page). Requests use temperature 0 and thinking off.

### Your own provider key and AI Gateway (opt-in)

Workers AI on your account stays the default. Two optional switches, both explicit:

```sh
# 1. a stronger model with YOUR key (read from the environment, never stored, never logged)
export ANTHROPIC_API_KEY=...            # or OPENAI_API_KEY; CFL_ASK_API_KEY overrides either
cfl ask --provider anthropic --model claude-sonnet-5-5 "..."     # or --provider openai; CFL_ASK_PROVIDER sets it persistently
# 2. route any of the above through your Cloudflare AI Gateway (logs, caching, rate limits)
export CLOUDFLARE_ACCOUNT_ID=...        # the gateway lives in this account
export CF_AIG_TOKEN=...                 # only if the gateway is authenticated (sent as cf-aig-authorization)
cfl ask --gateway my-gateway "..."      # or CFL_AI_GATEWAY; add --provider to combine
# an authenticated gateway returns 401 without CF_AIG_TOKEN (AI Gateway Run); tested for real, see llm-gateway-test.md
# a compatible endpoint instead of a gateway: --base-url https://host (or CFL_ASK_BASE_URL); not combinable with --gateway
```

Rules, all tested in `test/ask-provider.test.ts`: a key in the environment **never** changes where a request goes (only `--provider` / `CFL_ASK_PROVIDER` does, so an `ANTHROPIC_API_KEY` you exported for something else is not used); a failure is reported and **no other provider is tried**; the first use of each provider asks for consent again and the notice names the provider, where the key comes from and whether a gateway is in the path; `cfl ask` prints one line saying where the request is going; the key travels only in the provider's auth header, and an error body that echoes it is scrubbed. URLs: Workers AI `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/<model>`, OpenAI `.../<gateway>/openai/chat/completions`, Anthropic `.../<gateway>/anthropic/v1/messages` (Anthropic shape from Cloudflare's provider page; the Workers AI one is the older documented shape and the gateway layer accepts it, but no request has been sent through a real gateway of ours: **not verified end to end**). With a gateway the request still goes to the provider you chose; the gateway can log and cache it per its own settings, which is what the notice says.

Measured through this path: Claude Sonnet 5.5 (own key, `--provider anthropic`, an Anthropic-compatible endpoint as `--base-url`) passes the gate on its own, without the guard and grounding (142 prompts: easy+medium 67/70, hard 32/32, adversarial 40/40), but is not better than the default with them on and costs far more per call; see [llm-eval-notes.md](llm-eval-notes.md).

### What is sent, and consent

Sent: your sentence (token-like strings, keys and private-key blocks replaced by `[REDACTED]`), the tool descriptions, and a list of file **names** (max 150). **Never sent:** file contents, `.dev.vars*`, `.env*`, `.npmrc`, key/cert files (`*.pem`, `*.key`, ...), anything with `secret` in its path, `.git`, `node_modules`, `dist`, `.wrangler`, `.cf-lite`, `.claude`: not even their names. The token and account id come from the environment only and are never stored or put in the request body.

The first `cfl ask` prints the notice (what is sent, to which provider, the [Cloudflare data-usage terms](https://developers.cloudflare.com/workers-ai/platform/data-usage/), our [toolkit terms](llm-terms.md)) and asks `y/N`; `--accept-terms` answers it for CI. Consent is stored per user in `~/.config/cf-lite/consent.json` (`CFL_CONFIG_DIR` overrides) with the provider and terms version; a change of either asks again. **No consent = no model call.** `mcp` and every plain command never need it. We do not call anything "private" beyond what the provider's terms say.

## Evaluation (roadmap-dx 5.6)

`packages/cf-lite/test/nl-eval/prompts.json`: 67 prompts (25 easy, 16 medium, 12 hard/ambiguous, 14 adversarial) with expected tool calls; `prompts-holdout.json` (38) was written before tuning and `prompts-fresh.json` (37) once, after the code was final, as a check that the fixes are not fitted to the gate set. Scoring (`src/nl-eval.ts`): exact tool + schema-valid args; defaults are equal to omitted; names compare case-insensitively; order-insensitive. Hard and adversarial cases pass only if the model makes **no** call. Run it against your own account:

```sh
bun scripts/nl-eval.ts --offline                       # validate the prompt set only (also a unit test)
bun scripts/nl-eval.ts [--model @cf/...] [--category easy] [--limit 10] [--out result.json]
```

Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; one attempt per prompt (raw validity; the retry in `ask` can only help); exit code 2 when the gate fails. Re-run on any tool-schema, system-prompt or model change.

**Measured** (own account, temperature 0, single run each, so treat +-1 prompt as noise). Full error analysis, the fixes in order with the score after each step, and the model sweep: [llm-eval-notes.md](llm-eval-notes.md).

| Run | Easy | Medium | Hard (no call) | Adversarial (no call) | Gate |
|---|---|---|---|---|---|
| 2026-10-02, PR #60, default `@cf/qwen/qwen3-30b-a3b-fp8` | 22/25 | 15/16 | 9/12 | 13/14 | easy+medium 90.2% pass; hard and adversarial **fail** |
| 2026-10-02, PR #60, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 19/25 | 8/16 | 2/12 | 13/14 | fail |
| dx3b (descriptions, prompt, request guard, grounding), default model, 67-prompt gate set, 3 runs | 24/25 | 16/16 | 12/12 (11/12 once) | 14/14 | **PASS** (easy+medium 97.6%) |
| same code, all 142 prompts (gate set + 38 holdout + 37 fresh) | 41/43 | 26/27 | 32/32 | 40/40 | **PASS**, median 0.45 s, about $0.10 per 1,000 asks (estimate) |

What changed between the two rows: the misses were a required value the model guessed ("add a queue" -> a queue named `queue`), a real choice it resolved silently ("add a database" -> d1), a vague wish mapped to the nearest tool, and unrequested optional arguments (`ui:"react"`, `dir`, `binding`). Fixes, cheapest first: tool descriptions that say when **not** to call, a planner prompt written as refuse / ask / call, and then two deterministic checks that run outside the model (below). Few-shot examples were tried and made the held-out set worse, so they are not used.

Two deterministic checks (`ask.ts`), both on by default:

* **Request guard.** Shell commands, secrets/keys/env files, deploy/production/remote data, paths outside the project, delete/rename and account actions are refused before any model call, with a one-line reason.
* **Grounding.** A call is checked against the user's own words. A required value they never gave (a name, which of d1/kv/r2/hyperdrive, "called <name>" for a queue/cron/workflow/durable object) turns the request into one clarifying question and no plan. An optional option they did not ask for is **left out and listed** in the plan (`left out (not in your request): ui, render`). It only narrows what is applied; nothing the model said is rewritten or invented.

The model alone (checks off) does not pass the hard gate with the default model (hard 28/32) but does with Kimi K2.6 and Claude Sonnet 5.5; both checks stay on regardless. `bun scripts/nl-eval.ts --no-guard --no-ground` measures the model alone, `--set holdout|fresh|all` picks the set, `--attempts 2` is the real `cfl ask` flow (an invalid call fed back once).

Two behaviors found by running it, worth knowing: with thinking off, Qwen3 sometimes writes the call as `<tool_call>{json}</tool_call>` text instead of structured `tool_calls`; the parser accepts that and the same validation applies. And passing the detected UI adapter in the context made the model copy `ui: "react"` into every call, so the context is file names only.

## Open

Not built: `cfl setup assist` (assistant Worker with an AI binding, the dev-server "ask" box); a request through a real AI Gateway is verified for Workers AI models ([llm-gateway-test.md](llm-gateway-test.md)), not yet with a BYO provider key; the token path for a plain `wrangler login` session (an env token is required today). The toolkit terms text is a draft, not legal advice ([llm-terms.md](llm-terms.md)).

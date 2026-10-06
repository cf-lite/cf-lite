# `cfl ask` through Cloudflare AI Gateway: real test log (2026-10-03)

First run of the gateway route (`--gateway` / `CFL_AI_GATEWAY`, PR #66) against a real, authenticated AI Gateway. Synthetic fixtures only (the eval prompt set and an empty scratch app). Secrets came from the environment; no value was printed. Model: default `@cf/qwen/qwen3-30b-a3b-fp8` (Workers AI route through the gateway).

## Steps followed (the guide in [llm.md](llm.md#your-own-provider-key-and-ai-gateway-opt-in))

```sh
export CLOUDFLARE_ACCOUNT_ID=<account>   CLOUDFLARE_API_TOKEN=<Workers AI Read + Edit>
export CF_AIG_TOKEN=<AI Gateway Run>     # the gateway is authenticated
bun scripts/nl-eval.ts --gateway <id> --category easy,medium --attempts 2    # the real `cfl ask` flow, 41 prompts
cfl ask --yes --gateway <id> "add an about page rendered on the server"      # end to end, scratch app with a UI adapter
```

## Result

| Step | Result |
|---|---|
| Which token has gateway scope (Cloudflare API, status only) | the Workers AI token lists gateways (200); the second token (AI Gateway Run) gets 403 there, as expected for a Run-only token |
| Gateway route with the Workers AI token only | **401 "Authentication error"**: an authenticated gateway wants a separate AI Gateway Run token in `cf-aig-authorization` |
| Same route + `CF_AIG_TOKEN` | 200, tool calls returned |
| Eval, easy+medium via the gateway | **40/41** (easy 24/25, medium 16/16), validity 100%, median 616 ms, gate PASS. The miss: "a blog index page" -> `name: index` instead of `blog` (the same label-dispute class as in [llm-eval-notes.md](llm-eval-notes.md)) |
| Gateway logs (count only, `GET .../ai-gateway/gateways/<id>/logs?start_date=...`) | **44** entries for the run = 3 probe prompts + 41 eval prompts: every request is logged |
| `cfl ask --yes` end to end | plan printed, `app/routes/about.tsx` written, exit 0 |

## Bug found and fixed

* With the gateway on and `CF_AIG_TOKEN` missing, the 401 said "Workers AI rejected the token (needs Workers AI Read + Edit)", which sends the user to the wrong permission. It now says an authenticated gateway needs `CF_AIG_TOKEN` (AI Gateway Run), whether one is set, and, for Workers AI, that the other token needs Workers AI Read + Edit. Unit test in `test/llm.test.ts`; checked again against the real gateway.
* `scripts/nl-eval.ts --category` now takes a comma list (`easy,medium`).

## Not tested

BYO provider keys through the gateway (`--provider openai|anthropic`): no provider key was available in this run; covered by `test/ask-provider.test.ts` mocks only.

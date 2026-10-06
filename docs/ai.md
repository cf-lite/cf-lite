# AI: Workers AI, AI Gateway, Vectorize (`cf-lite/modules/ai`, `cf-lite/modules/vectors`) - EXPERIMENTAL

Optional modules, bundled only when imported. Nothing is added to an app that does not use them. **Experimental at 1.0**: the API may change in a minor release.
Numbers marked *(verify)* come from Cloudflare docs as understood at writing time and were not measured against a live account (no account was used).

```
cf-lite add ai-chat      # server/api/chat.ts (streaming route) + app/chat-client.ts + "ai" binding in wrangler.jsonc
```

Live example: `examples/site-ai` (chat + a RAG sketch at `/api/search`).

## Workers AI, typed and gateway-routed

```ts
import { createAI } from "cf-lite/modules/ai";
const ai = createAI(env, { userId: session.userId, cacheTtl: 300, metadata: { app: "docs" } });
const text = await ai.text("@cf/meta/llama-3.1-8b-instruct", [{ role: "user", content: "hi" }]);
const raw  = await ai.run<{ response: string }>(model, { prompt: "..." }, { skipCache: true });   // per-call override
```

`env.AI` is the `Ai` binding (`"ai": { "binding": "AI" }`). **Workers AI has no local simulator**: in `wrangler dev` calls go to Cloudflare, need `wrangler login`, and bill per use.
Unit-test against a fake binding (`{ run }`) - every test in `test/ai.test.ts` does.

### AI Gateway (default when `AI_GATEWAY_ID` is set)

With the `AI_GATEWAY_ID` var present, `ai.run/text/stream/json/embed` pass `{ gateway: { id, ... } }` to the binding, so requests get caching, rate limiting, logs and fallbacks from the gateway.
Without it the binding is called directly. Options (same meaning for the binding and for `gatewayFetch` headers):

| option | binding key | header | note |
|---|---|---|---|
| `cacheTtl` | `cacheTtl` | `cf-aig-cache-ttl` | seconds; gateway minimum 60 *(verify)* |
| `skipCache` | `skipCache` | `cf-aig-skip-cache` | |
| `cacheKey` / `userId` | `cacheKey` | `cf-aig-cache-key` | `userId` derives `u:<id>:<sha256(model+input)>` - users never share cache entries |
| `metadata` | `metadata` | `cf-aig-metadata` | <= 5 primitive entries (validated) |
| `collectLog`, `eventId`, `requestTimeoutMs`, `retries` | same | `cf-aig-collect-log`, `-event-id`, `-request-timeout`, `-max-attempts`, `-retry-delay`, `-backoff` | |

**Always set `userId` (or a `cacheKey`) when prompts contain user data**, or a gateway cache hit can serve one user's answer to another whose prompt is identical. Streaming responses are not cached by the gateway *(verify)*.

OpenAI-compatible and other providers: `gatewayFetch(env, "openai", "chat/completions", { method: "POST", headers: { authorization: "Bearer sk-..." }, body }, { cacheTtl: 60 })`
rewrites to `https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/<AI_GATEWAY_ID>/openai/chat/completions` and adds the typed `cf-aig-*` headers (`CF_AIG_TOKEN` -> `cf-aig-authorization` for authenticated gateways).
Provider keys: put them in the gateway (BYOK) or pass your own header; never in client code.

## Streaming (SSE)

```ts
// server: model stream -> normalised SSE
const stream = await ai.stream(model, messages);          // input.stream = true; ReadableStream of SSE bytes
return sseResponse(stream);                                // data: {"text":"..."}  ...  event: done
// client (any framework):
await readChatStream(await fetch("/api/chat", { method: "POST", body }), { onText: (delta, full) => render(full) });
```

`sseResponse` normalises Workers AI (`{"response"}`) and OpenAI-style (`choices[].delta.content`) chunks, sends `cache-control: no-store, no-transform`, turns a mid-stream failure into `event: error` with a generic message
(provider detail is never forwarded) and cancels the upstream read when the client disconnects. `parseSSE`, `tokens` and `deltaText` are exported for custom handling; the parser copes with arbitrary chunk splits, CRLF (even split across chunks) and multi-byte characters split across chunks.
A `useChat`-style hook per adapter is deliberately not shipped: `readChatStream` + your framework's state is ~10 lines (`templates/ai-chat/app/chat-client.ts` shows the vanilla version).

## Structured output

```ts
const Schema = { parse: (v) => z.object({ title: z.string(), tags: z.array(z.string()) }).parse(v), jsonSchema: zodToJsonSchema(...) };  // `jsonSchema` optional
const out = await ai.json(model, "Summarise ...", Schema, { retries: 1 });
```

Validates with `schema.parse` (zod/valibot/any `.parse`), accepts raw JSON, fenced JSON or JSON embedded in prose, and on failure feeds the validation error back to the model and retries; still invalid -> `AiError("invalid-output")`. `jsonSchema` is sent as `response_format` for models that support JSON mode *(verify per model)*.

## Embeddings, chunking, Vectorize

```ts
import { chunkText } from "cf-lite/modules/ai";
import { vectors } from "cf-lite/modules/vectors";
const docs = vectors(env.VECTORS, { ai: env, namespace: "docs" });
await docs.upsertTexts(chunkText(text, { size: 800, overlap: 80 }).map((c) => ({ id: `page:${c.index}`, text: c.text, metadata: { start: c.start } })));
const hits = await docs.queryText("how do I deploy?", { topK: 5, returnMetadata: "all" });
```

* `ai.embed(texts, { model, batchSize })` - default `@cf/baai/bge-base-en-v1.5` (768 dims), 100 texts per call *(verify per model)*, order preserved, a wrong vector count is an error. Your index dimension must match the model.
* `chunkText` - recursive split (paragraph, line, sentence, word, hard cut), every chunk an exact slice of the input (`start`/`end` for citations), bounded by `size`, `overlap` characters repeated.
* `vectors(index)` - `upsert` (batches of 1000, validates *everything* before the first write: id <= 64 bytes, equal dimensions, no duplicate ids, metadata <= 10 KiB *(verify all four)*), `query` (`topK` 1-100 *(verify; lower when returning values/metadata)*), `upsertTexts`/`queryText`, `deleteByIds` (1000 per call), `getByIds` (20 per call *(verify)*).
  Vectorize writes are **asynchronous**: a just-upserted vector may not be queryable for a few seconds; upsert returns `mutationIds`.
* Metadata filters must be declared with `wrangler vectorize create-metadata-index` **before** vectors are inserted. Vectorize is remote-only in dev too *(verify for current wrangler)*.

### AI Search (AutoRAG) *(verify GA)*

`ai.search("my-index", { query, max_num_results: 5 })` calls `env.AI.autorag(name).aiSearch(...)` (generated answer + sources); `{ answer: false }` calls `.search(...)` (retrieval only). Thin wrapper; its product surface is still moving.

## Testing

* Unit: `test/ai.test.ts` (fake `run`, fake Vectorize index): gateway options/headers, per-user cache keys, SSE parsing/roundtrip/errors/cancel, JSON retry, embed batching, chunk invariants, Vectorize batching and validation, `add ai-chat` idempotence.
* workerd: `scripts/ai-e2e.mjs` scaffolds an app, runs `cf-lite add ai-chat`, swaps in a fake binding and drives `/api/chat` under local workerd: incremental delivery (first token far before the last), gateway id reaching the binding, backpressure after client abort, 400/403/415 refusals.
  The `wrangler dev` proxy does not forward a client disconnect as `cancel()`; the cancel path itself is covered in the unit test.
* **Real-model nightly smoke (not run here - needs the owner)**: a scratch account with Workers AI + a gateway enabled and a small monthly budget; a scheduled CI job would call `ai.text`, `ai.stream`, `ai.embed` and a Vectorize upsert/query round trip against `@cf/meta/llama-3.1-8b-instruct` / bge-base. Stubbed: not enabled, no credentials created.

## Cost and safety notes

* The chat template has no auth or rate limit. Before exposing it put `session()` and a rate limiter in front (per-user/IP), and cap `max_tokens`; an open model endpoint is a billing hole. Input is capped at 20 messages x 4000 chars.
* Prompts/outputs appear in gateway logs unless `collectLog: false`.
* Never interpolate untrusted text into the system prompt; treat model output as untrusted (escape on render - the template uses `textContent`).

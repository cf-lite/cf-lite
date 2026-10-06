/**
 * OPTIONAL module (EXPERIMENTAL at 1.0; only bundled when imported): Workers AI + AI Gateway + SSE streaming + structured output.
 *
 *   import { createAI, sseResponse } from "cf-lite/modules/ai";
 *   const ai = createAI(env, { userId });                       // routes through AI Gateway when env.AI_GATEWAY_ID is set
 *   const out = await ai.text("@cf/meta/llama-3.1-8b-instruct", [{ role: "user", content: "hi" }]);
 *   return sseResponse(await ai.stream(model, messages));        // SSE: `data: {"text":"..."}` ... `event: done`
 *
 * Nothing here imports `cloudflare:workers`; the `AI` binding is taken from `env` so the module is testable with a fake
 * binding. Env: AI (Ai binding), AI_GATEWAY_ID, CF_ACCOUNT_ID + CF_AIG_TOKEN (only for `gatewayFetch` to third-party providers).
 * Details, limits and the list of "(verify)" items: docs/ai.md.
 */

export type Role = "system" | "user" | "assistant" | "tool";
export interface ChatMessage { role: Role; content: string }

/** The slice of the Workers AI binding this module uses (real `Ai` is assignable; so is a test fake). */
export interface AiBinding {
  run(model: string, input: unknown, options?: { gateway?: GatewayBindingOptions; [k: string]: unknown }): Promise<unknown>;
  autorag?(name: string): { search(p: AiSearchParams): Promise<unknown>; aiSearch(p: AiSearchParams): Promise<unknown> };
}
export interface AiEnv {
  AI?: AiBinding;
  /** AI Gateway id. When set, every `ai.run` and `gatewayFetch` goes through the gateway. */
  AI_GATEWAY_ID?: string;
  /** Account id, needed only for the public gateway URL used by `gatewayFetch`. */
  CF_ACCOUNT_ID?: string;
  /** Gateway auth token (authenticated gateways): sent as `cf-aig-authorization`. */
  CF_AIG_TOKEN?: string;
}

/* ---------------------------------------------------------------- AI Gateway */

export interface GatewayRetries { maxAttempts?: 1 | 2 | 3 | 4 | 5; retryDelayMs?: number; backoff?: "constant" | "linear" | "exponential" }
/** Options of the `gateway` key accepted by `env.AI.run(model, input, { gateway })`. */
export interface GatewayBindingOptions {
  id: string;
  cacheKey?: string;
  cacheTtl?: number;
  skipCache?: boolean;
  metadata?: Record<string, string | number | boolean>;
  collectLog?: boolean;
  eventId?: string;
  requestTimeoutMs?: number;
  retries?: GatewayRetries;
}
/** Everything you can ask of the gateway for one call (same meaning for `ai.run` and `gatewayFetch`). */
export interface GatewayOptions {
  /** Seconds a cached response may be served (`cf-aig-cache-ttl`; gateway minimum 60 *(verify)*). */
  cacheTtl?: number;
  /** Bypass the gateway cache for this call (`cf-aig-skip-cache`). */
  skipCache?: boolean;
  /** Explicit cache key (`cf-aig-cache-key`). Prefer `userId`, which derives one per user + input. */
  cacheKey?: string;
  /** Per-user cache isolation: the cache key becomes `u:<userId>:<sha256(model+input)>` so users never share entries. */
  userId?: string;
  /** Up to 5 key/value pairs shown in gateway logs (`cf-aig-metadata`). Values are primitives. */
  metadata?: Record<string, string | number | boolean>;
  collectLog?: boolean;
  eventId?: string;
  requestTimeoutMs?: number;
  retries?: GatewayRetries;
  /** Override the env's gateway id for this call. */
  gatewayId?: string;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Per-user, content-addressed cache key: same user + same model + same input -> same key; other users never collide. */
export async function cacheKeyFor(userId: string, model: string, input: unknown): Promise<string> {
  if (!userId) throw new Error("cacheKeyFor: userId is required");
  const digest = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${model}\n${stable(input)}`)));
  return `u:${userId}:${digest}`;
}

function checkMetadata(m: GatewayOptions["metadata"]) {
  if (!m) return;
  const keys = Object.keys(m);
  if (keys.length > 5) throw new Error(`AI Gateway metadata allows at most 5 entries (got ${keys.length})`);
  for (const k of keys) if (!["string", "number", "boolean"].includes(typeof m[k])) throw new Error(`AI Gateway metadata "${k}" must be a string, number or boolean`);
}

/** Typed `cf-aig-*` request headers for a gateway call (used by `gatewayFetch`; the binding takes the same options as an object). */
export function gatewayHeaders(o: GatewayOptions = {}, token?: string): Record<string, string> {
  checkMetadata(o.metadata);
  const h: Record<string, string> = {};
  if (token) h["cf-aig-authorization"] = `Bearer ${token}`;
  if (o.cacheTtl !== undefined) {
    if (!Number.isFinite(o.cacheTtl) || o.cacheTtl < 0) throw new Error("cacheTtl must be a non-negative number of seconds");
    h["cf-aig-cache-ttl"] = String(Math.floor(o.cacheTtl));
  }
  if (o.skipCache) h["cf-aig-skip-cache"] = "true";
  if (o.cacheKey) h["cf-aig-cache-key"] = o.cacheKey;
  if (o.metadata) h["cf-aig-metadata"] = JSON.stringify(o.metadata);
  if (o.collectLog !== undefined) h["cf-aig-collect-log"] = String(o.collectLog);
  if (o.eventId) h["cf-aig-event-id"] = o.eventId;
  if (o.requestTimeoutMs !== undefined) h["cf-aig-request-timeout"] = String(o.requestTimeoutMs);
  if (o.retries?.maxAttempts) h["cf-aig-max-attempts"] = String(o.retries.maxAttempts);
  if (o.retries?.retryDelayMs !== undefined) h["cf-aig-retry-delay"] = String(o.retries.retryDelayMs);
  if (o.retries?.backoff) h["cf-aig-backoff"] = o.retries.backoff;
  return h;
}

/** Gateway provider segment for `gatewayFetch` (`openai`, `anthropic`, `workers-ai`, ...; any string accepted). */
export type GatewayProvider = "openai" | "anthropic" | "google-ai-studio" | "groq" | "mistral" | "workers-ai" | "azure-openai" | "deepseek" | "perplexity-ai" | (string & {});

/** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/<path>` */
export function gatewayUrl(env: Pick<AiEnv, "CF_ACCOUNT_ID" | "AI_GATEWAY_ID">, provider: GatewayProvider, path = "", gatewayId?: string): string {
  const gw = gatewayId ?? env.AI_GATEWAY_ID;
  if (!env.CF_ACCOUNT_ID || !gw) throw new Error("gatewayFetch needs CF_ACCOUNT_ID and AI_GATEWAY_ID");
  if (!/^[\w-]+$/.test(gw) || !/^[\w-]+$/.test(env.CF_ACCOUNT_ID)) throw new Error("invalid gateway or account id");
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gw}/${provider}/${path.replace(/^\/+/, "")}`;
}

/**
 * `fetch` through AI Gateway for any provider with an OpenAI-compatible (or native) HTTP API: rewrites the URL to the gateway and
 * adds the typed `cf-aig-*` headers. Provider credentials stay in the `Authorization`/`x-api-key` header you pass in `init`.
 */
export async function gatewayFetch(env: AiEnv, provider: GatewayProvider, path: string, init: RequestInit = {}, o: GatewayOptions = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(gatewayHeaders(o, env.CF_AIG_TOKEN))) headers.set(k, v);
  return fetchImpl(gatewayUrl(env, provider, path, o.gatewayId), { ...init, headers });
}

/* ---------------------------------------------------------------- text generation types */

export interface TextGenInput {
  messages?: ChatMessage[];
  prompt?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  seed?: number;
  response_format?: { type: "json_schema"; json_schema: unknown } | { type: "json_object" };
  [k: string]: unknown;
}
export interface TextGenOutput { response?: string | object | null; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; [k: string]: unknown }

/** Anything with `.parse()` (zod, valibot wrapper, ...). `jsonSchema` (optional) is sent to the model as the response schema. */
export interface JsonSchemaLike<T = unknown> { parse(input: unknown): T; _output?: T; jsonSchema?: unknown }
export type SchemaOut<S> = S extends { parse(input: unknown): infer T } ? T : unknown;

export class AiError extends Error {
  constructor(public code: "no-binding" | "invalid-output" | "bad-input" | "embed-shape", message: string, public cause2?: unknown) { super(message); this.name = "AiError"; }
}

/* ---------------------------------------------------------------- SSE */

export interface SseEvent { event?: string; data: string }

/** Parse a `text/event-stream` body (any chunking, LF/CRLF, multi-line data, comments ignored) into events. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      raw += dec.decode(value, { stream: !done });
      if (done) raw += "\n\n"; // flush a last event that lacks the blank line
      // a trailing CR may be half of a CRLF split across chunks: hold it back until the next chunk
      const hold = !done && raw.endsWith("\r") ? 1 : 0;
      buf += raw.slice(0, raw.length - hold).replace(/\r\n?/g, "\n");
      raw = raw.slice(raw.length - hold);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let event: string | undefined; const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":") || !line) continue;
          const c = line.indexOf(":");
          const field = c < 0 ? line : line.slice(0, c);
          const val = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
          if (field === "event") event = val; else if (field === "data") data.push(val);
        }
        if (data.length || event) yield { event, data: data.join("\n") };
      }
      if (done) return;
    }
  } finally { try { await reader.cancel(); } catch { /* already closed */ } }
}

/** Text carried by one model SSE payload: Workers AI `{response}`, OpenAI-style `choices[0].delta.content`, or our own `{text}`. "" when none. */
export function deltaText(payload: unknown): string {
  const p = payload as any;
  if (!p || typeof p !== "object") return "";
  if (typeof p.response === "string") return p.response;
  if (typeof p.text === "string") return p.text;
  const c = p.choices?.[0]?.delta?.content ?? p.choices?.[0]?.text;
  return typeof c === "string" ? c : "";
}

/** Model SSE stream (Workers AI / OpenAI-compatible, ends at `data: [DONE]`) -> text tokens. */
export async function* tokens(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const ev of parseSSE(stream)) {
    if (ev.data === "[DONE]") return;
    let p: unknown; try { p = JSON.parse(ev.data); } catch { continue; } // keep-alives / non-JSON lines
    const t = deltaText(p);
    if (t) yield t;
  }
}

const enc = new TextEncoder();
const frame = (data: unknown, event?: string) => enc.encode(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);

export const SSE_HEADERS = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } as const;

/**
 * Streaming `Response` for a chat endpoint. `source` is a model stream (bytes of SSE) or an async iterable of strings.
 * Wire format (what `readChatStream` parses): `data: {"text":"<delta>"}` per chunk, then `event: done`. A mid-stream failure
 * becomes `event: error` with a generic message (no provider detail); client disconnect cancels the upstream read.
 */
export function sseResponse(source: ReadableStream<Uint8Array> | AsyncIterable<string>, init: { headers?: HeadersInit; status?: number } = {}): Response {
  const it = (source instanceof ReadableStream ? tokens(source) : source)[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await it.next();
        if (done) { ctrl.enqueue(frame({}, "done")); ctrl.close(); }
        else ctrl.enqueue(frame({ text: value }));
      } catch {
        ctrl.enqueue(frame({ error: "stream failed" }, "error")); ctrl.close();
      }
    },
    async cancel() { try { await it.return?.(); } catch { /* ignore */ } },
  });
  const headers = new Headers(SSE_HEADERS); for (const [k, v] of new Headers(init.headers)) headers.set(k, v);
  return new Response(body, { status: init.status ?? 200, headers });
}

export interface ChatStreamHandlers { onText?(delta: string, full: string): void; onDone?(full: string): void; onError?(message: string): void }
/**
 * Browser/Worker client for `sseResponse`: reads a fetch `Response`, calls `onText` per delta, resolves with the full text.
 * Framework-agnostic; wrap it in your UI's state (a hook is 10 lines: `useState` + this). Abort via the fetch's `signal`.
 */
export async function readChatStream(res: Response, h: ChatStreamHandlers = {}): Promise<string> {
  if (!res.ok || !res.body) throw new AiError("bad-input", `chat request failed: ${res.status}`);
  let full = "";
  for await (const ev of parseSSE(res.body)) {
    if (ev.event === "done") { h.onDone?.(full); return full; }
    let p: any; try { p = JSON.parse(ev.data); } catch { continue; }
    if (ev.event === "error") { h.onError?.(String(p?.error ?? "error")); throw new AiError("invalid-output", String(p?.error ?? "stream error")); }
    const t = deltaText(p);
    if (t) { full += t; h.onText?.(t, full); }
  }
  h.onDone?.(full);
  return full;
}

/* ---------------------------------------------------------------- structured output */

/** Pull a JSON value out of model text: raw JSON, or inside a ```json fence, or the first balanced {...}/[...] span. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* fall through */ } }
  const start = t.search(/[{[]/);
  if (start >= 0) {
    const open = t[start], close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (ch === "\\") i++; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === open) depth++; else if (ch === close && --depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } }
    }
  }
  throw new AiError("invalid-output", "model output contains no valid JSON");
}

/* ---------------------------------------------------------------- embeddings + chunking */

export const DEFAULT_EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export interface EmbedOptions { model?: string; /** Texts per model call. Default 100 *(verify per model)*. */ batchSize?: number; gateway?: GatewayOptions }

export interface Chunk { text: string; index: number; start: number; end: number }
export interface ChunkOptions { /** Max characters per chunk. Default 1000. */ size?: number; /** Characters repeated at the start of the next chunk. Default 100. */ overlap?: number; /** Split preference, strongest first. */ separators?: string[] }

/**
 * Split text into overlapping chunks of at most `size` characters, preferring paragraph, line, sentence then word boundaries.
 * Every chunk is an exact slice of the input (`text.slice(start, end)`), so offsets can be used for citations.
 */
export function chunkText(text: string, { size = 1000, overlap = 100, separators = ["\n\n", "\n", ". ", " "] }: ChunkOptions = {}): Chunk[] {
  if (!(size > 0) || !Number.isInteger(size)) throw new AiError("bad-input", "chunkText: size must be a positive integer");
  if (overlap < 0 || overlap >= size) throw new AiError("bad-input", "chunkText: overlap must be >= 0 and < size");
  // 1. atomic pieces <= size: split on the strongest separator present, keep the separator with the piece before it
  const pieces: [number, number][] = [];
  const split = (s: number, e: number, level: number) => {
    if (e - s <= size) { if (e > s) pieces.push([s, e]); return; }
    const sep = separators[level];
    if (sep === undefined) { for (let i = s; i < e; i += size) pieces.push([i, Math.min(e, i + size)]); return; }
    let from = s;
    for (let i = text.indexOf(sep, s); i >= 0 && i + sep.length <= e; i = text.indexOf(sep, from)) {
      const cut = i + sep.length;
      split(from, cut, level + 1); from = cut;
    }
    split(from, e, level + 1);
  };
  split(0, text.length, 0);
  // 2. merge greedily; the next chunk restarts at the earliest piece within `overlap` of the previous end (always progressing)
  const out: Chunk[] = [];
  let i = 0;
  while (i < pieces.length) {
    let j = i;
    while (j + 1 < pieces.length && pieces[j + 1][1] - pieces[i][0] <= size) j++;
    const start = pieces[i][0], end = pieces[j][1];
    if (text.slice(start, end).trim()) out.push({ text: text.slice(start, end), index: out.length, start, end });
    if (j + 1 >= pieces.length) break;
    let k = j + 1;
    while (k - 1 > i && pieces[k - 1][0] >= end - overlap) k--;
    i = Math.max(k, i + 1);
  }
  return out;
}

/* ---------------------------------------------------------------- createAI */

export interface AiOptions extends GatewayOptions {
  /** Retries of `json()` when validation fails (the error is fed back to the model). Default 1. */
  jsonRetries?: number;
}
export interface AI {
  /** Raw `env.AI.run` with gateway routing. With `input.stream: true` the result is a `ReadableStream` of SSE bytes. */
  run<T = unknown>(model: string, input: unknown, o?: GatewayOptions): Promise<T>;
  /** Non-streaming text generation: returns the model's text. */
  text(model: string, input: ChatMessage[] | string | TextGenInput, o?: GatewayOptions): Promise<string>;
  /** Streaming text generation: the SSE byte stream (pass to `sseResponse`, or iterate with `tokens`). */
  stream(model: string, input: ChatMessage[] | string | TextGenInput, o?: GatewayOptions): Promise<ReadableStream<Uint8Array>>;
  /** Structured output: validates with `schema.parse`, retries with the error fed back, throws `AiError("invalid-output")`. */
  json<S extends JsonSchemaLike<any>>(model: string, input: ChatMessage[] | string | TextGenInput, schema: S, o?: GatewayOptions & { retries?: number }): Promise<SchemaOut<S>>;
  embed(texts: string[], o?: EmbedOptions): Promise<number[][]>;
  /** Same gateway routing, for AI Search (AutoRAG): `env.AI.autorag(name)`. *(verify GA)* */
  search(name: string, params: AiSearchParams, o?: { answer?: boolean }): Promise<unknown>;
}
export interface AiSearchParams { query: string; model?: string; rewrite_query?: boolean; max_num_results?: number; ranking_options?: { score_threshold?: number }; filters?: unknown; stream?: boolean }

const asInput = (i: ChatMessage[] | string | TextGenInput): TextGenInput => (typeof i === "string" ? { prompt: i } : Array.isArray(i) ? { messages: i } : i);

export function createAI(env: AiEnv, defaults: AiOptions = {}): AI {
  const binding = () => { if (!env.AI) throw new AiError("no-binding", 'Workers AI binding missing: add  "ai": { "binding": "AI" }  to wrangler.jsonc'); return env.AI; };
  async function gateway(model: string, input: unknown, o: GatewayOptions): Promise<GatewayBindingOptions | undefined> {
    const id = o.gatewayId ?? defaults.gatewayId ?? env.AI_GATEWAY_ID;
    if (!id) return undefined;
    const m = { ...defaults, ...o };
    checkMetadata(m.metadata);
    const g: GatewayBindingOptions = { id };
    const key = m.cacheKey ?? (m.userId ? await cacheKeyFor(m.userId, model, input) : undefined);
    if (key) g.cacheKey = key;
    for (const k of ["cacheTtl", "skipCache", "metadata", "collectLog", "eventId", "requestTimeoutMs", "retries"] as const) if (m[k] !== undefined) (g as any)[k] = m[k];
    return g;
  }
  const run = async <T>(model: string, input: unknown, o: GatewayOptions = {}): Promise<T> => {
    const g = await gateway(model, input, o);
    return (await binding().run(model, input, g ? { gateway: g } : undefined)) as T;
  };
  const textOf = (out: unknown): string => {
    const r = (out as TextGenOutput | string | null)
    const v = typeof r === "string" ? r : r?.response;
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return JSON.stringify(v); // json mode: binding may return the parsed object
    throw new AiError("invalid-output", "model returned no text");
  };
  const self: AI = {
    run,
    text: async (model, input, o) => textOf(await run(model, { ...asInput(input), stream: false }, o)),
    stream: async (model, input, o) => {
      const out = await run<unknown>(model, { ...asInput(input), stream: true }, o);
      if (!(out instanceof ReadableStream)) throw new AiError("invalid-output", "model did not return a stream (does it support stream: true?)");
      return out as ReadableStream<Uint8Array>;
    },
    json: async (model, input, schema, o = {}) => {
      const base = asInput(input);
      const retries = o.retries ?? defaults.jsonRetries ?? 1;
      const messages = [...(base.messages ?? (base.prompt ? [{ role: "user" as const, content: base.prompt }] : []))];
      const hint = schema.jsonSchema ? { response_format: { type: "json_schema" as const, json_schema: schema.jsonSchema } } : {};
      let last: unknown;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const { prompt: _p, ...rest } = base;
        const out = await run(model, { ...rest, ...hint, messages, stream: false }, o);
        let raw = "";
        try {
          const r = (out as TextGenOutput).response;
          const value = r && typeof r === "object" ? r : extractJson((raw = textOf(out)));
          return schema.parse(value) as SchemaOut<typeof schema>;
        } catch (e) {
          last = e;
          messages.push({ role: "assistant", content: raw || "(invalid)" }, { role: "user", content: `That was not valid: ${e instanceof Error ? e.message : "schema mismatch"}. Reply with ONLY corrected JSON.` });
        }
      }
      throw new AiError("invalid-output", `model output failed validation after ${retries + 1} attempt(s)`, last);
    },
    embed: async (texts, o = {}) => {
      const model = o.model ?? DEFAULT_EMBED_MODEL;
      const size = o.batchSize ?? 100;
      if (!(size > 0)) throw new AiError("bad-input", "batchSize must be > 0");
      const all: number[][] = [];
      for (let i = 0; i < texts.length; i += size) {
        const batch = texts.slice(i, i + size);
        const out = await run<{ data?: number[][] }>(model, { text: batch }, o.gateway);
        if (!Array.isArray(out?.data) || out.data.length !== batch.length) throw new AiError("embed-shape", `embedding model returned ${out?.data?.length ?? "no"} vectors for ${batch.length} texts`);
        all.push(...out.data);
      }
      return all;
    },
    search: async (name, params, o = {}) => {
      const r = binding().autorag?.(name);
      if (!r) throw new AiError("no-binding", "AI Search (autorag) is not available on this AI binding");
      return o.answer === false ? r.search(params) : r.aiSearch(params);
    },
  };
  return self;
}

/** Standalone `embed` for code that has only the binding (`embed(env, ["a", "b"])`). */
export const embed = (env: AiEnv, texts: string[], o?: EmbedOptions) => createAI(env).embed(texts, o);

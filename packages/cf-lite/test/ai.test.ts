import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AiError, cacheKeyFor, chunkText, createAI, extractJson, gatewayFetch, gatewayHeaders, gatewayUrl, parseSSE, readChatStream, sseResponse, tokens,
  type AiBinding,
} from "../src/modules/ai.js";
import { LIMITS, vectors, VectorsError, type VectorizeLike } from "../src/modules/vectors.js";
import { addAiChat, patchWranglerAi } from "../src/add-ai.js";

const enc = new TextEncoder();
const sseStream = (chunks: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); } });
const workersAiSse = (words: string[]) => [...words.map((w) => `data: ${JSON.stringify({ response: w })}\n\n`), "data: [DONE]\n\n"];
const fakeAi = (impl: (model: string, input: any, opts: any) => unknown) => {
  const run = vi.fn(async (m: string, i: unknown, o?: unknown) => impl(m, i, o));
  return { binding: { run } as unknown as AiBinding, run };
};

describe("gateway", () => {
  it("typed cf-aig-* headers", () => {
    expect(gatewayHeaders({ cacheTtl: 120.7, skipCache: true, cacheKey: "k", metadata: { user: "u1", n: 2 }, collectLog: false, eventId: "e", requestTimeoutMs: 5000, retries: { maxAttempts: 3, retryDelayMs: 100, backoff: "exponential" } }, "tok")).toEqual({
      "cf-aig-authorization": "Bearer tok", "cf-aig-cache-ttl": "120", "cf-aig-skip-cache": "true", "cf-aig-cache-key": "k", "cf-aig-metadata": '{"user":"u1","n":2}',
      "cf-aig-collect-log": "false", "cf-aig-event-id": "e", "cf-aig-request-timeout": "5000", "cf-aig-max-attempts": "3", "cf-aig-retry-delay": "100", "cf-aig-backoff": "exponential",
    });
    expect(gatewayHeaders()).toEqual({});
  });
  it("rejects bad metadata / ttl", () => {
    expect(() => gatewayHeaders({ metadata: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 } })).toThrow(/at most 5/);
    expect(() => gatewayHeaders({ metadata: { a: {} as never } })).toThrow(/primitive|string, number/);
    expect(() => gatewayHeaders({ cacheTtl: -1 })).toThrow();
  });
  it("gatewayUrl + gatewayFetch rewrite to the gateway and add headers", async () => {
    const env = { CF_ACCOUNT_ID: "acc1", AI_GATEWAY_ID: "gw-1", CF_AIG_TOKEN: "t" };
    expect(gatewayUrl(env, "openai", "/chat/completions")).toBe("https://gateway.ai.cloudflare.com/v1/acc1/gw-1/openai/chat/completions");
    expect(() => gatewayUrl({ AI_GATEWAY_ID: "x" }, "openai")).toThrow(/CF_ACCOUNT_ID/);
    expect(() => gatewayUrl({ CF_ACCOUNT_ID: "a", AI_GATEWAY_ID: "x/../y" }, "openai")).toThrow(/invalid/);
    const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("ok"));
    await gatewayFetch(env, "openai", "chat/completions", { method: "POST", headers: { authorization: "Bearer sk" } }, { cacheTtl: 60 }, f as never);
    const [url, init] = f.mock.calls[0];
    expect(url).toContain("/openai/chat/completions");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer sk"); expect(h.get("cf-aig-cache-ttl")).toBe("60"); expect(h.get("cf-aig-authorization")).toBe("Bearer t");
  });
  it("per-user cache keys: stable, input-sensitive, user-isolated", async () => {
    const a = await cacheKeyFor("u1", "m", { b: 1, a: 2 });
    expect(a).toBe(await cacheKeyFor("u1", "m", { a: 2, b: 1 })); // key order irrelevant
    expect(a).not.toBe(await cacheKeyFor("u2", "m", { a: 2, b: 1 }));
    expect(a).not.toBe(await cacheKeyFor("u1", "m", { a: 3, b: 1 }));
    expect(a).toMatch(/^u:u1:[0-9a-f]{64}$/);
    await expect(cacheKeyFor("", "m", {})).rejects.toThrow();
  });
});

describe("createAI.run", () => {
  it("no AI_GATEWAY_ID: binding called without gateway option", async () => {
    const { binding, run } = fakeAi(() => ({ response: "hi" }));
    expect(await createAI({ AI: binding }).text("@cf/m", "yo")).toBe("hi");
    expect(run).toHaveBeenCalledWith("@cf/m", { prompt: "yo", stream: false }, undefined);
  });
  it("AI_GATEWAY_ID: routed through the gateway with per-user key + options", async () => {
    const { binding, run } = fakeAi(() => ({ response: "hi" }));
    const ai = createAI({ AI: binding, AI_GATEWAY_ID: "gw" }, { userId: "u9", cacheTtl: 300, metadata: { app: "x" } });
    await ai.text("@cf/m", [{ role: "user", content: "q" }], { skipCache: false });
    const opts = run.mock.calls[0][2];
    expect(opts.gateway).toMatchObject({ id: "gw", cacheTtl: 300, skipCache: false, metadata: { app: "x" } });
    expect(opts.gateway.cacheKey).toMatch(/^u:u9:/);
    await ai.text("@cf/m", "q", { cacheKey: "explicit", userId: undefined });
    expect(run.mock.calls[1][2].gateway.cacheKey).toBe("explicit");
  });
  it("missing binding -> actionable AiError", async () => {
    await expect(createAI({}).text("m", "x")).rejects.toMatchObject({ code: "no-binding", message: expect.stringContaining("wrangler.jsonc") });
  });
});

describe("SSE", () => {
  it("parseSSE: arbitrary chunking, CRLF, comments, multi-line data, trailing event without blank line", async () => {
    const raw = ": ping\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: x";
    const out: unknown[] = [];
    for (const cut of [1, 3, 7, 1000]) {
      const chunks = raw.match(new RegExp(`[\\s\\S]{1,${cut}}`, "g"))!;
      const evs = []; for await (const e of parseSSE(sseStream(chunks))) evs.push(e);
      out.push(evs);
    }
    for (const evs of out) expect(evs).toEqual([{ event: "a", data: "1\n2" }, { event: undefined, data: "x" }]);
  });
  it("tokens: Workers AI + OpenAI shapes, stops at [DONE], skips junk, handles a multi-byte char split across chunks", async () => {
    const bytes = enc.encode(`data: ${JSON.stringify({ response: "xin chào 👋" })}\n\ndata: {"choices":[{"delta":{"content":" ok"}}]}\n\ndata: not-json\n\ndata: [DONE]\n\ndata: {"response":"after"}\n\n`);
    const s = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5)); c.close(); } });
    const got: string[] = []; for await (const t of tokens(s)) got.push(t);
    expect(got.join("")).toBe("xin chào 👋 ok");
  });
  it("sseResponse -> readChatStream roundtrip", async () => {
    const res = sseResponse(sseStream(workersAiSse(["Hel", "lo", " world"])));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const seen: string[] = []; let done = "";
    const full = await readChatStream(res, { onText: (d) => seen.push(d), onDone: (f) => (done = f) });
    expect(seen).toEqual(["Hel", "lo", " world"]); expect(full).toBe("Hello world"); expect(done).toBe("Hello world");
  });
  it("mid-stream failure -> event: error with a generic message, no leak", async () => {
    async function* gen() { yield "a"; throw new Error("secret upstream detail"); }
    const res = sseResponse(gen());
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("secret");
    await expect(readChatStream(sseResponse(gen()))).rejects.toBeInstanceOf(AiError);
  });
  it("client cancel propagates to the source", async () => {
    let cancelled = false;
    async function* gen() { try { for (let i = 0; ; i++) { yield String(i); await new Promise((r) => setTimeout(r, 1)); } } finally { cancelled = true; } }
    const r = sseResponse(gen()).body!.getReader();
    await r.read(); await r.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
  });
  it("ai.stream requires a stream from the model", async () => {
    const ok = fakeAi(() => sseStream(workersAiSse(["a"])));
    const got: string[] = []; for await (const t of tokens(await createAI({ AI: ok.binding }).stream("m", "x"))) got.push(t);
    expect(got).toEqual(["a"]); expect(ok.run.mock.calls[0][1]).toMatchObject({ stream: true });
    await expect(createAI({ AI: fakeAi(() => ({ response: "x" })).binding }).stream("m", "x")).rejects.toMatchObject({ code: "invalid-output" });
  });
});

describe("structured output", () => {
  const schema = { parse: (v: any) => { if (typeof v?.n !== "number") throw new Error("n must be a number"); return v as { n: number }; } };
  it("extractJson: raw, fenced, embedded, failing", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('Here: {"a":"}{","b":{"c":1}} done')).toEqual({ a: "}{", b: { c: 1 } });
    expect(() => extractJson("nope")).toThrow(AiError);
  });
  it("valid first try (object response, as json mode returns it)", async () => {
    const { binding, run } = fakeAi(() => ({ response: { n: 3 } }));
    expect(await createAI({ AI: binding }).json("m", "q", { ...schema, jsonSchema: { type: "object" } })).toEqual({ n: 3 });
    expect(run.mock.calls[0][1].response_format).toEqual({ type: "json_schema", json_schema: { type: "object" } });
  });
  it("invalid then valid: error fed back to the model", async () => {
    let n = 0;
    const { binding, run } = fakeAi(() => ({ response: n++ === 0 ? '{"n":"x"}' : '{"n":7}' }));
    expect(await createAI({ AI: binding }).json("m", "q", schema)).toEqual({ n: 7 });
    const second = run.mock.calls[1][1].messages;
    expect(second.at(-1).content).toContain("n must be a number");
    expect(second.at(-2)).toEqual({ role: "assistant", content: '{"n":"x"}' });
  });
  it("still invalid after retries -> AiError invalid-output", async () => {
    const { binding, run } = fakeAi(() => ({ response: "garbage" }));
    await expect(createAI({ AI: binding }).json("m", "q", schema, { retries: 2 })).rejects.toMatchObject({ code: "invalid-output" });
    expect(run).toHaveBeenCalledTimes(3);
  });
});

describe("embed + chunk", () => {
  it("embed batches and keeps order; shape mismatch is an error", async () => {
    const { binding, run } = fakeAi((_m, i) => ({ shape: [i.text.length, 2], data: i.text.map((t: string) => [t.length, 0]) }));
    const out = await createAI({ AI: binding }).embed(["a", "bb", "ccc", "dddd", "e"], { batchSize: 2 });
    expect(out).toEqual([[1, 0], [2, 0], [3, 0], [4, 0], [1, 0]]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][0]).toBe("@cf/baai/bge-base-en-v1.5");
    await expect(createAI({ AI: fakeAi(() => ({ data: [[1]] })).binding }).embed(["a", "b"])).rejects.toMatchObject({ code: "embed-shape" });
  });
  it("chunkText: slices are exact, bounded, overlapping, cover the text", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" ").replace(/(Sentence number 1\d)/g, "\n\n$1");
    const chunks = chunkText(text, { size: 120, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) { expect(c.text).toBe(text.slice(c.start, c.end)); expect(c.text.length).toBeLessThanOrEqual(120); }
    expect(chunks[0].start).toBe(0); expect(chunks.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < chunks.length; i++) { expect(chunks[i].start).toBeLessThan(chunks[i - 1].end); expect(chunks[i].start).toBeGreaterThan(chunks[i - 1].start); expect(chunks[i].end).toBeGreaterThan(chunks[i - 1].end); }
  });
  it("chunkText: no separators -> hard cut; short text -> one chunk; bad args", () => {
    expect(chunkText("x".repeat(25), { size: 10, overlap: 0 }).map((c) => c.text.length)).toEqual([10, 10, 5]);
    expect(chunkText("short")).toEqual([{ text: "short", index: 0, start: 0, end: 5 }]);
    expect(chunkText("   ")).toEqual([]);
    expect(() => chunkText("a", { size: 10, overlap: 10 })).toThrow();
    expect(() => chunkText("a", { size: 0 })).toThrow();
  });
});

describe("vectors", () => {
  const fakeIndex = () => {
    const calls = { upsert: [] as any[][], query: [] as any[], del: [] as string[][], get: [] as string[][] };
    const idx: VectorizeLike = {
      upsert: async (v) => { calls.upsert.push(v); return { mutationId: "m" + calls.upsert.length }; },
      query: async (vec, o) => { calls.query.push([vec, o]); return { matches: [{ id: "a", score: 0.9, metadata: { text: "A" } }] }; },
      deleteByIds: async (ids) => { calls.del.push(ids); return {}; },
      getByIds: async (ids) => { calls.get.push(ids); return ids.map((id) => ({ id, values: [1] })); },
    };
    return { idx, calls };
  };
  const items = (n: number, dim = 3) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, values: new Array(dim).fill(i) }));
  it("upsert batches at 1000 and applies the namespace", async () => {
    const { idx, calls } = fakeIndex();
    const r = await vectors(idx, { namespace: "ns" }).upsert(items(2500));
    expect(calls.upsert.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(r).toEqual({ count: 2500, batches: 3, mutationIds: ["m1", "m2", "m3"] });
    expect(calls.upsert[0][0].namespace).toBe("ns");
  });
  it("validation happens before any write", async () => {
    const { idx, calls } = fakeIndex();
    const v = vectors(idx, { batchSize: 2 });
    await expect(v.upsert([...items(3), { id: "bad", values: [1] }])).rejects.toThrow(/dimensions/);
    await expect(v.upsert([{ id: "x".repeat(65), values: [1] }])).rejects.toThrow(/id must be/);
    await expect(v.upsert([{ id: "a", values: [1] }, { id: "a", values: [1] }])).rejects.toThrow(/duplicate/);
    await expect(v.upsert([{ id: "a", values: [1], metadata: { big: "x".repeat(LIMITS.metadataBytes) } }])).rejects.toThrow(/metadata/);
    expect(calls.upsert).toEqual([]);
  });
  it("query: defaults, topK bounds, metadata flag mapping", async () => {
    const { idx, calls } = fakeIndex();
    const v = vectors(idx, { namespace: "n" });
    expect(await v.query([1, 2])).toHaveLength(1);
    expect(calls.query[0][1]).toEqual({ topK: 10, namespace: "n", filter: undefined, returnValues: false, returnMetadata: "none" });
    await v.query([1], { topK: 5, returnMetadata: true, filter: { k: "v" } });
    expect(calls.query[1][1]).toMatchObject({ topK: 5, returnMetadata: "all", filter: { k: "v" } });
    await expect(v.query([1], { topK: 101 })).rejects.toBeInstanceOf(VectorsError);
    await expect(v.query([1], { topK: 0 })).rejects.toBeInstanceOf(VectorsError);
  });
  it("text methods embed via Workers AI; need { ai }", async () => {
    const { idx, calls } = fakeIndex();
    const { binding } = fakeAi((_m, i) => ({ data: i.text.map((t: string) => [t.length, 1]) }));
    const v = vectors(idx, { ai: { AI: binding } });
    await v.upsertTexts([{ id: "a", text: "hello", metadata: { url: "/a" } }]);
    expect(calls.upsert[0][0]).toMatchObject({ id: "a", values: [5, 1], metadata: { url: "/a", text: "hello" } });
    await v.queryText("hey", { topK: 3 });
    expect(calls.query[0][0]).toEqual([3, 1]);
    await expect(vectors(idx).queryText("x")).rejects.toThrow(/ai: env/);
  });
  it("delete/get batch", async () => {
    const { idx, calls } = fakeIndex();
    const v = vectors(idx);
    await v.deleteByIds(Array.from({ length: 2001 }, (_, i) => "i" + i));
    expect(calls.del.map((b) => b.length)).toEqual([1000, 1000, 1]);
    expect(await v.getByIds(Array.from({ length: 45 }, (_, i) => "i" + i))).toHaveLength(45);
    expect(calls.get.map((b) => b.length)).toEqual([20, 20, 5]);
  });
});

describe("cf-lite add ai-chat", () => {
  const mk = (wrangler?: string) => { const d = mkdtempSync(join(tmpdir(), "cfl-ai-")); if (wrangler) writeFileSync(join(d, "wrangler.jsonc"), wrangler); return d; };
  it("patchWranglerAi inserts the binding once, keeps comments", () => {
    const src = '{\n  // my app\n  "name": "x"\n}';
    const out = patchWranglerAi(src)!;
    expect(out).toContain('"ai": { "binding": "AI" }'); expect(out).toContain("// my app");
    expect(patchWranglerAi(out)).toBe(out);
    expect(JSON.parse(out.replace(/\/\/.*$/gm, ""))).toMatchObject({ ai: { binding: "AI" } });
  });
  it("copies the template, is idempotent and never overwrites", () => {
    const d = mk('{ "name": "x" }');
    const logs: string[] = [];
    const a = addAiChat(d, (m) => logs.push(m));
    expect(a.changed).toEqual(expect.arrayContaining(["server/api/chat.ts", "app/chat-client.ts", "wrangler.jsonc"]));
    writeFileSync(join(d, "server/api/chat.ts"), "// mine");
    expect(addAiChat(d).changed).toEqual([]);
    expect(readFileSync(join(d, "server/api/chat.ts"), "utf8")).toBe("// mine");
  });
  it("no wrangler file: tells the user", () => {
    const logs: string[] = [];
    addAiChat(mk(), (m) => logs.push(m));
    expect(logs.join("\n")).toMatch(/wrangler/);
  });
});

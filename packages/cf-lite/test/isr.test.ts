import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createIsr, isrConsumer, isrKey, isrRevalidate, revalidatePath, revalidateTag, type IsrEnv, type IsrMessage } from "../src/modules/isr.js";

// ---- fakes: R2 (head/get/put/list/delete with customMetadata), Queue, KV ----
function fakeR2() {
  const m = new Map<string, { body: ArrayBuffer; customMetadata: Record<string, string>; httpMetadata: { contentType?: string } }>();
  const obj = (k: string) => { const e = m.get(k)!; return { key: k, customMetadata: e.customMetadata, httpMetadata: e.httpMetadata, httpEtag: `"e${k.length}"` }; };
  return {
    m,
    async head(k: string) { return m.has(k) ? obj(k) : null; },
    async get(k: string) { const e = m.get(k); return e ? { ...obj(k), body: new Response(e.body).body } : null; },
    async put(k: string, v: string | ArrayBuffer, o: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } } = {}) {
      m.set(k, { body: typeof v === "string" ? new TextEncoder().encode(v).buffer as ArrayBuffer : v, customMetadata: o.customMetadata ?? {}, httpMetadata: o.httpMetadata ?? {} });
    },
    async delete(k: string | string[]) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list(o: { prefix?: string }) { return { objects: [...m.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map(obj), truncated: false }; },
  } as unknown as R2Bucket & { m: typeof m };
}
function fakeQueue() {
  const sent: IsrMessage[] = [];
  return { sent, send: async (b: IsrMessage) => void sent.push(b), sendBatch: async (xs: { body: IsrMessage }[]) => void sent.push(...xs.map((x) => x.body)) } as unknown as Queue<IsrMessage> & { sent: IsrMessage[] };
}

let clock = 1_000_000;
function setup(policy = { maxAge: 60, swr: 600, tags: ["posts"] as string[] }, withQueue = true) {
  const bucket = fakeR2(), queue = fakeQueue();
  const env: IsrEnv = { ISR_BUCKET: bucket, ...(withQueue ? { ISR_QUEUE: queue } : {}) };
  let renders = 0, fail = false, version = 1;
  const isr = createIsr({ now: () => clock });
  const app = new Hono<{ Bindings: IsrEnv }>();
  app.get("/p/:id", isr(policy), (c) => {
    renders++;
    if (fail) return c.text("boom", 500);
    return c.html(`post ${c.req.param("id")} v${version}`);
  });
  const bg: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void bg.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await app.request("http://t.example" + path, { headers }, env, ctx);
    const body = await r.text();
    await Promise.all(bg.splice(0));
    return { r, body, st: r.headers.get("x-cf-lite-isr") };
  };
  const consumer = isrConsumer({ render: (req, e, x) => app.fetch(req, e, x), origin: "http://t.example" });
  const drain = async () => {
    const msgs = queue.sent.splice(0);
    const acked: string[] = [], retried: string[] = [];
    const batch = { queue: "isr", messages: msgs.map((body, i) => ({ id: String(i), body, attempts: 1, ack: () => acked.push(String(i)), retry: () => retried.push(String(i)) })) } as unknown as MessageBatch<IsrMessage>;
    await consumer(batch, env, ctx);
    await Promise.all(bg.splice(0));
    return { n: msgs.length, acked, retried };
  };
  return { bucket, queue, env, get, drain, set: (o: { fail?: boolean; version?: number }) => { if (o.fail !== undefined) fail = o.fail; if (o.version) version = o.version; }, renders: () => renders, app, ctx };
}

describe("isr middleware", () => {
  it("miss renders + stores in R2, then hits without rendering", async () => {
    const s = setup();
    let x = await s.get("/p/1");
    expect(x.st).toBe("MISS"); expect(x.body).toBe("post 1 v1");
    expect(s.bucket.m.has("_isr/p/1")).toBe(true);
    x = await s.get("/p/1");
    expect(x.st).toBe("HIT"); expect(x.body).toBe("post 1 v1"); expect(s.renders()).toBe(1);
    expect(x.r.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=600");
    expect(x.r.headers.get("content-type")).toMatch(/text\/html/);
  });
  it("stale within swr serves R2 and queues exactly one regeneration; consumer stores the new copy", async () => {
    const s = setup();
    await s.get("/p/1"); clock += 120_000; s.set({ version: 2 });
    let x = await s.get("/p/1");
    expect(x.st).toBe("STALE"); expect(x.body).toBe("post 1 v1");
    expect(s.queue.sent).toHaveLength(1); expect(s.queue.sent[0]).toMatchObject({ path: "/p/1", reason: "stale" });
    const d = await s.drain();
    expect(d.acked).toEqual(["0"]);
    x = await s.get("/p/1");
    expect(x.st).toBe("HIT"); expect(x.body).toBe("post 1 v2");
  });
  it("revalidateTag enqueues one message per tagged page and the consumer refreshes them; others stay", async () => {
    const s = setup();
    for (const id of ["1", "2"]) await s.get("/p/" + id);
    clock += 1000; s.set({ version: 2 });
    const r = await revalidateTag(s.env, "posts", clock);
    expect(r.enqueued).toBe(2);
    // before the consumer runs, the last copy is still served (stale-while-regenerate from R2)
    expect((await s.get("/p/1")).body).toBe("post 1 v1");
    await s.drain(); s.queue.sent.length = 0;
    expect((await s.get("/p/1")).body).toBe("post 1 v2");
    expect((await s.get("/p/2")).body).toBe("post 2 v2");
  });
  it("revalidatePath targets a single page", async () => {
    const s = setup();
    for (const id of ["1", "2"]) await s.get("/p/" + id);
    clock += 1000;
    const r = await revalidatePath(s.env, "/p/2", clock);
    expect(r.enqueued).toBe(1); expect(s.queue.sent[0].path).toBe("/p/2");
  });
  it("messages older than the stored copy are skipped without rendering (dedupe)", async () => {
    const s = setup();
    await s.get("/p/1"); const before = s.renders();
    s.queue.sent.push({ v: 1, path: "/p/1", at: clock - 10, reason: "tag" });
    const d = await s.drain();
    expect(d.acked).toEqual(["0"]); expect(s.renders()).toBe(before);
  });
  it("failed regeneration keeps serving the last good copy and retries the message", async () => {
    const s = setup();
    await s.get("/p/1"); clock += 1000;
    await revalidateTag(s.env, "posts", clock);
    s.set({ fail: true, version: 3 });
    const d = await s.drain();
    expect(d.retried).toEqual(["0"]); expect(d.acked).toEqual([]);
    const x = await s.get("/p/1");
    expect(x.body).toBe("post 1 v1"); expect(x.r.status).toBe(200);
  });
  it("beyond swr: renders inline; if that fails falls back to the last good copy (stale-if-error)", async () => {
    const s = setup();
    await s.get("/p/1"); clock += 2_000_000; s.set({ fail: true });
    const x = await s.get("/p/1");
    expect(x.st).toBe("STALE"); expect(x.body).toBe("post 1 v1");
    s.set({ fail: false, version: 2 });
    const y = await s.get("/p/1");
    expect(y.st).toBe("MISS"); expect(y.body).toBe("post 1 v2");
  });
  it("does not store 5xx, set-cookie or authenticated responses", async () => {
    const s = setup();
    s.set({ fail: true });
    expect((await s.get("/p/9")).st).toBe("BYPASS");
    expect(s.bucket.m.size).toBe(0);
    s.set({ fail: false });
    const a = await s.get("/p/9", { cookie: "sso=abc" });
    expect(a.st).toBe("BYPASS"); expect(a.r.headers.get("cache-control")).toBe("private, no-cache");
    expect((await s.get("/p/9", { authorization: "Bearer x" })).st).toBe("BYPASS");
    expect(s.bucket.m.size).toBe(0);
  });
  it("session-module cookies bypass by default, and a per-request CSP nonce is never stored", async () => {
    const s = setup();
    for (const cookie of ["session=abc", "__Host-session=abc"]) expect((await s.get("/p/3", { cookie })).st, cookie).toBe("BYPASS");
    expect(s.bucket.m.size).toBe(0);
    const bucket = fakeR2(), env: IsrEnv = { ISR_BUCKET: bucket };
    const isr = createIsr({ now: () => clock });
    const app = new Hono<{ Bindings: IsrEnv }>().use("*", async (c, next) => { c.set("cspNonce", "abc"); await next(); }).get("/p", isr({ maxAge: 60 }), (c) => c.html("<script nonce=abc>1</script>"));
    const r = await app.request("http://t.example/p", {}, env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect([r.headers.get("x-cf-lite-isr"), r.headers.get("x-cf-lite-isr-why"), bucket.m.size]).toEqual(["BYPASS", "csp-nonce", 0]);
  });
  it("a client cannot forge the regeneration header", async () => {
    const s = setup();
    await s.get("/p/1"); s.set({ version: 2 });
    const x = await s.get("/p/1", { "x-cf-lite-isr-regen": "guess" });
    expect(x.st).toBe("HIT"); expect(x.body).toBe("post 1 v1");
  });
  it("query strings: tracking params share an entry; real params get their own", async () => {
    const s = setup();
    await s.get("/p/1?utm_source=x");
    expect((await s.get("/p/1")).st).toBe("HIT");
    expect((await s.get("/p/1?page=2")).st).toBe("MISS");
    expect(await isrKey("/p/1?page=2")).toMatch(/^_isr\/p\/1\?[0-9a-f]{24}$/);
  });
  it("without a queue, revalidateTag deletes entries so the next request renders fresh", async () => {
    const s = setup(undefined, false);
    await s.get("/p/1"); s.set({ version: 2 });
    const r = await revalidateTag(s.env, "posts");
    expect(r).toMatchObject({ enqueued: 0, deleted: 1 });
    expect((await s.get("/p/1")).body).toBe("post 1 v2");
  });
  it("no bucket bound: serves uncached", async () => {
    const isr = createIsr();
    const app = new Hono().get("/x", isr({ maxAge: 10 }), (c) => c.text("ok"));
    const r = await app.request("http://t/x", {}, {});
    expect(r.status).toBe(200); expect(r.headers.get("x-cf-lite-isr")).toBe("BYPASS");
  });
});

describe("isrRevalidate endpoint", () => {
  const mk = (env: Partial<IsrEnv>) => { const app = new Hono<{ Bindings: IsrEnv }>().post("/r", isrRevalidate()); return (init: RequestInit) => app.request("http://t/r", { method: "POST", ...init }, env as IsrEnv); };
  const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };
  it("fails closed without a token, 401 on wrong token", async () => {
    expect((await mk({ ISR_BUCKET: fakeR2() })({ headers: auth, body: "{}" })).status).toBe(503);
    expect((await mk({ ISR_REVALIDATE_TOKEN: "s3cret" })({ headers: { authorization: "Bearer nope" }, body: "{}" })).status).toBe(401);
    expect((await mk({ ISR_REVALIDATE_TOKEN: "s3cret" })({ body: "{}" })).status).toBe(401);
  });
  it("validates body and revalidates", async () => {
    const bucket = fakeR2(), queue = fakeQueue();
    const s = mk({ ISR_REVALIDATE_TOKEN: "s3cret", ISR_BUCKET: bucket, ISR_QUEUE: queue });
    expect((await s({ headers: auth, body: "nope" })).status).toBe(400);
    expect((await s({ headers: auth, body: JSON.stringify({ paths: ["x"] }) })).status).toBe(400);
    expect((await s({ headers: auth, body: JSON.stringify({ tags: [] }) })).status).toBe(400);
    const r = await s({ headers: auth, body: JSON.stringify({ tags: ["posts"] }) });
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ ok: true, enqueued: 0 });
  });
});

describe("isr as a route convention (WP-GAPS)", () => {
  it("isrRoute wraps an ssr handler: MISS then HIT, policy from the module's `isr` export", async () => {
    const { isrRoute } = await import("../src/modules/isr.js");
    const bucket = fakeR2();
    const env: IsrEnv = { ISR_BUCKET: bucket };
    let renders = 0;
    const app = new Hono<{ Bindings: IsrEnv }>().get("/p/:id", isrRoute({ isr: { maxAge: 60, tags: (c) => [`p:${c.req.param("id")}`] } }, (c) => { renders++; return c.html("hi " + c.req.param("id")); }));
    const bg: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void bg.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const get = async () => { const r = await app.request("http://t.example/p/7", {}, env, ctx); const b = await r.text(); await Promise.all(bg.splice(0)); return { st: r.headers.get("x-cf-lite-isr"), b }; };
    expect(await get()).toEqual({ st: "MISS", b: "hi 7" });
    expect(await get()).toEqual({ st: "HIT", b: "hi 7" });
    expect(renders).toBe(1);
    expect([...bucket.m.keys()].some((k) => k.startsWith("_isr-tags/"))).toBe(true);
  });
  it("isrRoute fails fast on a missing/invalid policy", async () => {
    const { isrRoute } = await import("../src/modules/isr.js");
    expect(() => isrRoute({}, () => new Response("x"))).toThrow(/policy object/);
    expect(() => isrRoute({ isr: { maxAge: 0 } }, () => new Response("x"))).toThrow(/maxAge/);
  });
});

describe("isr maxStale inline path + store guards (WP-COVERAGE)", () => {
  it("older than maxAge+swr: renders inline and replaces the copy", async () => {
    const s = setup({ maxAge: 60, swr: 60, tags: [] });
    await s.get("/p/9"); clock += 10_000_000; s.set({ version: 3 });
    const x = await s.get("/p/9");
    expect(x.body).toBe("post 9 v3"); expect(s.queue.sent).toHaveLength(0);
    clock += 1000;
    expect((await s.get("/p/9")).body).toBe("post 9 v3");
  });
  it("inline render fails (5xx) within maxStale -> the last good copy is served, never the error page", async () => {
    const s = setup({ maxAge: 60, swr: 60, tags: [] });
    await s.get("/p/8"); clock += 1_000_000; s.set({ fail: true });
    const x = await s.get("/p/8");
    expect(x.r.status).toBe(200); expect(x.body).toBe("post 8 v1"); expect(x.st).toBe("STALE");
    s.set({ fail: false });
  });
  it("a response that sets a cookie is never stored (would leak one user's Set-Cookie to everyone)", async () => {
    const bucket = fakeR2(); const isr = createIsr({ now: () => clock });
    const app = new Hono<{ Bindings: IsrEnv }>().get("/c", isr({ maxAge: 60 }), (c) => { c.header("set-cookie", "a=b"); return c.html("x"); });
    const r = await app.request("http://t/c", {}, { ISR_BUCKET: bucket } as IsrEnv);
    expect(r.headers.get("x-cf-lite-isr")).toBe("BYPASS");
    expect(bucket.m.size).toBe(0);
  });
  it("non-GET and missing bucket are bypassed (not cached, handler still runs)", async () => {
    const isr = createIsr({ now: () => clock });
    const app = new Hono<{ Bindings: IsrEnv }>().all("/c", isr({ maxAge: 60 }), (c) => c.text("ran"));
    const post = await app.request("http://t/c", { method: "POST" }, { ISR_BUCKET: fakeR2() } as IsrEnv);
    expect([post.status, post.headers.get("x-cf-lite-isr-why")]).toEqual([200, "method"]);
    const nb = await app.request("http://t/c", {}, {} as IsrEnv);
    expect([nb.status, nb.headers.get("x-cf-lite-isr-why")]).toEqual([200, "no-bucket"]);
  });
  it("maxAge <= 0 is rejected at definition time", () => {
    expect(() => createIsr()({ maxAge: 0 })).toThrow(/maxAge/);
  });
});

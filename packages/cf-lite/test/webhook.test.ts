import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  ALL_TAG, applyEvents, contentTag, contentTags, eventTags, genericAdapter, kvDedupe, safeEqual, signWebhook, trackContent, typeTag,
  verifyWebhook, webhookConsumer, webhookReceiver, DEFAULT_VERIFY, type WebhookEnv, type WebhookMessage,
} from "../src/modules/webhook.js";
import { optimizelyAdapter, optimizelyVerify } from "../src/modules/webhook-optimizely.js";
import { createCacheRoute, purgeTags } from "../src/modules/cache.js";
import optimizelyFixture from "./fixtures/optimizely-graph-webhook.json" with { type: "json" };

function fakeKv() {
  const m = new Map<string, string>();
  return { m, async get(k: string) { return m.get(k) ?? null; }, async put(k: string, v: string) { m.set(k, v); } } as unknown as KVNamespace & { m: Map<string, string> };
}
function fakeQueue() {
  const sent: WebhookMessage[] = [];
  return { sent, send: async (b: WebhookMessage) => void sent.push(b) } as unknown as Queue<WebhookMessage> & { sent: WebhookMessage[] };
}
const SECRET = "s3cret-value";
const NOW = 1_800_000_000_000;

function rig(extra: Partial<WebhookEnv> = {}, adapter = genericAdapter(), verify?: Parameters<typeof webhookReceiver>[0]["verify"]) {
  const queue = fakeQueue(), kv = fakeKv();
  const env: WebhookEnv = { CMS_WEBHOOK_SECRET: SECRET, WEBHOOK_QUEUE: queue, WEBHOOK_KV: kv, ...extra };
  const app = new Hono<{ Bindings: WebhookEnv }>().post("/cms", webhookReceiver({ adapter, verify, now: () => NOW }));
  const post = async (body: unknown, headers: Record<string, string> = {}, signed = true) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const sig = signed ? await signWebhook(raw, SECRET, NOW) : {};
    const r = await app.request("http://t.example/cms", { method: "POST", body: raw, headers: { "content-type": "application/json", ...sig, ...headers } }, env);
    return { status: r.status, json: (await r.json()) as any };
  };
  return { queue, kv, env, post };
}

describe("verifyWebhook", () => {
  const raw = '{"a":1}';
  const mk = (h: Record<string, string>) => new Request("http://x/", { method: "POST", body: raw, headers: h });
  it("accepts the canonical x-cms-signature and rejects tampering", async () => {
    const h = await signWebhook(raw, SECRET, NOW);
    expect(h["x-cms-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(await verifyWebhook(mk(h), raw, SECRET, DEFAULT_VERIFY, NOW)).toEqual({ ok: true });
    expect((await verifyWebhook(mk(h), raw + " ", SECRET, DEFAULT_VERIFY, NOW)).ok).toBe(false);
    expect((await verifyWebhook(mk(h), raw, "other", DEFAULT_VERIFY, NOW)).ok).toBe(false);
    // known-answer: independent HMAC computation
    const t = h["x-cms-signature"].match(/t=(\d+)/)![1];
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`)))].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(h["x-cms-signature"]).toBe(`t=${t},v1=${mac}`);
  });
  it("accepts any of several v1= values; rejects malformed headers", async () => {
    const h = await signWebhook(raw, SECRET, NOW), good = h["x-cms-signature"];
    const t = good.match(/t=(\d+)/)![1];
    expect((await verifyWebhook(mk({ "x-cms-signature": `t=${t},v1=${"0".repeat(64)},${good.split(",")[1]}` }), raw, SECRET, DEFAULT_VERIFY, NOW)).ok).toBe(true);
    for (const bad of ["garbage", `t=${t}`, "v1=abc", `t=abc,v1=${"0".repeat(64)}`]) expect(await verifyWebhook(mk({ "x-cms-signature": bad }), raw, SECRET, DEFAULT_VERIFY, NOW)).toMatchObject({ ok: false, status: 401 });
  });
  it("rejects stale/future timestamps (replay) and a re-stamped signature", async () => {
    const h = await signWebhook(raw, SECRET, NOW);
    expect(await verifyWebhook(mk(h), raw, SECRET, DEFAULT_VERIFY, NOW + 301_000)).toMatchObject({ ok: false, status: 401, error: "timestamp outside tolerance" });
    expect((await verifyWebhook(mk(h), raw, SECRET, DEFAULT_VERIFY, NOW - 301_000)).ok).toBe(false);
    expect((await verifyWebhook(mk(h), raw, SECRET, DEFAULT_VERIFY, NOW + 299_000)).ok).toBe(true);
    const v1 = h["x-cms-signature"].split(",")[1];
    expect((await verifyWebhook(mk({ "x-cms-signature": `t=${NOW / 1000 + 10},${v1}` }), raw, SECRET, DEFAULT_VERIFY, NOW)).ok).toBe(false);
  });
  it("fails closed without a secret, and supports rotation lists", async () => {
    const h = await signWebhook(raw, "old", NOW);
    expect(await verifyWebhook(mk(h), raw, undefined, DEFAULT_VERIFY, NOW)).toMatchObject({ ok: false, status: 503 });
    expect(await verifyWebhook(mk(h), raw, " ,", DEFAULT_VERIFY, NOW)).toMatchObject({ status: 503 });
    expect((await verifyWebhook(mk(h), raw, "new, old", DEFAULT_VERIFY, NOW)).ok).toBe(true);
    expect(await verifyWebhook(mk({}), raw, "new", DEFAULT_VERIFY, NOW)).toMatchObject({ status: 401, error: "missing signature" });
  });
  it("secret mode compares the header to the secret", async () => {
    const o = { mode: "secret", signatureHeader: "x-api-key" } as const;
    expect((await verifyWebhook(mk({ "x-api-key": "k1" }), raw, "k1", o)).ok).toBe(true);
    expect((await verifyWebhook(mk({ "x-api-key": "k1x" }), raw, "k1", o)).ok).toBe(false);
  });
  it("safeEqual is length-safe", async () => {
    expect(await safeEqual("a", "a")).toBe(true);
    expect(await safeEqual("a", "ab")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
  });
});

describe("webhookReceiver", () => {
  const ev = { id: "d-1", events: [{ type: "post", id: 42 }] };
  it("verifies, enqueues and answers 200 without touching purge", async () => {
    const r = rig();
    const res = await r.post(ev);
    expect(res).toEqual({ status: 200, json: { ok: true, events: 1 } });
    expect(r.queue.sent).toHaveLength(1);
    expect(r.queue.sent[0]).toMatchObject({ v: 1, delivery: "generic:d-1", provider: "generic", at: NOW, events: [{ action: "publish", type: "post", id: "42" }] });
  });
  it("401 on bad/missing signature, nothing enqueued", async () => {
    const r = rig();
    expect((await r.post(ev, {}, false)).status).toBe(401);
    expect((await r.post(ev, { "x-cms-signature": "t=1,v1=00" })).status).toBe(401);
    expect(r.queue.sent).toHaveLength(0);
  });
  it("503 fail-closed without secret or queue", async () => {
    expect((await rig({ CMS_WEBHOOK_SECRET: undefined }).post(ev)).status).toBe(503);
    expect((await rig({ WEBHOOK_QUEUE: undefined }).post(ev)).status).toBe(503);
  });
  it("is idempotent per delivery id (body hash fallback too)", async () => {
    const r = rig();
    expect((await r.post(ev)).json.duplicate).toBeUndefined();
    expect((await r.post(ev)).json).toEqual({ ok: true, duplicate: true, events: 0 });
    expect(r.queue.sent).toHaveLength(1);
    const noId = { events: [{ type: "post", id: "7" }] };
    await r.post(noId); const again = await r.post(noId);
    expect(again.json.duplicate).toBe(true);
    expect(r.queue.sent).toHaveLength(2);
    // header delivery id wins
    await r.post({ events: [{ type: "post", id: "9" }] }, { "x-cms-delivery": "h-1" });
    expect((await r.post({ events: [{ type: "post", id: "10" }] }, { "x-cms-delivery": "h-1" })).json.duplicate).toBe(true);
  });
  it("does not mark delivered when enqueue throws (CMS retry is re-processed)", async () => {
    const r = rig();
    (r.env.WEBHOOK_QUEUE as any).send = async () => { throw new Error("queue down"); };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = JSON.stringify(ev);
    const app = new Hono<{ Bindings: WebhookEnv }>().post("/cms", webhookReceiver({ adapter: genericAdapter(), now: () => NOW }));
    const res = await app.request("http://t/cms", { method: "POST", body: raw, headers: await signWebhook(raw, SECRET, NOW) }, r.env);
    quiet.mockRestore();
    expect(res.status).toBe(500); // Hono onError: the CMS sees a failure and retries
    expect(r.kv.m.size).toBe(0);
  });
  it("400 on malformed payloads, 413 when oversized", async () => {
    const r = rig();
    expect((await r.post("not json")).status).toBe(400);
    expect((await r.post({ events: [{ type: "post" }] })).status).toBe(400);
    expect((await r.post({ events: [{ action: "nuke", type: "p", id: "1" }] })).status).toBe(400);
    expect((await r.post({ events: [{ paths: ["no-slash"] }] })).status).toBe(400);
    expect((await r.post({ pad: "x".repeat(300 * 1024) })).status).toBe(413);
    expect(r.queue.sent).toHaveLength(0);
  });
  it("works without a dedupe store (warns once)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig({ WEBHOOK_KV: undefined });
    expect((await r.post(ev)).status).toBe(200);
    expect((await r.post(ev)).status).toBe(200);
    expect(r.queue.sent).toHaveLength(2);
    warn.mockRestore();
  });
  it("kvDedupe marks and sees", async () => {
    const d = kvDedupe(fakeKv());
    expect(await d.seen("a")).toBe(false); await d.mark("a"); expect(await d.seen("a")).toBe(true);
  });
});

describe("tags", () => {
  it("eventTags covers exact, type-wide, coarse, explicit and path tags", () => {
    expect(eventTags({ action: "publish", type: "post", id: "42", paths: ["/blog/x/"], tags: ["nav"] })).toEqual(["nav", "content:post:*", "content:post:42", "path:/blog/x"]);
    expect(eventTags({ action: "publish", all: true })).toEqual([ALL_TAG]);
  });
  it("trackContent records per request and contentTags dedupes", () => {
    const req = new Request("http://x/a");
    trackContent(req, "post", [1, 2]); trackContent(req, "post", "2"); trackContent(req, "author", 9);
    expect(contentTags(req).sort()).toEqual(["content:author:9", "content:post:1", "content:post:2"]);
    expect(contentTags(new Request("http://x/b"))).toEqual([]);
  });
  it("'*' means any of the type; overflow collapses the biggest type, never drops deps", () => {
    const req = new Request("http://x/list");
    trackContent(req, "post", "*"); trackContent(req, "post", "1");
    expect(contentTags(req)).toEqual([typeTag("post")]);
    const big = new Request("http://x/big");
    trackContent(big, "post", Array.from({ length: 30 }, (_, i) => i)); trackContent(big, "author", [1, 2, 3]);
    const t = contentTags(big);
    expect(t.length).toBeLessThanOrEqual(14);
    expect(t).toContain(typeTag("post"));
    expect(t).toContain(contentTag("author", "1"));
    // a publish of ANY post purges the collapsed page
    expect(eventTags({ action: "publish", type: "post", id: "999" })).toContain(typeTag("post"));
  });
  it("all:true adds the coarse tag that bulk events purge", () => {
    const req = new Request("http://x/all");
    trackContent(req, "post", "1");
    expect(contentTags(req, { all: true })).toEqual(["content:post:1", ALL_TAG]);
    expect(contentTags(new Request("http://x/none"), { all: true })).toEqual([ALL_TAG]);
    expect(contentTags(req, { all: true }).length).toBeLessThanOrEqual(14);
  });
  it("works with a hono Context-like object", () => {
    const req = new Request("http://x/c");
    trackContent({ req: { raw: req } } as any, "post", "5");
    expect(contentTags({ req: { raw: req } } as any)).toEqual(["content:post:5"]);
  });
});

describe("consumer -> purge (real cache module, KV ledger)", () => {
  it("publish of content X purges every cached page that rendered X, and only those", async () => {
    // KV-backed ledger + in-memory Cache API
    const kvm = new Map<string, string>();
    const kv = { async get(k: string) { return kvm.get(k) ?? null; }, async put(k: string, v: string) { kvm.set(k, v); } } as unknown as KVNamespace;
    const store = new Map<string, Response>();
    let clock = 1000;
    const cache = { async match(r: Request) { return store.get(r.url)?.clone(); }, async put(r: Request, res: Response) { store.set(r.url, res); } } as unknown as Cache;
    const route = createCacheRoute({ cache: () => cache, now: () => clock, dev: false });
    let renders = 0;
    const page = (path: string, ids: string[]) =>
      route({ cache: ({ req }: any) => ({ maxAge: 600, tags: contentTags(req) }) } as any, (c) => { renders++; for (const id of ids) trackContent(c, "post", id); return c.text("x"); });
    const app = new Hono<{ Bindings: WebhookEnv }>();
    app.get("/a", (c, next) => page("/a", ["1", "2"])(c)); app.get("/b", (c) => page("/b", ["3"])(c));
    const env: WebhookEnv = { CF_CACHE_TAGS: kv };
    const get = (p: string) => app.request("http://t.example" + p, {}, env).then((r) => r.headers.get("x-cf-lite-cache"));
    expect([await get("/a"), await get("/b")]).toEqual(["MISS", "MISS"]);
    expect([await get("/a"), await get("/b")]).toEqual(["HIT", "HIT"]);
    clock += 10;
    await applyEvents(env, [{ action: "publish", type: "post", id: "2" }], {}, clock);
    clock += 10;
    expect([await get("/a"), await get("/b")]).toEqual(["MISS", "HIT"]);
    // unpublish behaves identically; unrelated content purges nothing
    clock += 10;
    await applyEvents(env, [{ action: "unpublish", type: "post", id: "3" }], {}, clock); clock += 10;
    expect(await get("/b")).toBe("MISS");
    expect(renders).toBe(4);
  });

  it("consumer handler: maps messages, resolve() adds tags/paths, errors retry, malformed dropped", async () => {
    const calls: string[][] = [];
    const tagKv = { async get() { return null; }, async put(k: string) { calls.push([k]); } } as unknown as KVNamespace;
    const env: WebhookEnv = { CF_CACHE_TAGS: tagKv };
    const h = webhookConsumer({ resolve: (ev) => ({ tags: ["sitemap"], paths: ev.id ? [`/blog/${ev.id}`] : [] }), now: () => 5 });
    const mkMsg = (body: unknown, attempts = 1) => { const m = { body, id: "m", attempts, acked: false, retried: false, ack() { m.acked = true; }, retry() { m.retried = true; } }; return m; };
    const good = mkMsg({ v: 1, delivery: "g:1", provider: "generic", at: 1, events: [{ action: "publish", type: "post", id: "7" }] });
    const bad = mkMsg({ nope: true });
    await h({ queue: "q", messages: [good, bad] } as any, env, {} as any);
    expect(good.acked && bad.acked).toBe(true);
    const keys = calls.map((c) => c[0]).sort();
    expect(keys).toEqual(["cfl:tag:content:post:*", "cfl:tag:content:post:7", "cfl:tag:path:/blog/7", "cfl:tag:sitemap"].sort());
    // no store bound -> throws -> retry
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const m2 = mkMsg({ v: 1, delivery: "g:2", provider: "generic", at: 1, events: [{ action: "publish", type: "post", id: "7" }] });
    await h({ queue: "q", messages: [m2] } as any, {} as any, {} as any);
    expect(m2.retried).toBe(true);
    err.mockRestore();
  });

  it("uses revalidateTag (ISR) when ISR_BUCKET is bound", async () => {
    const listed: string[] = [];
    const bucket = { async list(o: { prefix: string }) { listed.push(o.prefix); return { objects: [], truncated: false }; } } as unknown as R2Bucket;
    const out = await applyEvents({ ISR_BUCKET: bucket }, [{ action: "publish", type: "post", id: "1" }]);
    expect(out.mode).toBe("isr");
    expect(listed).toHaveLength(2);
    expect(await applyEvents({}, [])).toEqual({ tags: [], mode: "none" });
    await expect(applyEvents({}, [{ action: "publish", all: true }])).rejects.toThrow(/nothing to purge/);
  });
});

describe("optimizely graph adapter (stub; shape from public docs)", () => {
  const a = optimizelyAdapter({ type: "page" });
  it("parses the fixture bodies", () => {
    const f = optimizelyFixture as Record<string, unknown>;
    expect(a.parse(f.docUpdated, new Request("http://x"))).toEqual([{ action: "publish", type: "page", id: "4b2a9f0e1c3d4e5f8a7b9c0d1e2f3a4b", locale: "en" }]);
    expect(a.parse(f.docExpired, new Request("http://x"))).toEqual([{ action: "unpublish", type: "page", id: "4b2a9f0e1c3d4e5f8a7b9c0d1e2f3a4b", locale: "en" }]);
    expect(a.parse(f.bulkCompleted, new Request("http://x"))).toEqual([{ action: "publish", all: true }]);
    expect(optimizelyAdapter({ bulkPurgesAll: false }).parse(f.bulkCompleted, new Request("http://x"))).toEqual([]);
    expect(a.parse({ type: { subject: "doc", action: "deleted" }, data: {} }, new Request("http://x"))).toEqual([]);
    expect(a.deliveryId!(f.docUpdated)).toBe("evt-0001");
  });
  it("event tags match the tags a loader tracks for _metadata.key (32-hex)", () => {
    const f = optimizelyFixture as Record<string, any>;
    const [ev] = a.parse(f.docUpdated, new Request("http://x"));
    const req = new Request("http://x");
    trackContent(req, "page", f._contentId);
    expect(eventTags(ev)).toContain(contentTags(req)[0]);
  });
  it("ignores _Draft docIds unless includeDrafts; keepDashes opts out of normalisation", () => {
    const f = optimizelyFixture as Record<string, any>;
    expect(a.parse(f.docDraftUpdated, new Request("http://x"))).toEqual([]);
    expect(optimizelyAdapter({ includeDrafts: true }).parse(f.docDraftUpdated, new Request("http://x"))[0].id).toBe(f._contentId);
    expect(optimizelyAdapter({ keepDashes: true }).parse(f.docUpdated, new Request("http://x"))[0].id).toBe("4b2a9f0e-1c3d-4e5f-8a7b-9c0d1e2f3a4b");
  });
  it("rejects non-Optimizely bodies", () => {
    expect(() => a.parse({ hello: 1 }, new Request("http://x"))).toThrow();
    expect(() => a.parse({ type: { subject: "doc", action: "updated" }, data: {} }, new Request("http://x"))).toThrow(/docId/);
    expect(() => a.parse({ type: { subject: "doc", action: "updated" }, data: { docId: "!!" } }, new Request("http://x"))).toThrow(/docId/);
  });
  it("end to end through the receiver using x-api-key", async () => {
    const r = rig({}, a, optimizelyVerify);
    const raw = JSON.stringify((optimizelyFixture as any).docUpdated);
    const res = await new Hono<{ Bindings: WebhookEnv }>().post("/cms", webhookReceiver({ adapter: a, verify: optimizelyVerify })).request("http://t/cms", { method: "POST", body: raw, headers: { "x-api-key": SECRET } }, r.env);
    expect(res.status).toBe(200);
    expect(r.queue.sent[0].events[0].id).toBe("4b2a9f0e1c3d4e5f8a7b9c0d1e2f3a4b");
    const bad = await new Hono<{ Bindings: WebhookEnv }>().post("/cms", webhookReceiver({ adapter: a, verify: optimizelyVerify })).request("http://t/cms", { method: "POST", body: raw, headers: { "x-api-key": "nope" } }, r.env);
    expect(bad.status).toBe(401);
  });
});

void purgeTags;

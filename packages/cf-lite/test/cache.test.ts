import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { cachePurge, cleanTags, createCacheRoute, d1Store, kvStore, normalizeUrl, pathTag, purgePaths, purgeTags, tagStoreFor, type CacheEnv } from "../src/modules/cache.js";

// ---- fakes: Cache API, KV, D1 (real SQL via node:sqlite) ----
function fakeCache() {
  const m = new Map<string, { status: number; headers: [string, string][]; body: string }>();
  return {
    m,
    async match(k: Request) { const e = m.get(k.url); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined; },
    async put(k: Request, r: Response) { m.set(k.url, { status: r.status, headers: [...r.headers], body: await r.text() }); },
  } as unknown as Cache & { m: Map<string, unknown> };
}
function fakeKv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace & { m: Map<string, string> };
}
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as never) ?? null,
    run: async () => db.prepare(sql).run(...(args as never[])),
  });
  return { exec: async (s: string) => void db.exec(s), prepare: (s: string) => stmt(s), batch: async (xs: { run(): Promise<unknown> }[]) => { for (const x of xs) await x.run(); return []; } } as unknown as D1Database;
}

let clock = 1_000_000;
function setup(mod: Record<string, unknown>, env: CacheEnv = {}) {
  const cache = fakeCache();
  let renders = 0;
  const route = createCacheRoute({ cache: () => cache, now: () => clock, dev: false })(mod as never, async (c) => { renders++; c.set("cflData", { id: c.req.param("id") }); return new Response(`render ${renders}`, { headers: { "content-type": "text/html" } }); });
  const app = new Hono<{ Bindings: CacheEnv }>().get("/p/:id", route);
  const bg: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void bg.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") => {
    const r = await app.request("http://t.example" + path, { headers, method }, env, ctx);
    const body = await r.text();
    await Promise.all(bg.splice(0));
    return { r, body, status: r.headers.get("x-cf-lite-cache") };
  };
  return { get, cache, renders: () => renders };
}

describe("normalizeUrl", () => {
  it("strips tracking params, sorts, drops the hash", () => {
    expect(normalizeUrl("https://a.example/p?utm_source=x&b=2&a=1&fbclid=z&UTM_medium=m#frag").search).toBe("?a=1&b=2");
    expect(normalizeUrl("https://a.example/p?b=2&a=1").href).toBe(normalizeUrl("https://a.example/p?a=1&b=2").href);
  });
  it("ignoreParams adds, keepParams is an allow-list, __cflv can't be injected", () => {
    expect(normalizeUrl("https://a.example/p?x_1=1&y=2", { ignoreParams: ["x_*"] }).search).toBe("?y=2");
    expect(normalizeUrl("https://a.example/p?page=2&y=2&utm_source=a", { keepParams: ["page"] }).search).toBe("?page=2");
    expect(normalizeUrl("https://a.example/p?__cflv=evil").search).toBe("");
  });
});

describe("tags", () => {
  it("cleanTags validates", () => {
    expect(cleanTags([" a ", "a", "", "x,y", "b"])).toEqual(["a", "b"]);
    expect(() => cleanTags(["x,y"], true)).toThrow(/invalid tag/);
    expect(() => cleanTags(["a".repeat(129)], true)).toThrow();
  });
  it("pathTag normalises", () => {
    expect(pathTag("/posts/1/")).toBe("path:/posts/1");
    expect(pathTag("https://x.example/posts/1?a=b")).toBe("path:/posts/1");
    expect(pathTag("/")).toBe("path:/");
  });
  it("tagStoreFor picks kv/d1 and honours CF_CACHE_STORE", () => {
    const kv = fakeKv(), db = fakeD1();
    expect(tagStoreFor({})).toBeNull();
    const a = tagStoreFor({ CF_CACHE_TAGS: kv, CF_CACHE_DB: db }), b = tagStoreFor({ CF_CACHE_TAGS: kv, CF_CACHE_DB: db, CF_CACHE_STORE: "d1" });
    expect(a).toBe(tagStoreFor({ CF_CACHE_TAGS: kv })); expect(b).toBe(tagStoreFor({ CF_CACHE_DB: db })); expect(a).not.toBe(b);
  });
  for (const [name, mk] of [["kv", () => kvStore(fakeKv())], ["d1", () => d1Store(fakeD1())]] as const) {
    it(`${name} ledger: max of purged tags, 0 when never purged`, async () => {
      const s = mk();
      expect(await s.maxPurged(["a", "b"])).toBe(0);
      await s.purge(["a"], 100); await s.purge(["b"], 50); await s.purge(["a"], 70); // never moves backwards (d1) / last write (kv)
      expect(await s.maxPurged(["b"])).toBe(50);
      expect(await s.maxPurged(["c", "b"])).toBe(50);
      expect(await s.maxPurged(["a"])).toBeGreaterThanOrEqual(70);
    });
  }
  it("purgeTags fails loudly with no store", async () => {
    await expect(purgeTags({}, ["a"])).rejects.toThrow(/no tag store/);
    await expect(purgeTags({ CF_CACHE_TAGS: fakeKv() }, [])).rejects.toThrow(/at least one/);
  });
});

describe("cacheRoute", () => {
  const mod = { cache: { maxAge: 10, swr: 30, tags: ["posts"] } };
  it("miss -> hit -> stale (+background revalidate) -> hit(new) -> expired -> miss", async () => {
    const t = setup(mod);
    let x = await t.get("/p/1"); expect([x.status, x.body]).toEqual(["MISS", "render 1"]);
    expect(x.r.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=10, stale-while-revalidate=30");
    clock += 5000; x = await t.get("/p/1"); expect([x.status, x.body, x.r.headers.get("age")]).toEqual(["HIT", "render 1", "5"]);
    clock += 10_000; x = await t.get("/p/1"); expect([x.status, x.body]).toEqual(["STALE", "render 1"]); // served stale, refreshed in bg
    expect(t.renders()).toBe(2);
    x = await t.get("/p/1"); expect([x.status, x.body]).toEqual(["HIT", "render 2"]);
    clock += 100_000; x = await t.get("/p/1"); expect([x.status, x.body]).toEqual(["MISS", "render 3"]);
    expect([...x.r.headers.keys()].filter((k) => k.startsWith("x-cfl-"))).toEqual([]);
  });
  it("one revalidation per key for concurrent stale requests", async () => {
    const t = setup(mod);
    await t.get("/p/2"); clock += 15_000;
    const [a, b] = await Promise.all([t.get("/p/2"), t.get("/p/2")]);
    expect([a.status, b.status]).toEqual(["STALE", "STALE"]); expect(t.renders()).toBe(2);
  });
  it("tracking params share an entry; real params and vary headers split it", async () => {
    const t = setup({ cache: { maxAge: 10, vary: ["accept-language"] } });
    await t.get("/p/1?utm_source=a&q=1");
    expect((await t.get("/p/1?q=1&fbclid=z")).status).toBe("HIT");
    expect((await t.get("/p/1?q=2")).status).toBe("MISS");
    expect((await t.get("/p/1?q=1", { "accept-language": "fr" })).status).toBe("MISS");
    const again = await t.get("/p/1?q=1", { "accept-language": "FR " });
    expect([again.status, again.r.headers.get("vary")]).toEqual(["HIT", "accept-language"]);
    expect((await t.get("/p/1?q=1", { "x-other": "1" })).status).toBe("HIT"); // unlisted headers never affect the key
  });
  it("the session module's cookies (session, __Host-session) count as auth by default", async () => {
    const t = setup({ cache: { maxAge: 10 } });
    await t.get("/p/1");
    expect((await t.get("/p/1", { cookie: "session=abc" })).status).toBe("BYPASS");
    expect((await t.get("/p/1", { cookie: "__Host-session=abc" })).status).toBe("BYPASS");
    expect(t.renders()).toBe(3);
  });
  it("never caches a response that carries a per-request CSP nonce (a replayed nonce would not match the new policy)", async () => {
    const cache = fakeCache();
    let renders = 0;
    const route = createCacheRoute({ cache: () => cache, now: () => clock, dev: false })({ cache: { maxAge: 10 } } as never, async () => { renders++; return new Response("<script nonce=x>1</script>", { headers: { "content-type": "text/html" } }); });
    const app = new Hono().use("*", async (c, next) => { c.set("cspNonce", "n" + renders); await next(); }).get("/p", route);
    const r1 = await app.request("http://t.example/p"), r2 = await app.request("http://t.example/p");
    expect([r1.headers.get("x-cf-lite-cache"), r2.headers.get("x-cf-lite-cache"), renders, (cache as any).m.size]).toEqual(["BYPASS", "BYPASS", 2, 0]);
    expect(r2.headers.get("x-cf-lite-cache-why")).toBe("csp-nonce");
  });
  it("auth cookie / Authorization bypass: no read, no write; allowAuthenticated opts out", async () => {
    const t = setup(mod);
    await t.get("/p/1");
    let x = await t.get("/p/1", { cookie: "a=1; sso=tok" });
    expect([x.status, x.body, x.r.headers.get("cache-control")]).toEqual(["BYPASS", "render 2", "private, no-cache"]);
    expect((await t.get("/p/1", { authorization: "Bearer x" })).status).toBe("BYPASS");
    expect((await t.get("/p/1", { cookie: "theme=dark" })).status).toBe("HIT"); // non-auth cookies don't bypass
    const t2 = setup(mod, { SSO_COOKIE_NAME: "sid" });
    expect((await t2.get("/p/1", { cookie: "sso=x" })).status).toBe("MISS");
    expect((await t2.get("/p/1", { cookie: "sid=x" })).status).toBe("BYPASS");
    const t3 = setup({ cache: { maxAge: 10, authCookies: ["session"] } });
    expect((await t3.get("/p/1", { cookie: "session=1" })).status).toBe("BYPASS");
    const t4 = setup({ cache: { maxAge: 10, allowAuthenticated: true } });
    await t4.get("/p/1"); expect((await t4.get("/p/1", { cookie: "sso=x" })).status).toBe("HIT");
    x = await setup(mod).get("/p/1", {}, "HEAD"); expect(x.status).toBe("BYPASS");
  });
  it("tag purge invalidates across 'colos' (entry in cache, ledger elsewhere); path purge too; fail-safe on store error", async () => {
    for (const store of [{ CF_CACHE_TAGS: fakeKv() }, { CF_CACHE_DB: fakeD1() }] as CacheEnv[]) {
      const t = setup(mod, store);
      await t.get("/p/1"); await t.get("/p/2");
      expect((await t.get("/p/1")).status).toBe("HIT");
      clock += 1; await purgeTags(store, ["posts"], clock); clock += 1;
      expect([(await t.get("/p/1")).status, (await t.get("/p/2")).status]).toEqual(["MISS", "MISS"]);
      expect((await t.get("/p/1")).status).toBe("HIT"); // re-rendered entries are newer than the purge
      clock += 1; await purgePaths(store, ["/p/1/"], clock); clock += 1;
      expect([(await t.get("/p/1?q=1")).status, (await t.get("/p/2")).status]).toEqual(["MISS", "HIT"]);
    }
    const bad = { CF_CACHE_TAGS: { get: async () => { throw new Error("kv down"); } } } as unknown as CacheEnv;
    const t = setup(mod, bad); vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.get("/p/1"); expect((await t.get("/p/1")).status).toBe("MISS"); // can't prove freshness -> render
  });
  it("function form sees params + loader data, may opt out; bad policies are not cached", async () => {
    const seen: unknown[] = [];
    const t = setup({ cache: ({ params, data }: never) => { seen.push([params, data]); return params === undefined ? false : (params as { id: string }).id === "no" ? false : { maxAge: 10, tags: [`p:${(params as { id: string }).id}`] }; } });
    expect((await t.get("/p/7")).status).toBe("MISS"); expect(seen[0]).toEqual([{ id: "7" }, { id: "7" }]);
    expect((await t.get("/p/7")).status).toBe("HIT");
    expect((await t.get("/p/no")).status).toBe("BYPASS"); expect((await t.get("/p/no")).status).toBe("BYPASS");
    const z = setup({ cache: { maxAge: 0 } }); await z.get("/p/1"); expect((await z.get("/p/1")).status).toBe("BYPASS");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const th = setup({ cache: () => { throw new Error("boom"); } }); expect((await th.get("/p/1")).body).toBe("render 1");
  });
  it("never stores Set-Cookie / non-200 / private responses", async () => {
    for (const init of [{ headers: { "set-cookie": "a=b" } }, { status: 404 }, { headers: { "cache-control": "private" } }]) {
      const cache = fakeCache();
      const app = new Hono().get("/x", createCacheRoute({ cache: () => cache, now: () => clock, dev: false })({ cache: { maxAge: 10 } }, () => new Response("x", init)));
      const r = await app.request("http://t.example/x"); await r.text();
      expect(r.headers.get("x-cf-lite-cache")).toBe("BYPASS");
      expect(cache.m.size).toBe(0);
    }
  });
  it("dev bypasses entirely", async () => {
    const cache = fakeCache();
    const app = new Hono().get("/x", createCacheRoute({ cache: () => cache, now: () => clock, dev: true })({ cache: { maxAge: 10 } }, () => new Response("x")));
    expect((await app.request("http://t.example/x")).headers.get("x-cf-lite-cache")).toBe("BYPASS");
  });
});

describe("cachePurge endpoint", () => {
  const mk = (env: CacheEnv) => {
    const app = new Hono<{ Bindings: CacheEnv }>().post("/purge", cachePurge());
    return (init: RequestInit) => app.request("/purge", { method: "POST", ...init }, env);
  };
  const auth = { authorization: "Bearer s3cret", "content-type": "application/json" };
  it("fails closed without a configured token", async () => {
    const kv = fakeKv();
    expect((await mk({ CF_CACHE_TAGS: kv })({ headers: auth, body: "{}" })).status).toBe(503);
    expect(kv.m.size).toBe(0);
  });
  it("rejects missing/wrong tokens and GET", async () => {
    const kv = fakeKv(), post = mk({ CF_CACHE_TAGS: kv, CACHE_PURGE_TOKEN: "s3cret" });
    expect((await post({ body: JSON.stringify({ tags: ["a"] }) })).status).toBe(401);
    expect((await post({ headers: { authorization: "Bearer nope" }, body: JSON.stringify({ tags: ["a"] }) })).status).toBe(401);
    expect((await post({ headers: { authorization: "s3cret" }, body: JSON.stringify({ tags: ["a"] }) })).status).toBe(401);
    const app = new Hono<{ Bindings: CacheEnv }>().post("/purge", cachePurge());
    expect((await app.request("/purge", { method: "GET", headers: auth }, { CACHE_PURGE_TOKEN: "s3cret" })).status).toBe(404);
    expect(kv.m.size).toBe(0);
  });
  it("purges tags + paths, validates input", async () => {
    const kv = fakeKv(), post = mk({ CF_CACHE_TAGS: kv, CACHE_PURGE_TOKEN: "s3cret" });
    const r = await post({ headers: auth, body: JSON.stringify({ tags: ["posts"], paths: ["/a/"] }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, tags: ["posts", "path:/a"] });
    expect([...kv.m.keys()].sort()).toEqual(["cfl:tag:path:/a", "cfl:tag:posts"]);
    expect((await post({ headers: auth, body: "nope" })).status).toBe(400);
    expect((await post({ headers: auth, body: JSON.stringify({ tags: ["a,b"] }) })).status).toBe(400);
    expect((await post({ headers: auth, body: JSON.stringify({ paths: ["nope"] }) })).status).toBe(400);
    expect((await post({ headers: auth, body: JSON.stringify({}) })).status).toBe(400);
    expect((await mk({ CACHE_PURGE_TOKEN: "s3cret" })({ headers: auth, body: JSON.stringify({ tags: ["a"] }) })).status).toBe(503);
  });
});

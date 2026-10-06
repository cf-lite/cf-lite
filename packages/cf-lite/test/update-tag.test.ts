import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createCacheRoute, hasUpdateCookie, updateCookieHeader, updatePath, updateTag, UPDATE_WINDOW_S, type CacheEnv } from "../src/modules/cache.js";

function fakeCache() {
  const m = new Map<string, { status: number; headers: [string, string][]; body: string }>();
  return { m, async match(k: Request) { const e = m.get(k.url); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined; }, async put(k: Request, r: Response) { m.set(k.url, { status: r.status, headers: [...r.headers], body: await r.text() }); } } as unknown as Cache & { m: Map<string, unknown> };
}
const fakeKv = () => { const m = new Map<string, string>(); return { m, get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace & { m: Map<string, string> }; };

describe("hasUpdateCookie", () => {
  const req = (cookie: string) => new Request("http://t/", { headers: { cookie } });
  it("fresh cookie only", () => {
    const now = 1_700_000_000_000;
    expect(hasUpdateCookie(req(`a=1; __cfl_upd=${now - 1000}`), now)).toBe(true);
    expect(hasUpdateCookie(req(`__cfl_upd=${now - UPDATE_WINDOW_S * 1000 - 1}`), now)).toBe(false); // expired
    expect(hasUpdateCookie(req(`__cfl_upd=${now + 3_600_000}`), now)).toBe(false); // far-future: not a way to bypass forever
    expect(hasUpdateCookie(req("__cfl_upd=abc"), now)).toBe(false);
    expect(hasUpdateCookie(req("x__cfl_upd=" + now), now)).toBe(false);
    expect(hasUpdateCookie(new Request("http://t/"), now)).toBe(false);
  });
  it("cookie line: HttpOnly, Lax, Secure only on https", () => {
    expect(updateCookieHeader("https://a.example/x", 5)).toBe(`__cfl_upd=5; Path=/; Max-Age=${UPDATE_WINDOW_S}; HttpOnly; SameSite=Lax; Secure`);
    expect(updateCookieHeader("http://localhost:8787/x", 5)).not.toContain("Secure");
  });
});

describe("updateTag: read-your-writes", () => {
  let clock = Date.now();
  function app() {
    const cache = fakeCache(), kv = fakeKv();
    let renders = 0;
    const route = createCacheRoute({ cache: () => cache, now: () => clock, dev: false })({ cache: { maxAge: 600, tags: ["posts"] } } as never, async () => new Response(`render ${++renders}`, { headers: { "content-type": "text/html" } }));
    const a = new Hono<{ Bindings: CacheEnv }>()
      .get("/p", route)
      .post("/save", async (c) => { await updateTag(c, "posts"); return c.redirect("/p", 303); })
      .post("/save-path", async (c) => { await updatePath(c, "/p"); return c.body(null, 204); });
    const env: CacheEnv = { CF_CACHE_TAGS: kv };
    const go = (path: string, init: RequestInit = {}) => a.request("http://t.example" + path, init, env);
    return { go, renders: () => renders };
  }

  it("the action response carries the cookie; the writer's next GET bypasses the cache, others keep getting the entry", async () => {
    const t = app();
    expect(await (await t.go("/p")).text()).toBe("render 1");
    expect((await t.go("/p")).headers.get("x-cf-lite-cache")).toBe("HIT");
    clock += 10;
    const save = await t.go("/save", { method: "POST" });
    const cookie = save.headers.get("set-cookie")!;
    expect(save.status).toBe(303); expect(cookie).toMatch(/^__cfl_upd=\d+; Path=\//);
    const mine = await t.go("/p", { headers: { cookie: cookie.split(";")[0] } });
    expect(mine.headers.get("x-cf-lite-cache")).toBe("BYPASS"); expect(mine.headers.get("x-cf-lite-cache-why")).toBe("updated");
    expect(mine.headers.get("cache-control")).toBe("private, no-cache");
    expect(await mine.text()).toBe("render 2");
    // another visitor: entry was expired by the tag purge -> re-render (MISS), stored again
    const other = await t.go("/p");
    expect(other.headers.get("x-cf-lite-cache")).toBe("MISS");
  });
  it("after the window the writer is cached like everybody else", async () => {
    const t = app();
    await t.go("/p");
    const save = await t.go("/save", { method: "POST" });
    const c = save.headers.get("set-cookie")!.split(";")[0];
    clock += UPDATE_WINDOW_S * 1000 + 5000;
    const late = await t.go("/p", { headers: { cookie: c } });
    expect(late.headers.get("x-cf-lite-cache-why")).toBeNull(); expect(late.headers.get("x-cf-lite-cache")).toBe("MISS");
  });
  it("updatePath purges the path tag and sets the cookie; without a tag store it throws (nothing silently skipped)", async () => {
    const t = app();
    await t.go("/p");
    const r = await t.go("/save-path", { method: "POST" });
    expect(r.status).toBe(204); expect(r.headers.get("set-cookie")).toContain("__cfl_upd=");
    const a = new Hono<{ Bindings: CacheEnv }>().post("/x", async (c) => { await updateTag(c, "t"); return c.text("ok"); });
    const res = await a.request("http://t/x", { method: "POST" }, {});
    expect(res.status).toBe(500);
  });
});

describe("updateTag: ISR bypass", () => {
  it("a fresh update cookie makes isr() render through the page without touching R2", async () => {
    const { createIsr } = await import("../src/modules/isr.js");
    const isr = createIsr({ now: () => Date.now() });
    const app = new Hono<any>().get("/p", isr({ maxAge: 60 }), (c) => c.text("live"));
    const bucket = { get: async () => { throw new Error("R2 must not be read"); }, put: async () => { throw new Error("R2 must not be written"); } };
    const r = await app.request("http://t.example/p", { headers: { cookie: `__cfl_upd=${Date.now()}` } }, { ISR_BUCKET: bucket });
    expect(r.status).toBe(200); expect(await r.text()).toBe("live");
    expect(r.headers.get("x-cf-lite-isr-why")).toBe("updated"); expect(r.headers.get("cache-control")).toBe("private, no-cache");
  });
});

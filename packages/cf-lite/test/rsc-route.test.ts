// modules/rsc.ts (the Worker-side route handler) under vitest: the plugin-rsc virtual modules are replaced by a fake rsc environment
// (`globalThis.__viteRsc`, see vitest.config.ts) and a fake Flight client; React's real renderToReadableStream + rsc-html-stream do the HTML.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createElement } from "react";

vi.mock("@vitejs/plugin-rsc/ssr", () => ({
  // the fake "Flight" stream is JSON `{ text }`; BOOM makes the shell throw
  createFromReadableStream: async (s: ReadableStream<Uint8Array>) => {
    const { text } = JSON.parse(await new Response(s).text()) as { text: string };
    if (text === "BOOM") throw Object.assign(new Error("shell failed"), { digest: "d-boom" });
    if (text === "NF") throw Object.assign(new Error("nf"), { digest: "CFL_NOT_FOUND" });
    return { root: createElement("html", null, createElement("body", null, createElement("main", { id: "m" }, text))) };
  },
}));
// cache.ts bypasses everything when `import.meta.env.DEV` (always true under vitest): rebuild cacheRoute with an explicit non-dev dependency set
vi.mock("../src/modules/cache.js", async (orig) => { const o = await orig<typeof import("../src/modules/cache.js")>(); return { ...o, cacheRoute: o.createCacheRoute({ cache: () => (globalThis as any).caches.default, now: () => Date.now(), dev: false }) }; });
import * as rscMod from "../src/modules/rsc.js";
import { notFound, redirect } from "../src/navigation.js";

const enc = (text: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ text }))); c.close(); } });
type Fake = { flight: ReturnType<typeof vi.fn>; config: ReturnType<typeof vi.fn>; action: ReturnType<typeof vi.fn> };
let fake: Fake;
beforeEach(() => {
  fake = {
    flight: vi.fn(async (_p: string, params: Record<string, string>, _u: string, _r: unknown, mode?: string) => ({ stream: enc(mode === "error" ? "ERR-PAGE" : mode === "not-found" ? "NF-PAGE" : "hello " + (params.id ?? "")), data: { mode } })),
    config: vi.fn(async () => ({ actions: ["a#go"] })),
    action: vi.fn(async () => "ok"),
  };
  (globalThis as any).__viteRsc = { loadModule: async () => fake, loadBootstrapScriptContent: async () => "boot()" };
  vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); delete (globalThis as any).__viteRsc; });

const mk = (opts: Parameters<typeof rscMod.rscRoute>[0], pre?: (a: Hono) => void) => { const a = new Hono(); pre?.(a); a.get("/p/:id", rscMod.rscRoute(opts)); a.post("/p/:id", rscMod.rscActionRoute(opts)); return a; };

describe("rscRoute", () => {
  it("renders HTML with the bootstrap script and the Flight payload inlined", async () => {
    const r = await mk({ path: "/p/:id" }).request("/p/7");
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const t = await r.text();
    expect(t).toContain('<main id="m">hello 7</main>'); expect(t).toContain("boot()"); expect(t).toContain("__FLIGHT_DATA");
    expect(fake.flight.mock.calls[0][1]).toEqual({ id: "7" });
  });
  it("`?__rsc` returns the raw payload", async () => {
    const r = await mk({ path: "/p/:id" }).request("/p/7?__rsc");
    expect(r.headers.get("content-type")).toMatch(/text\/x-component/); expect(r.headers.get("vary")).toBe("accept");
    expect(JSON.parse(await r.text())).toEqual({ text: "hello 7" });
  });
  it("js:false = pure server page: no bootstrap, no inline payload", async () => {
    const t = await (await mk({ path: "/p/:id", js: false }).request("/p/1")).text();
    expect(t).toContain("hello 1"); expect(t).not.toMatch(/boot\(\)|__FLIGHT_DATA/);
  });
  it("stamps the security() nonce on the bootstrap and the Flight scripts", async () => {
    const t = await (await mk({ path: "/p/:id" }, (a) => a.use(async (c, n) => { c.set("cspNonce", "N0NCE"); await n(); })).request("/p/1")).text();
    expect(t).toMatch(/<script[^>]*nonce="N0NCE"[^>]*>boot\(\)/); expect(t).toMatch(/__FLIGHT_DATA[\s\S]*nonce|nonce="N0NCE"[^>]*>\(self\.__FLIGHT_DATA/);
  });
  it("passes digest, env and ExecutionContext-less requests through", async () => {
    await mk({ path: "/p/:id" }).request("/p/1", {}, { GREETING: "x" });
    const rctx = fake.flight.mock.calls[0][3];
    expect(rctx.env).toEqual({ GREETING: "x" }); expect(typeof rctx.digest).toBe("string"); expect(rctx.ctx).toBeUndefined();
  });
  it("forwards the verified draft state to the rsc environment", async () => {
    await mk({ path: "/p/:id" }, (a) => a.use(async (c, n) => { c.set("draft", { exp: 1 }); await n(); })).request("/p/1");
    expect(fake.flight.mock.calls[0][3].draft).toEqual({ exp: 1 });
  });
  it("a thrown notFound() before the first byte = real 404 through the not-found boundary page", async () => {
    fake.flight.mockImplementationOnce(async () => { notFound(); });
    const r = await mk({ path: "/p/:id" }).request("/p/1");
    expect(r.status).toBe(404); expect(await r.text()).toContain("NF-PAGE"); expect(fake.flight.mock.calls[1][4]).toBe("not-found");
  });
  it("a redirect() = 3xx with the location, no body render", async () => {
    fake.flight.mockImplementationOnce(async () => { redirect("/to", 301); });
    const r = await mk({ path: "/p/:id" }).request("/p/1", { redirect: "manual" });
    expect(r.status).toBe(301); expect(r.headers.get("location")).toBe("/to");
  });
  it("a shell error = 500 through the error boundary page, and is logged with the digest", async () => {
    fake.flight.mockImplementationOnce(async () => ({ stream: enc("BOOM"), data: undefined }));
    const r = await mk({ path: "/p/:id" }).request("/p/1");
    expect(r.status).toBe(500); expect(await r.text()).toContain("ERR-PAGE"); expect(console.error).toHaveBeenCalled();
  });
  it("a digest-only not-found from the shell (Flight client error) is a 404", async () => {
    fake.flight.mockImplementationOnce(async () => ({ stream: enc("NF"), data: undefined }));
    expect((await mk({ path: "/p/:id" }).request("/p/1")).status).toBe(404);
  });
  it("when the boundary page itself fails: plain-text fallbacks (500 / 404)", async () => {
    fake.flight.mockImplementation(async () => { throw new Error("always"); });
    const r = await mk({ path: "/p/:id" }).request("/p/1"); expect(r.status).toBe(500); expect(r.headers.get("content-type")).toMatch(/text\/plain/); expect(await r.text()).toMatch(/Internal Server Error \(digest /);
    fake.flight.mockImplementation(async () => { notFound(); });
    const n = await mk({ path: "/p/:id" }).request("/p/1"); expect(n.status).toBe(404); expect(await n.text()).toBe("Not Found");
  });
});

describe("rscRoute cache / isr wrapping", () => {
  beforeEach(() => {
    const store = new Map<string, { status: number; headers: [string, string][]; body: string }>();
    (globalThis as any).caches = { default: {
      async match(k: Request) { const e = store.get(k.url); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined; },
      async put(k: Request, r: Response) { store.set(k.url, { status: r.status, headers: [...r.headers], body: await r.text() }); },
    } };
  });
  afterEach(() => { delete (globalThis as any).caches; });
  it("cache: reads the page `cache` export once, HIT on the second request, and `__rsc` is a separate key", async () => {
    fake.config.mockResolvedValue({ cache: { maxAge: 60 }, actions: [] });
    const a = mk({ path: "/p/:id", cache: true });
    const get = (u: string, i?: RequestInit, env?: object) => a.request(u, i, env);
    const r1 = await get("/p/1", {}, {}); await new Promise((r) => setTimeout(r, 30)); const r2 = await get("/p/1", {}, {}), f1 = await get("/p/1?__rsc", {}, {});
    expect(r1.headers.get("x-cf-lite-cache-why")).toBeNull(); expect(r1.headers.get("x-cf-lite-cache")).toBe("MISS"); expect(r2.headers.get("x-cf-lite-cache")).toBe("HIT"); expect(f1.headers.get("x-cf-lite-cache")).toBe("MISS");
    expect(fake.config).toHaveBeenCalledTimes(1);
  });
  it("a failing config() is retried on the next request (not cached as a rejection)", async () => {
    fake.config.mockRejectedValueOnce(new Error("cfg")).mockResolvedValue({ cache: { maxAge: 60 }, actions: [] });
    const a = mk({ path: "/p/:id", cache: true }); a.onError((_e, c) => c.text("err", 500));
    expect((await a.request("/p/1")).status).toBe(500);
    expect((await a.request("/p/1")).status).toBe(200);
  });
  it("isr without an R2 binding degrades to a bypass (still renders)", async () => {
    fake.config.mockResolvedValue({ isr: { maxAge: 60 }, actions: [] });
    const r = await mk({ path: "/p/:id", isr: true }).request("/p/1", {}, {});
    expect(r.status).toBe(200); expect(r.headers.get("x-cf-lite-isr")).toBe("BYPASS");
  });
});

describe("rscActionRoute", () => {
  const post = (a: Hono, body: FormData | string, headers: Record<string, string> = {}, url = "/p/1") => a.request(url, { method: "POST", body, headers: { origin: "http://localhost", ...headers } });
  const form = (id = "a#go", extra: Record<string, string> = {}) => { const f = new FormData(); f.set("$ACTION_ID_" + id, ""); for (const [k, v] of Object.entries(extra)) f.set(k, v); return f; };

  it("runs a registered action and answers 303 back to the page (PRG)", async () => {
    const r = await post(mk({ path: "/p/:id" }), form("a#go", { name: "x" }));
    expect(r.status).toBe(303); expect(r.headers.get("location")).toBe("/p/1");
    expect(fake.action).toHaveBeenCalledTimes(1);
    const [, , , , id, fd] = fake.action.mock.calls[0]; expect(id).toBe("a#go"); expect(fd.get("name")).toBe("x"); expect(fd.has("$ACTION_ID_a#go")).toBe(false);
  });
  it("with Accept: text/x-component it returns the re-rendered payload", async () => {
    const r = await post(mk({ path: "/p/:id" }), form(), { accept: "text/x-component" });
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toMatch(/text\/x-component/);
  });
  it("refuses: wrong method / cross-site / content type / too large / not in allowlist / unknown id", async () => {
    const a = mk({ path: "/p/:id" });
    expect((await a.request("/p/1", { method: "POST", body: form(), headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await post(a, "x=1", { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(a, form("zzz#nope"))).status).toBe(400); // not in this route's allowlist
    fake.action.mockResolvedValueOnce("unknown");
    expect((await post(a, form())).status).toBe(400);
    fake.config.mockResolvedValue({ actions: ["a#go"], actionMaxBytes: 10 });
    expect((await post(a, form("a#go", { big: "x".repeat(200) }))).status).toBe(413);
    fake.config.mockResolvedValue({ actions: ["a#go"] });
    expect((await post(a, new FormData())).status).toBe(400); // no action id at all
  });
  it("actionGuard: false = 429, a Response is returned as is, a throw = 500", async () => {
    const a = mk({ path: "/p/:id" });
    fake.config.mockResolvedValue({ actions: ["a#go"], actionGuard: () => false });
    const r = await post(a, form()); expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("60");
    fake.config.mockResolvedValue({ actions: ["a#go"], actionGuard: () => new Response("nope", { status: 401 }) });
    expect((await post(a, form())).status).toBe(401);
    fake.config.mockResolvedValue({ actions: ["a#go"], actionGuard: () => { throw new Error("g"); } });
    expect((await post(a, form())).status).toBe(500);
    expect(fake.action).not.toHaveBeenCalled();
  });
  it("a redirect() inside the action: 303 (no-JS) or `x-cf-lite-redirect` (client router)", async () => {
    const a = mk({ path: "/p/:id" });
    fake.action.mockImplementation(async () => { redirect("/done"); });
    const r = await post(a, form()); expect(r.status).toBe(303); expect(r.headers.get("location")).toBe("/done");
    const f = await post(a, form(), { accept: "text/x-component" }); expect(f.status).toBe(200); expect(f.headers.get("x-cf-lite-redirect")).toBe("/done");
  });
  it("notFound() inside the action = 404 page; any other throw = 500 page + report hook", async () => {
    const a = mk({ path: "/p/:id" }), report = vi.fn();
    (globalThis as any)[Symbol.for("cf-lite.report")] = report;
    fake.action.mockImplementation(async () => { notFound(); });
    expect((await post(a, form())).status).toBe(404);
    fake.action.mockImplementation(async () => { throw new Error("boom"); });
    expect((await post(a, form())).status).toBe(500); expect(report).toHaveBeenCalled();
    delete (globalThis as any)[Symbol.for("cf-lite.report")];
  });
  it("a failing post-action re-render is a 500 (not a 200 text)", async () => {
    const a = mk({ path: "/p/:id" });
    let n = 0;
    fake.flight.mockImplementation(async (_p: string, _a: unknown, _u: string, _r: unknown, mode?: string) => { if (mode === "page") { n++; throw new Error("render"); } return { stream: enc("ERR-PAGE"), data: undefined }; });
    const r = await post(a, form(), { accept: "text/x-component" });
    expect(r.status).toBe(500); expect(n).toBe(1);
  });
});

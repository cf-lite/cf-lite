import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { scanPages } from "../src/scan.js";
import { generate } from "../src/vite.js";
import { updateTag } from "../src/modules/rsc-update.js";
import { digestOf, signalOf, NOT_FOUND_DIGEST } from "../src/modules/rsc-digest.js";
import { createRsc, getRequest, headElements, notFound, redirect } from "../src/modules/rsc-server.js";
import { createCacheRoute, purgeTags, kvStore } from "../src/modules/cache.js";

const ui = { id: "x", extensions: [".tsx"], client: "x/client", server: "x/server", vite: () => ({ plugins: [] }) };
const RSC = 'export const render = "rsc"; export default () => null';
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cflite-rsc2-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), c); }
  return root;
}

describe("rsc conventions (scan)", () => {
  const root = project({
    "app/routes/_layout.tsx": "export default () => null", // client-style: NOT applied to rsc routes
    "app/routes/_layout.rsc.tsx": "export default () => null",
    "app/routes/_error.rsc.tsx": '"use client"; export default () => null',
    "app/routes/a/_layout.rsc.tsx": "export default () => null",
    "app/routes/a/_not-found.rsc.tsx": "export default () => null",
    "app/routes/a/b.tsx": RSC,
    "app/routes/c.tsx": RSC,
    "app/routes/s.tsx": 'export const render = "ssr"; export default () => null',
  });
  const pages = scanPages(root, "app/routes", [".tsx"]);
  it("*.rsc.tsx convention files are never routes", () => expect(pages.map((p) => p.path).sort()).toEqual(["/a/b", "/c", "/s"]));
  it("layouts chain outer -> inner, error / not-found nearest wins", () => {
    const b = pages.find((p) => p.path === "/a/b")!, c = pages.find((p) => p.path === "/c")!;
    expect(b.rscLayouts).toEqual(["app/routes/_layout.rsc.tsx", "app/routes/a/_layout.rsc.tsx"]);
    expect(b.rscError).toBe("app/routes/_error.rsc.tsx"); expect(b.rscNotFound).toBe("app/routes/a/_not-found.rsc.tsx");
    expect(c.rscLayouts).toEqual(["app/routes/_layout.rsc.tsx"]); expect(c.rscNotFound).toBeUndefined();
  });
  it("non-rsc routes get no rsc fields (opt-out stays byte-identical)", () => {
    const s = pages.find((p) => p.path === "/s")!;
    expect(Object.keys(s).some((k) => k.startsWith("rsc"))).toBe(false);
    expect(s.layouts).toEqual(["app/routes/_layout.tsx"]);
  });
  it("cache / isr are allowed on rsc routes, actions are not", () => {
    expect(() => scanPages(project({ "app/routes/c.tsx": RSC + "; export const cache = { maxAge: 5 }; export const isr = { maxAge: 5 }" }), "app/routes", [".tsx"])).not.toThrow();
    expect(() => scanPages(project({ "app/routes/c.tsx": RSC + "; export const actions = {}" }), "app/routes", [".tsx"])).toThrow(/actions/);
  });
  it("generated entry: layouts, boundaries, boundary file; cache/isr flags reach rscRoute", () => {
    const r = project({ "app/routes/_layout.rsc.tsx": "export default () => null", "app/routes/_not-found.rsc.tsx": "export default () => null", "app/routes/c.tsx": RSC + "; export const cache = { maxAge: 5 }; export const isr = { maxAge: 5 }" });
    const g = generate(r, ui as never);
    const e = readFileSync(join(r, ".cf-lite/rsc-entry.tsx"), "utf8");
    expect(e).toContain("cf-lite/modules/rsc-server"); expect(e).toContain("_layout.rsc"); expect(e).toContain("notFound: () => import(");
    expect(e).not.toContain("error: () =>");
    expect(readFileSync(join(r, ".cf-lite/rsc-boundary.tsx"), "utf8")).toMatch(/^[^"]*"use client"/);
    expect(g.files["app.ts"]).toContain('rscRoute({ path: "/c", cache: true, isr: true })');
  });
});

describe("digests carry notFound / redirect across Flight", () => {
  it("round trips", () => {
    let nf: unknown, rd: unknown;
    try { notFound(); } catch (e) { nf = e; }
    try { redirect("/x;y", 308); } catch (e) { rd = e; }
    expect(digestOf(nf)).toBe(NOT_FOUND_DIGEST);
    expect(signalOf({ digest: digestOf(nf) })).toEqual({ kind: "not-found" });
    expect(signalOf({ digest: digestOf(rd) })).toEqual({ kind: "redirect", status: 308, url: "/x;y" });
    expect(signalOf(rd)).toEqual({ kind: "redirect", status: 308, url: "/x;y" });
    expect(digestOf(new Error("x"))).toBeUndefined();
    expect(signalOf({ digest: "CFL_REDIRECT;200;/x" })).toBeUndefined(); // only real redirect statuses
    expect(signalOf({ digest: "abc" })).toBeUndefined();
  });
});

describe("createRsc (server-component side)", () => {
  const mod = (extra: object = {}) => async () => ({ default: function Page() { return null; }, ...extra });
  const rctx = { env: { GREETING: "hi" }, req: new Request("http://t/p/7?x=1"), digest: "d1" };
  function setup(routes: Record<string, any>) {
    let model: any, store: any;
    const rsc = createRsc({ render: (m) => { model = m; store = getRequest(); return new ReadableStream(); }, Boundary: "Boundary", routes });
    return { rsc, model: () => model, store: () => store };
  }
  const flat = (n: any): any[] => (Array.isArray(n) ? n.flatMap(flat) : n && typeof n === "object" ? [n, ...flat(n.props?.children)] : []);
  it("request-scoped context + loader data + composed layouts + merged head", async () => {
    const calls: unknown[] = [];
    const s = setup({
      "/p/:id": {
        load: mod({ loader: async (a: any) => { calls.push(a); return { id: a.params.id }; }, head: ({ data }: any) => ({ title: "t" + data.id, meta: [{ name: "a", content: "page" }] }) }),
        layouts: [mod({ head: { title: "outer", meta: [{ name: "a", content: "layout" }, { name: "b", content: "x" }], htmlAttrs: { lang: "vi" } } }), mod()],
      },
    });
    const r = await s.rsc.flight("/p/:id", { id: "7" }, "http://t/p/7?x=1", rctx);
    expect(r.data).toEqual({ id: "7" });
    expect((calls[0] as any).env).toEqual({ GREETING: "hi" });
    expect(s.store()).toMatchObject({ params: { id: "7" }, data: { id: "7" }, env: { GREETING: "hi" } });
    expect(s.store().url.pathname).toBe("/p/7");
    expect(() => getRequest()).toThrow(/outside/); // scoped: not leaking after the run
    const doc = s.model().root;
    expect(doc.type).toBe("html"); expect(doc.props.lang).toBe("vi");
    const head = flat(doc).find((n) => n.type === "head");
    const els = flat(head.props.children).filter((n: any) => typeof n.type === "string");
    expect(els.find((n: any) => n.type === "title").props.children).toBe("t7"); // page wins over layout
    expect(els.filter((n: any) => n.type === "meta" && n.props.name === "a")).toHaveLength(1);
    expect(els.find((n: any) => n.type === "meta" && n.props.name === "a").props.content).toBe("page");
    expect(els.some((n: any) => n.props.name === "b")).toBe(true);
    const root = flat(doc).find((n) => n.props?.id === "root");
    expect(root.props.children.type).toBe("Boundary");
  });
  it("loader notFound / redirect propagate as signals (before anything renders)", async () => {
    const s = setup({ "/a": { load: mod({ loader: () => notFound() }), layouts: [] }, "/b": { load: mod({ loader: () => redirect("/z", 301) }), layouts: [] } });
    await expect(s.rsc.flight("/a", {}, "http://t/a", rctx)).rejects.toMatchObject({ kind: "not-found" });
    await expect(s.rsc.flight("/b", {}, "http://t/b", rctx)).rejects.toMatchObject({ kind: "redirect", status: 301 });
    expect(s.model()).toBeUndefined();
  });
  it("not-found / error modes render the boundary (or a default) inside the layouts, without the page", async () => {
    const NF = async () => ({ default: function NFound() { return null; } });
    const s = setup({ "/a": { load: mod({ loader: () => { throw new Error("must not run"); } }), layouts: [mod()], notFound: NF } });
    await s.rsc.flight("/a", {}, "http://t/a", rctx, "not-found");
    expect(flat(s.model().root).some((n) => typeof n.type === "function" && n.type.name === "NFound")).toBe(true);
    await s.rsc.flight("/a", {}, "http://t/a", rctx, "error");
    expect(flat(s.model().root).some((n) => n.type === "h1" && n.props.children === "Something went wrong")).toBe(true);
  });
  it("config() exposes cache / cacheKey / isr of the page module", async () => {
    const cache = { maxAge: 5 };
    expect(await setup({ "/a": { load: mod({ cache, isr: { maxAge: 1 } }), layouts: [] } }).rsc.config("/a")).toMatchObject({ cache, isr: { maxAge: 1 } });
  });
  it("head -> elements maps html attrs to React props", () => {
    const els: any[] = headElements({ meta: [{ "http-equiv": "refresh", content: "1" }], link: [{ rel: "alternate", hreflang: "vi", href: "/vi" }], script: [{ content: "a</script>b" }, { src: "/x.js", strategy: "async" }] });
    expect(els[0].props.httpEquiv).toBe("refresh"); expect(els[1].props.hrefLang).toBe("vi");
    expect(els[2].props.dangerouslySetInnerHTML.__html).toBe("a<\\/script>b"); expect(els[3].props.async).toBe(true);
  });
});

describe("cache wrapper around an rsc-shaped handler: HTML + payload share tags, purge hits both", () => {
  function fakeCache() {
    const m = new Map<string, Response>();
    return { async match(r: Request) { return m.get(r.url)?.clone(); }, async put(r: Request, res: Response) { m.set(r.url, res); } } as unknown as Cache;
  }
  const kv = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace; };
  it("same policy for ?__rsc and the document; a tag purge invalidates both", async () => {
    let clock = 1_000_000, renders = 0;
    const shared = fakeCache();
    const cacheRoute = createCacheRoute({ cache: () => shared, now: () => clock, dev: false });
    const cfg = { cache: ({ data }: any) => ({ maxAge: 60, tags: ["rsc", `rsc:${data.id}`] }) }; // what rscRoute hands over from config()
    const env = { CF_CACHE_TAGS: kv() };
    const handler = cacheRoute(cfg as never, (c) => { renders++; c.set("cflData", { id: "1" }); return new Response(c.req.query("__rsc") !== undefined ? "flight" : "<html>doc", { headers: { "content-type": "text/html" } }); });
    const app = new Hono().get("/p", handler);
    const get = (q = "") => app.request("http://t/p" + q, {}, env).then((r) => r.headers.get("x-cf-lite-cache"));
    expect(await get()).toBe("MISS"); expect(await get("?__rsc")).toBe("MISS");
    expect(await get()).toBe("HIT"); expect(await get("?__rsc")).toBe("HIT");
    clock += 1000; await purgeTags(env, "rsc:1", clock); clock += 1000;
    expect(await get()).toBe("MISS"); expect(await get("?__rsc")).toBe("MISS"); expect(renders).toBe(4);
    void kvStore;
  });
});

describe("P4 review fixes", () => {
  it("keepRscParam: __rsc stays in every cache key option (HTML and Flight never share an entry)", async () => {
    const { keepRscParam } = await import("../src/modules/rsc-action.js");
    const { normalizeUrl } = await import("../src/modules/cache.js");
    const key = (o: object, q: string) => normalizeUrl("https://x/p?" + q, keepRscParam(o) as never).search;
    expect(key({ keepParams: ["id"] }, "id=1")).not.toBe(key({ keepParams: ["id"] }, "id=1&__rsc=1")); // the original bug: both normalized to ?id=1
    expect(key({ keepParams: ["id"] }, "id=1&__rsc=1")).toContain("__rsc");
    for (const ig of [["__rsc"], ["__*"], ["__RSC"], ["_*"]]) expect(key({ ignoreParams: ig }, "__rsc=1"), String(ig)).toContain("__rsc");
    expect(key({ ignoreParams: ["utm_*", "fbclid"] }, "a=1&utm_x=2&__rsc")).toBe("?__rsc=&a=1");
    expect(keepRscParam(undefined)).toBeUndefined(); expect(keepRscParam({ vary: ["accept"] })).toEqual({ vary: ["accept"] });
  });
  it("head scripts carry the CSP nonce (inline and src), none without one", () => {
    const hd = { script: [{ content: "x=1" }, { src: "/a.js" }] };
    const withN: any[] = headElements(hd, "n0nce"), without: any[] = headElements(hd);
    expect(withN.map((e) => e.props.nonce)).toEqual(["n0nce", "n0nce"]); expect(without.map((e) => "nonce" in e.props)).toEqual([false, false]);
  });
});

describe("createRsc: draft state, action runner, onError", () => {
  const mod = (m: Record<string, unknown> = {}) => async () => ({ default: () => null, ...m });
  const rctx = (o: Record<string, unknown> = {}) => ({ env: {}, req: new Request("http://t/p/1"), digest: "d9", ...o });
  it("draft state reaches the loader argument and isDraft() (public requests: false)", async () => {
    const { isDraft } = await import("../src/modules/rsc-server.js");
    const seen: unknown[] = [];
    const rsc = createRsc({ render: () => { seen.push(isDraft()); return new ReadableStream(); }, Boundary: "B", routes: { "/p/:id": { load: mod({ loader: async (a: any) => { seen.push(a.draft); return 1; } }), layouts: [] } } });
    await rsc.flight("/p/:id", { id: "1" }, "http://t/p/1", rctx({ draft: { exp: 5 } }));
    await rsc.flight("/p/:id", { id: "1" }, "http://t/p/1", rctx());
    expect(seen).toEqual([{ exp: 5 }, true, undefined, false]);
  });
  it("config() collects the action ids of the page and its layouts, and exposes cache/isr/actionGuard", async () => {
    const f = (id: string) => Object.assign(() => {}, { $$id: id });
    const rsc = createRsc({ render: () => new ReadableStream(), Boundary: "B", routes: { "/p": { load: mod({ serverActions: [f("a#1"), {}], cache: { maxAge: 1 }, isr: { maxAge: 2 }, actionMaxBytes: 5 }), layouts: [mod({ serverActions: [f("l#2")] })] } } });
    const c = await rsc.config("/p");
    expect(c.actions).toEqual(["a#1", "l#2"]); expect(c.cache).toEqual({ maxAge: 1 }); expect(c.isr).toEqual({ maxAge: 2 }); expect(c.actionMaxBytes).toBe(5);
    await expect(rsc.config("/missing")).rejects.toThrow(/no rsc route/);
  });
  it("action(): only a registered server reference with exactly that id runs, inside the request context", async () => {
    const ref = (id: string, fn: (f: FormData) => unknown) => Object.assign(fn, { $$typeof: Symbol.for("react.server.reference"), $$id: id });
    let ctxEnv: unknown, got: unknown;
    const reg: Record<string, unknown> = { "a#go": ref("a#go", (fd) => { ctxEnv = getRequest().env; got = fd.get("x"); }), "a#liar": ref("other#id", () => {}), "a#plain": () => {} };
    const routes = { "/p": { load: mod(), layouts: [] } };
    const rsc = createRsc({ render: () => new ReadableStream(), Boundary: "B", routes, loadAction: async (id) => { if (id === "a#boom") throw new Error("no module"); return reg[id]; } });
    const fd = new FormData(); fd.set("x", "1");
    expect(await rsc.action("/p", {}, "http://t/p", rctx({ env: { E: 1 } }), "a#go", fd)).toBe("ok");
    expect(ctxEnv).toEqual({ E: 1 }); expect(got).toBe("1");
    for (const id of ["a#liar", "a#plain", "a#boom", "a#none"]) expect(await rsc.action("/p", {}, "http://t/p", rctx(), id, fd)).toBe("unknown");
    const noActions = createRsc({ render: () => new ReadableStream(), Boundary: "B", routes });
    expect(await noActions.action("/p", {}, "http://t/p", rctx(), "a#go", fd)).toBe("unknown");
  });
  it("action(): updateTag() purges the ledger and queues the read-your-writes cookie into rctx.cookies", async () => {
    const kv = new Map<string, string>();
    const env = { CF_CACHE_TAGS: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) } };
    const act = Object.assign(async () => { await updateTag(["posts", "post:1"]); }, { $$typeof: Symbol.for("react.server.reference"), $$id: "a#u" });
    const rsc = createRsc({ render: () => new ReadableStream(), Boundary: "B", routes: { "/p": { load: mod(), layouts: [] } }, loadAction: async () => act });
    const cookies: string[] = [];
    expect(await rsc.action("/p", {}, "https://t/p", rctx({ env, cookies, req: new Request("https://t/p") }), "a#u", new FormData())).toBe("ok");
    expect([...kv.keys()].sort()).toEqual(["cfl:tag:post:1", "cfl:tag:posts"]);
    expect(cookies).toHaveLength(1); expect(cookies[0]).toMatch(/^__cfl_upd=\d+; Path=\/; Max-Age=60; HttpOnly; SameSite=Lax; Secure$/);
  });
  it("onError: navigation signals keep their digest, anything else is logged, reported and answered with the request digest", async () => {
    const report = vi.fn(); (globalThis as any)[Symbol.for("cf-lite.report")] = report;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let onError!: (e: unknown) => string | undefined;
    const rsc = createRsc({ render: (_m, o) => { onError = o.onError; return new ReadableStream(); }, Boundary: "B", routes: { "/p": { load: mod(), layouts: [] } } });
    await rsc.flight("/p", {}, "http://t/p", rctx());
    expect(onError((() => { try { notFound(); } catch (e) { return e; } })())).toBe(NOT_FOUND_DIGEST);
    expect(onError(new Error("kaboom"))).toBe("d9"); expect(err).toHaveBeenCalled(); expect(report).toHaveBeenCalled();
    delete (globalThis as any)[Symbol.for("cf-lite.report")]; err.mockRestore();
  });
});

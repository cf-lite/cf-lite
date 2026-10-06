import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ssr } from "../src/server.js";
import { redirect, notFound } from "../src/navigation.js";

const SHELL = '<!doctype html><html><head><script type="module" src="/a.js"></script><link rel="modulepreload" href="/b.js"><title>t</title></head><body><div id="root"></div></body></html>';
const ui = (body: string | ReadableStream = "<p>page</p>", head?: string, spy?: (v: any) => void) => ({
  async render(v: any) { spy?.(v); return { body, head }; }, async renderToString() { return { body: "" }; },
});
const mount = (mod: any, opts: any = {}, shell = SHELL, env: any = undefined, pre?: (c: any) => void) => {
  const app = new Hono<any>();
  if (pre) app.use("*", async (c, n) => { pre(c); await n(); });
  app.all("/p/:id?", ssr(mod, { ui: ui(), hydrate: true, ...opts }) as any);
  const assets = { fetch: vi.fn(async (r: any) => new URL(String(r.url ?? r)).pathname === "/_shell.tpl" ? new Response(shell) : new Response("nf", { status: 404 })) };
  return { app, assets, go: (path = "/p/1", init?: RequestInit) => app.request(path, init, env ?? { ASSETS: assets }) };
};

describe("ssr()", () => {
  it("optional catch-all (`path: /docs/*?`): loader sees c.req.param('*') for /docs, /docs/a, /docs/a/b", async () => {
    const seen: string[] = [];
    const app = new Hono<any>();
    app.all("/docs/*", ssr({ default: 1, loader: (c: any) => { seen.push(c.req.param("*") + "|" + JSON.stringify(c.req.param())); return 1; } } as any, { ui: ui(), hydrate: false, path: "/docs/*?" }) as any);
    const assets = { fetch: async (r: any) => new URL(String(r.url ?? r)).pathname === "/_shell.tpl" ? new Response(SHELL) : new Response("nf", { status: 404 }) };
    for (const u of ["/docs", "/docs/a", "/docs/a/b"]) expect((await app.request(u, {}, { ASSETS: assets })).status).toBe(200);
    expect(seen).toEqual(['|{"*":""}', 'a|{"*":"a"}', 'a/b|{"*":"a/b"}']);
  });
  it("renders into the shell, streams status 200, html content-type", async () => {
    const { go } = mount({ default: 1 });
    const r = await go();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('<div id="root" data-ssr><p>page</p></div>');
    expect(html).toContain("</body></html>");
  });
  it("loader data: `</script>` and `<!--` in data cannot break out of the inline JSON; params passed to the UI", async () => {
    const seen: any[] = [];
    const evil = "</script><script>alert(1)</script><!--";
    const { go } = mount({ default: 1, loader: () => ({ q: evil }) }, { ui: ui("x", undefined, (v) => seen.push(v)) });
    const html = await (await go("/p/42")).text();
    const inline = /window\.__CF_LITE_DATA__=(.*?)<\/script>/s.exec(html)![1];
    expect(inline).not.toContain("<");
    expect(JSON.parse(inline.replace(/\\u003c/g, "<"))).toEqual({ q: evil });
    expect(html.match(/<script>alert/g)).toBeNull();
    expect(seen[0].params).toEqual({ id: "42" });
  });
  it("CSP nonce from context is stamped on the data script, the shell's scripts and head additions", async () => {
    const { go } = mount({ default: 1, loader: () => 1 }, { ui: ui("x", "<style>a{}</style>") }, SHELL, undefined, (c) => c.set("cspNonce", "N0NCE"));
    const html = await (await go()).text();
    expect(html).toContain('<script nonce="N0NCE">window.__CF_LITE_DATA__=1');
    expect(html).toContain('<script nonce="N0NCE" type="module"');
    expect(html).toContain('<style nonce="N0NCE">a{}</style>');
  });
  it("streamed (ReadableStream) bodies are concatenated in order", async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("<a>")); c.enqueue(new TextEncoder().encode("</a>")); c.close(); } });
    const { go } = mount({ default: 1 }, { ui: ui(body) });
    expect(await (await go()).text()).toContain('data-ssr><a></a></div>');
  });
  it("loader redirect -> real status + Location before any byte; notFound -> 404 (boundary page or plain text)", async () => {
    const r = await mount({ default: 1, loader: () => { throw redirect("/login"); } }).go();
    expect(r.status).toBe(307); expect(r.headers.get("location")).toBe("/login");
    const nf = await mount({ default: 1, loader: () => { throw notFound(); } }).go();
    expect(nf.status).toBe(404); expect(await nf.text()).toBe("Not Found");
    const bound = await mount({ default: 1, loader: () => { throw notFound(); } }, { notFound: { default: 1 }, ui: ui("<h1>gone</h1>") }).go();
    expect(bound.status).toBe(404); expect(await bound.text()).toContain("<h1>gone</h1>");
  });
  it("report hook receives error + digest when installed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rep = vi.fn(); (globalThis as any)[Symbol.for("cf-lite.report")] = rep;
    await mount({ default: 1, loader: () => { throw new Error("x"); } }).go();
    delete (globalThis as any)[Symbol.for("cf-lite.report")];
    expect(rep).toHaveBeenCalledTimes(1); expect(rep.mock.calls[0][1]).toMatchObject({ method: "GET" }); err.mockRestore();
  });
  it("missing HTML shell -> 500, not a blank page", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await mount({ default: 1 }, {}, "<html>no root</html>").go();
    expect(r.status).toBe(500); err.mockRestore();
  });
  it("path pattern: non-matching URL falls through (404), matching params (incl. catch-all) are passed", async () => {
    const seen: any[] = [];
    const app = new Hono<any>();
    app.all("*", ssr({ default: 1 }, { ui: ui("x", undefined, (v) => seen.push(v)), hydrate: false, path: "/docs/*?" }) as any);
    const env = { ASSETS: { fetch: async () => new Response(SHELL) } };
    expect((await app.request("/other", {}, env)).status).toBe(404);
    expect((await app.request("/docs/a/b", {}, env)).status).toBe(200);
    expect(seen[0].params["*"]).toBe("a/b");
  });
  it("POST: route without `actions` falls through (404) - no accidental handler; with actions runs CSRF first", async () => {
    const r = await mount({ default: 1 }).go("/p/1", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" } });
    expect(r.status).toBe(404);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ran = vi.fn();
    const blocked = await mount({ default: 1, actions: { default: ran } }).go("/p/1", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" } });
    expect(blocked.status).toBe(403); expect(ran).not.toHaveBeenCalled(); warn.mockRestore();
  });
  it("POST action result re-renders the page with actionData merged over loader data and the failure status", async () => {
    const seen: any[] = [];
    const { go } = mount({ default: 1, loader: () => ({ items: [1] }), actions: { default: () => ({ __f: 1 }) } }, { ui: ui("x", undefined, (v) => seen.push(v)) });
    const { fail } = await import("../src/modules/actions.js");
    const m = mount({ default: 1, loader: () => ({ items: [1] }), actions: { default: () => fail(422, { errors: { a: ["x"] } }) } }, { ui: ui("x", undefined, (v) => seen.push(v)) });
    const r = await m.go("/p/1", { method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" } });
    expect(r.status).toBe(422); expect(seen.at(-1).data).toEqual({ items: [1], actionData: { errors: { a: ["x"] } } });
    void go;
  });
  it("missing HTML shell (no #root) -> 500, not a blank page", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await mount({ default: 1 }, {}, "<html>no root</html>").go();
    expect(r.status).toBe(500); err.mockRestore();
  });
  it("error boundary receives a digest; a failing boundary falls back to plain 500 (dev mode shows the message, prod redaction is covered by the workerd e2e)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = () => { throw new Error("db down"); };
    const seen: any[] = [];
    const b = await mount({ default: 1, loader: boom }, { error: { default: 1 }, ui: ui("<h1>oops</h1>", undefined, (v) => seen.push(v)) }).go();
    expect(b.status).toBe(500); expect(seen[0].data.digest).toMatch(/[0-9a-f-]{8,}/); expect(await b.text()).toContain("<h1>oops</h1>");
    const plain = await mount({ default: 1, loader: boom }).go();
    expect(plain.status).toBe(500); expect(await plain.text()).toMatch(/digest/);
    const broken = await mount({ default: 1, loader: boom }, { error: { default: 1 }, ui: { async render() { throw new Error("ui down"); }, async renderToString() { return { body: "" }; } } }).go();
    expect(broken.status).toBe(500); expect(await broken.text()).toMatch(/^Internal Server Error/);
    err.mockRestore();
  });
});

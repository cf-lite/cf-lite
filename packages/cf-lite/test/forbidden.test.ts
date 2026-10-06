import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Hono } from "hono";
import { ssr } from "../src/server.js";
import { forbidden, unauthorized, isNavigationSignal, signalStatus } from "../src/navigation.js";
import { scanPages } from "../src/scan.js";
import { genRoutes } from "../src/conventions/pages.js";
import { digestOf, signalOf, FORBIDDEN_DIGEST, UNAUTHORIZED_DIGEST } from "../src/modules/rsc-digest.js";

const SHELL = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const ui = (body = "<p>page</p>") => ({ async render() { return { body }; }, async renderToString() { return { body: "" }; } });
const go = (mod: any, opts: any = {}, init?: RequestInit) => {
  const app = new Hono<any>();
  app.all("/p", ssr(mod, { ui: ui(), hydrate: true, ...opts }) as any);
  const assets = { fetch: vi.fn(async (r: any) => new URL(String(r.url ?? r)).pathname === "/_shell.tpl" ? new Response(SHELL) : new Response("nf", { status: 404 })) };
  return app.request("/p", init, { ASSETS: assets });
};
const tree = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "cfl-forb-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), c); }
  return root;
};

describe("forbidden() / unauthorized()", () => {
  it("throw typed signals with the right status", () => {
    let e: unknown;
    try { forbidden(); } catch (x) { e = x; }
    expect(isNavigationSignal(e)).toBe(true); expect(e).toMatchObject({ kind: "forbidden" });
    try { unauthorized(); } catch (x) { e = x; }
    expect(e).toMatchObject({ kind: "unauthorized" });
    expect([signalStatus("forbidden"), signalStatus("unauthorized"), signalStatus("not-found")]).toEqual([403, 401, 404]);
  });
  it("ssr(): loader forbidden -> 403, unauthorized -> 401; plain text without a boundary", async () => {
    const f = await go({ default: 1, loader: () => forbidden() });
    expect(f.status).toBe(403); expect(await f.text()).toBe("Forbidden");
    const u = await go({ default: 1, loader: () => unauthorized() });
    expect(u.status).toBe(401); expect(await u.text()).toBe("Unauthorized");
  });
  it("ssr(): renders the _forbidden / _unauthorized boundary (not the _not-found one), never hydrated", async () => {
    const opts = { notFound: { default: 1 }, forbidden: { default: 2 }, unauthorized: { default: 3 }, ui: { async render(v: any) { return { body: `<h1>page-${v.Page}-${v.hydrate}</h1>` }; }, async renderToString() { return { body: "" }; } } };
    const f = await go({ default: 0, loader: () => forbidden() }, opts);
    expect(f.status).toBe(403); expect(await f.text()).toContain("<h1>page-2-false</h1>");
    const u = await go({ default: 0, loader: () => unauthorized() }, opts);
    expect(u.status).toBe(401); expect(await u.text()).toContain("<h1>page-3-false</h1>");
  });
  it("action throwing forbidden() -> 403 for fetch callers", async () => {
    const mod = { default: 1, actions: { x: () => forbidden() } };
    const app = new Hono<any>();
    app.all("/p", ssr(mod, { ui: ui(), hydrate: true }) as any);
    const r = await app.request("/p?/x", { method: "POST", headers: { origin: "http://localhost", "x-cf-lite-action": "1", accept: "application/json" }, body: new FormData() }, { ASSETS: { fetch: async () => new Response(SHELL) } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ type: "error", status: 403 });
  });
});

describe("_forbidden / _unauthorized conventions", () => {
  const root = tree({
    "app/routes/index.tsx": "export default () => null",
    "app/routes/_forbidden.tsx": "export default () => null",
    "app/routes/admin/_unauthorized.tsx": "export default () => null",
    "app/routes/admin/x.tsx": "export default () => null",
  });
  const pages = scanPages(root, "app/routes", [".tsx"]);
  it("are boundaries (never routes), nearest ancestor wins", () => {
    expect(pages.map((p) => p.path).sort()).toEqual(["/", "/admin/x"]);
    const x = pages.find((p) => p.path === "/admin/x")!;
    expect(x.forbidden).toBe("app/routes/_forbidden.tsx"); expect(x.unauthorized).toBe("app/routes/admin/_unauthorized.tsx");
    expect(pages.find((p) => p.path === "/")!.unauthorized).toBeUndefined();
  });
  it("client route table carries them; apps without them are unchanged", () => {
    const out = genRoutes(pages);
    expect(out).toContain(`forbidden: () => import("../app/routes/_forbidden")`);
    expect(out).toContain(`unauthorized: () => import("../app/routes/admin/_unauthorized")`);
    const plain = genRoutes(scanPages(tree({ "app/routes/index.tsx": "export default () => null" }), "app/routes", [".tsx"]));
    expect(plain).not.toMatch(/forbidden|unauthorized/);
  });
  it("duplicates in one directory are an error", () => {
    const r = tree({ "app/routes/_forbidden.tsx": "", "app/routes/_forbidden.jsx": "", "app/routes/index.tsx": "export default () => null" });
    expect(() => scanPages(r, "app/routes", [".tsx", ".jsx"])).toThrow(/both the forbidden boundary/);
  });
  it("rsc: _forbidden.rsc.tsx / _unauthorized.rsc.tsx", () => {
    const r = tree({ "app/routes/p.tsx": 'export const render = "rsc"; export default () => null', "app/routes/_forbidden.rsc.tsx": "", "app/routes/_unauthorized.rsc.tsx": "" });
    const p = scanPages(r, "app/routes", [".tsx"]);
    expect(p.map((x) => x.path)).toEqual(["/p"]);
    expect(p[0]).toMatchObject({ rscForbidden: "app/routes/_forbidden.rsc.tsx", rscUnauthorized: "app/routes/_unauthorized.rsc.tsx" });
  });
});

describe("digests", () => {
  it("round trip across Flight", () => {
    let f: unknown, u: unknown;
    try { forbidden(); } catch (e) { f = e; }
    try { unauthorized(); } catch (e) { u = e; }
    expect(digestOf(f)).toBe(FORBIDDEN_DIGEST); expect(digestOf(u)).toBe(UNAUTHORIZED_DIGEST);
    expect(signalOf({ digest: FORBIDDEN_DIGEST })).toEqual({ kind: "forbidden" });
    expect(signalOf(u)).toEqual({ kind: "unauthorized" });
  });
});

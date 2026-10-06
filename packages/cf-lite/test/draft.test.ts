import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { DRAFT_COOKIE, enableDraft, draft, draftRoutes, draftState, isDraft, safeRedirectPath, withFrameAncestors } from "../src/modules/draft.js";
import { hasDraftCookie } from "../src/modules/cache.js";
import { createCacheRoute } from "../src/modules/cache.js";
import { createIsr } from "../src/modules/isr.js";
import { sealData } from "../src/modules/session.js";
import { security } from "../src/modules/csp.js";

const SECRET = "s".repeat(40), OLD = "o".repeat(40);
const env = { DRAFT_SECRET: SECRET };
const origin = "https://site.example";

function mk(opts: Parameters<typeof draft>[0] = {}, routeOpts = opts) {
  const app = new Hono<{ Bindings: typeof env }>();
  app.use("*", security({ preset: "strict", dev: true }));
  app.use("*", draft(opts));
  app.route("/api/draft", draftRoutes(routeOpts));
  app.get("/p", (c) => c.html(isDraft(c) ? "DRAFT" : "LIVE"));
  const req = (path: string, init: RequestInit = {}) => app.request(origin + path, init, env);
  return { app, req };
}
const cookieFrom = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0];
const enable = async (m: ReturnType<typeof mk>, q = "") => m.req(`/api/draft/enable?secret=${SECRET}${q}`);

describe("draft enable/disable", () => {
  it("wrong/missing secret -> 401, no cookie; right secret -> 307 + HttpOnly cookie", async () => {
    const m = mk();
    for (const q of ["", "?secret=nope", `?secret=${SECRET}x`]) {
      const r = await m.req("/api/draft/enable" + q);
      expect(r.status).toBe(401); expect(r.headers.get("set-cookie")).toBeNull();
    }
    const r = await enable(m, "&path=/p");
    expect(r.status).toBe(307); expect(r.headers.get("location")).toBe("/p");
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(new RegExp(`^${DRAFT_COOKIE}=1\\.`)); expect(sc).toMatch(/HttpOnly/); expect(sc).toMatch(/Secure/); expect(sc).toMatch(/SameSite=Lax/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
  it("accepts Bearer secret and a rotated old secret; fails closed (503) with no/short DRAFT_SECRET", async () => {
    const m = mk({ secrets: [SECRET, OLD] });
    expect((await m.req("/api/draft/enable", { headers: { authorization: `Bearer ${OLD}` } })).status).toBe(307);
    const app = new Hono(); app.route("/d", draftRoutes());
    expect((await app.request(origin + "/d/enable?secret=x")).status).toBe(503);
    expect((await app.request(origin + "/d/enable?secret=x", {}, { DRAFT_SECRET: "short" })).status).toBe(503);
  });
  it("token: verifyToken gates the cookie; requireToken without verifier needs a token", async () => {
    const m = mk({ verifyToken: (t) => t === "good" });
    expect((await enable(m)).status).toBe(401);
    expect((await enable(m, "&token=bad")).status).toBe(401);
    expect((await enable(m, "&token=good")).status).toBe(307);
    const boom = mk({ verifyToken: () => { throw new Error("x"); } });
    expect((await enable(boom, "&token=good")).status).toBe(401);
    const req = mk({ requireToken: true });
    expect((await enable(req)).status).toBe(401);
    expect((await enable(req, "&token=any")).status).toBe(307);
  });
  it("redirect target is same-origin only", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:1", "/a\r\nSet-Cookie: x", undefined, ""]) expect(safeRedirectPath(bad)).toBe("/");
    expect(safeRedirectPath("/blog/x?a=1#h")).toBe("/blog/x?a=1#h");
    expect(safeRedirectPath("/admin", ["/blog"])).toBe("/");
    expect(safeRedirectPath("/blog/x", ["/blog"])).toBe("/blog/x");
  });
  it("disable clears the cookie without a secret", async () => {
    const m = mk(); const r = await m.req("/api/draft/disable?path=/p", { method: "POST" });
    expect(r.status).toBe(307); expect(r.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
  it("ctxParams are carried into state", async () => {
    const m = mk({ ctxParams: ["doc"] });
    const ck = cookieFrom(await enable(m, "&doc=42"));
    const app = new Hono(); let st: unknown;
    app.use("*", draft({ ctxParams: ["doc"] })); app.get("/", (c) => { st = draftState(c); return c.text("x"); });
    await app.request(origin + "/", { headers: { cookie: ck } }, env);
    expect(st).toMatchObject({ ctx: { doc: "42" } });
  });
});

describe("CMS-issued token (tokenOnly) and enableDraft", () => {
  const verifyToken = (t: string | null) => t === "good";
  it("tokenOnly: no secret needed, token must verify; secret alone no longer works", async () => {
    const m = mk({}, { tokenOnly: true, verifyToken });
    expect((await m.req("/api/draft/enable?token=good&path=/p")).status).toBe(307);
    expect((await m.req("/api/draft/enable?token=bad")).status).toBe(401);
    expect((await m.req("/api/draft/enable")).status).toBe(401);
    expect((await m.req(`/api/draft/enable?secret=${SECRET}`)).status).toBe(401);
    expect(() => draftRoutes({ tokenOnly: true })).toThrow(/verifyToken/);
    const app = new Hono(); app.route("/d", draftRoutes({ tokenOnly: true, verifyToken }));
    expect((await app.request(origin + "/d/enable?token=good", {}, {})).status).toBe(503);
  });
  it("enableDraft mints the cookie from a custom route (path sanitised, no-store)", async () => {
    const app = new Hono();
    app.use("*", draft({}));
    app.get("/preview", (c) => (c.req.query("preview_token") === "ok" ? enableDraft(c, {}, { path: c.req.query("p"), ctx: { key: "k1" }, maxAge: 120 }) : c.text("no", 401)));
    app.get("/p", (c) => c.json({ d: isDraft(c), ctx: draftState(c)?.ctx }));
    const r = await app.request(origin + "/preview?preview_token=ok&p=//evil.com", {}, env);
    expect(r.status).toBe(307); expect(r.headers.get("location")).toBe("/");
    expect(r.headers.get("set-cookie")).toMatch(/Max-Age=120/); expect(r.headers.get("cache-control")).toBe("private, no-store");
    const d = await app.request(origin + "/p", { headers: { cookie: cookieFrom(r) } }, env);
    expect(await d.json()).toEqual({ d: true, ctx: { key: "k1" } });
  });
});

describe("draft() middleware", () => {
  it("isDraft false without cookie, true with a valid one; draft responses are no-store + noindex", async () => {
    const m = mk();
    const live = await m.req("/p");
    expect(await live.text()).toBe("LIVE"); expect(live.headers.get("x-cf-lite-draft")).toBeNull();
    const ck = cookieFrom(await enable(m));
    const r = await m.req("/p", { headers: { cookie: ck } });
    expect(await r.text()).toBe("DRAFT");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect(r.headers.get("vary")).toMatch(/Cookie/i);
  });
  it("forged, tampered, wrong-key, wrong-aad and expired cookies are LIVE (but still no-store)", async () => {
    const m = mk();
    const good = cookieFrom(await enable(m)).split("=")[1];
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      "garbage", good.slice(0, -2) + "xx",
      await sealData({ iat: now, exp: now + 99 }, "z".repeat(40), DRAFT_COOKIE),
      await sealData({ iat: now, exp: now + 99 }, SECRET, "session"), // sealed for another purpose
      await sealData({ iat: now - 99, exp: now - 1 }, SECRET, DRAFT_COOKIE),
    ];
    for (const v of cases) {
      const r = await m.req("/p", { headers: { cookie: `${DRAFT_COOKIE}=${v}` } });
      expect(await r.text()).toBe("LIVE"); expect(r.headers.get("cache-control")).toBe("private, no-store"); expect(r.headers.get("x-cf-lite-draft")).toBeNull();
    }
  });
  it("frameAncestors only applies to valid drafts; replaces CSP frame-ancestors and X-Frame-Options; cookie SameSite=None", async () => {
    const m = mk({ frameAncestors: ["https://cms.example.com"] });
    const en = await enable(m);
    expect(en.headers.get("set-cookie")).toMatch(/SameSite=None; Secure/);
    const d = await m.req("/p", { headers: { cookie: cookieFrom(en) } });
    expect(d.headers.get("content-security-policy")).toMatch(/frame-ancestors 'self' https:\/\/cms\.example\.com(;|$)/);
    expect(d.headers.get("content-security-policy")).not.toMatch(/frame-ancestors 'none'/);
    const l = await m.req("/p");
    expect(l.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  });
  it("frameAncestors from env (CMS_ORIGINS / DRAFT_FRAME_ANCESTORS) and from a function, at request time; bad env entries ignored", async () => {
    const app = new Hono();
    app.use("*", draft({}));
    app.route("/api/draft", draftRoutes({}));
    app.get("/p", (c) => c.html("x"));
    const e = { DRAFT_SECRET: SECRET, CMS_ORIGINS: "https://cms.a.com, https://*  *,https://b.com;x" };
    const en = await app.request(`${origin}/api/draft/enable?secret=${SECRET}`, {}, e);
    expect(en.headers.get("set-cookie")).toMatch(/SameSite=None/);
    const d = await app.request(origin + "/p", { headers: { cookie: cookieFrom(en) } }, e);
    expect(d.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://cms.a.com");
    // no env -> not relaxed, cookie Lax
    const en2 = await app.request(`${origin}/api/draft/enable?secret=${SECRET}`, {}, env);
    expect(en2.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    // function resolver
    const f = new Hono();
    f.use("*", draft({ frameAncestors: (c) => [(c.env as any).CMS] }));
    f.get("/p", (c) => c.html("x"));
    const cookie = `${DRAFT_COOKIE}=${await sealData({ iat: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET, DRAFT_COOKIE)}`;
    const r = await f.request(origin + "/p", { headers: { cookie } }, { DRAFT_SECRET: SECRET, CMS: "https://fn.example.com" });
    expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://fn.example.com");
    const bad = await f.request(origin + "/p", { headers: { cookie } }, { DRAFT_SECRET: SECRET, CMS: "*" });
    expect(bad.headers.get("content-security-policy")).toBeNull();
  });
  it("rejects dangerous frameAncestors at construction", () => {
    for (const bad of ["*", "https://*", "https://a.com; script-src *", "https://a.com https://b.com", "javascript:x"]) expect(() => draft({ frameAncestors: [bad] })).toThrow(/frameAncestors/);
    expect(() => draft({ frameAncestors: ["https://*.cms.example.com", "'self'", "http://localhost:3000"] })).not.toThrow();
  });
  it("withFrameAncestors replaces or appends", () => {
    expect(withFrameAncestors("default-src 'self'; frame-ancestors 'none'", ["https://a.com"])).toBe("default-src 'self'; frame-ancestors 'self' https://a.com");
    expect(withFrameAncestors("default-src 'self'", ["https://a.com"])).toBe("default-src 'self'; frame-ancestors 'self' https://a.com");
  });
  it("http (dev): cookie not Secure", async () => {
    const m = mk();
    const r = await m.app.request("http://localhost/api/draft/enable?secret=" + SECRET, {}, env);
    expect(r.headers.get("set-cookie")).not.toMatch(/Secure/);
  });
});

describe("draft bypasses shared caches", () => {
  it("hasDraftCookie: presence only", () => {
    expect(hasDraftCookie(new Request(origin, { headers: { cookie: `a=1; ${DRAFT_COOKIE}=zzz` } }))).toBe(true);
    expect(hasDraftCookie(new Request(origin, { headers: { cookie: `x${DRAFT_COOKIE}=1` } }))).toBe(false);
    expect(hasDraftCookie(new Request(origin))).toBe(false);
  });
  it("cache(): a previewer BYPASSes (never stored, never served from store) and the public copy is untouched", async () => {
    const store = new Map<string, Response>();
    const cacheApi = { match: async (k: Request | string) => store.get(typeof k === "string" ? k : k.url)?.clone(), put: async (k: Request | string, r: Response) => void store.set(typeof k === "string" ? k : k.url, r.clone()), delete: async () => true } as unknown as Cache;
    const route = createCacheRoute({ cache: () => cacheApi, now: () => 1e6, dev: false });
    let n = 0;
    const app = new Hono();
    app.use("*", draft({ secrets: SECRET }));
    app.get("/p", route({ cache: { maxAge: 60 } } as never, (c) => { n++; return c.html(isDraft(c) ? "DRAFT" : "LIVE"); }));
    const pub = await app.request(origin + "/p"); await pub.text();
    expect(store.size).toBe(1);
    const sealed = await sealData({ iat: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET, DRAFT_COOKIE);
    const r = await app.request(origin + "/p", { headers: { cookie: `${DRAFT_COOKIE}=${sealed}` } });
    expect(await r.text()).toBe("DRAFT");
    expect(r.headers.get("x-cf-lite-cache")).toBe("BYPASS"); expect(r.headers.get("x-cf-lite-cache-why")).toBe("draft");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(store.size).toBe(1);
    expect(n).toBe(2);
    expect(await (await app.request(origin + "/p")).text()).toBe("LIVE"); // public still HIT-able
  });
  it("isr(): a previewer BYPASSes without touching R2", async () => {
    const touched: string[] = [];
    const bucket = new Proxy({}, { get: (_t, k) => () => { touched.push(String(k)); return null; } }) as unknown as R2Bucket;
    const isr = createIsr({ now: () => 1e6 });
    const app = new Hono<{ Bindings: { ISR_BUCKET: R2Bucket } }>();
    app.use("*", draft({ secrets: SECRET }));
    app.get("/p", isr({ maxAge: 60 }), (c) => c.html(isDraft(c) ? "DRAFT" : "LIVE"));
    const sealed = await sealData({ iat: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET, DRAFT_COOKIE);
    const r = await app.request(origin + "/p", { headers: { cookie: `${DRAFT_COOKIE}=${sealed}` } }, { ISR_BUCKET: bucket });
    expect(await r.text()).toBe("DRAFT"); expect(r.headers.get("x-cf-lite-isr-why")).toBe("draft"); expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(touched).toEqual([]);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewOnly, previewTarget } from "../src/modules/draft.js";
import { staticNegations } from "../src/vite.js";
import { draftConvention } from "../src/conventions/draft.js";
import { fitWorkerFirst } from "../src/conventions/index.js";
import { doctor } from "../src/doctor.js";

describe("preview routing", () => {
  it("previewTarget rewrites only prerendered patterns", () => {
    const pats = ["/about", "/blog/:slug", "/docs/*?", "/"];
    expect(previewTarget("/about", pats)).toBe("/__preview/about");
    expect(previewTarget("/about/?a=1", pats)).toBe("/__preview/about/?a=1");
    expect(previewTarget("/blog/x", pats)).toBe("/__preview/blog/x");
    expect(previewTarget("/docs", pats)).toBe("/__preview/docs");
    expect(previewTarget("/docs/a/b", pats)).toBe("/__preview/docs/a/b");
    expect(previewTarget("/blog/x/y", pats)).toBe("/blog/x/y");
    expect(previewTarget("/live", pats)).toBe("/live");
    expect(previewTarget("/about", undefined)).toBe("/about");
    expect(previewTarget("/__preview/about", pats)).toBe("/__preview/about");
  });
  it("previewOnly 404s without a verified draft", async () => {
    const app = new Hono();
    app.use("*", draft({ secrets: SECRET }));
    app.get("/__preview/a", previewOnly((c) => c.text("secret page")));
    expect((await app.request(origin + "/__preview/a")).status).toBe(404);
    const sealed = await sealData({ iat: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET, DRAFT_COOKIE);
    expect(await (await app.request(origin + "/__preview/a", { headers: { cookie: `${DRAFT_COOKIE}=${sealed}` } })).text()).toBe("secret page");
  });
  it("enable rewrites a prerendered path via previewPatterns", async () => {
    const m = mk({ previewPatterns: ["/about"] });
    expect((await enable(m, "&path=/about")).headers.get("location")).toBe("/__preview/about");
  });
});

describe("static negations for a root catch-all", () => {
  const page = (path: string, render: string) => ({ file: "x", path, render, hydrate: false, layouts: [] }) as never;
  it("covers assets, public/ and prerendered pages; stays under the limit", () => {
    const root = mkdtempSync(join(tmpdir(), "cfl-"));
    mkdirSync(join(root, "public/img"), { recursive: true });
    writeFileSync(join(root, "public/robots.txt"), ""); writeFileSync(join(root, "public/_headers"), ""); writeFileSync(join(root, "public/.hidden"), "");
    const n = staticNegations(root, [page("/about", "static"), page("/blog/:slug", "static"), page("/[[...all]]", "ssr"), page("/docs/:id", "static"), page("/docs/:id/edit", "ssr")]);
    expect(n).toEqual(expect.arrayContaining(["!/assets/*", "!/img/*", "!/robots.txt", "!/about", "!/about/", "!/blog/*"]));
    expect(n).not.toContain("!/_headers"); expect(n).not.toContain("!/.hidden"); expect(n).not.toContain("!/docs/*");
    const f = fitWorkerFirst(["/*", ...n]);
    expect(f.fellBack).toBe(false); expect(f.globs).toContain("/*"); expect(f.globs).toContain("!/assets/*");
  });
});

describe("static negations never expose gated paths (sec-review G1)", () => {
  const page = (path: string, render: string) => ({ file: "x", path, render, hydrate: false, layouts: [] }) as never;
  it("public/admin/ and a prerendered /admin/x stay Worker-first when middleware gates /admin/*", () => {
    const root = mkdtempSync(join(tmpdir(), "cfl-"));
    mkdirSync(join(root, "public/admin"), { recursive: true }); mkdirSync(join(root, "public/img"), { recursive: true });
    writeFileSync(join(root, "public/admin/secret.txt"), "");
    const pages = [page("/[[...all]]", "ssr"), page("/admin/report", "static"), page("/about", "static")];
    const n = staticNegations(root, pages, ["/admin", "/admin/*", "/__preview", "/__preview/*"]);
    expect(n).not.toContain("!/admin/*"); expect(n).not.toContain("!/admin/report"); expect(n).not.toContain("!/admin/report/");
    expect(n).toEqual(expect.arrayContaining(["!/about", "!/img/*", "!/assets/*"]));
    const f = fitWorkerFirst(["/*", "/admin", "/admin/*", ...n]);
    expect(f.globs).not.toContain("!/admin/*");
  });
});

describe("draft convention", () => {
  it("emits nothing it should not: preview routes for static pages, Worker-first globs, JSON options", () => {
    const vt = draftConvention({ verifyToken: "./server/draft-token.ts", tokenOnly: true }).emit(null, { root: "/r", entries: { pages: [] } } as never) as { imports: string[]; appPre: string[]; api: string[] };
    expect(vt.imports[0]).toBe('import * as dvt from "../server/draft-token";');
    expect(vt.appPre[0]).toMatch(/verifyToken: dvt\.default \?\? dvt\.verifyToken/); expect(vt.api[0]).toMatch(/"tokenOnly":true/);
    const c = draftConvention({ frameAncestors: ["https://cms.example.com"] });
    const pages = [{ file: "app/routes/about.tsx", path: "/about", render: "static", layouts: [] }, { file: "app/routes/p.tsx", path: "/p", render: "ssr", layouts: [] }];
    const e = c.emit(null, { root: "/r", entries: { pages } } as never) as { app: string[]; workerFirst: string[]; appPre: string[]; api: string[] };
    expect(e.app).toHaveLength(1); expect(e.app[0]).toMatch(/\.get\("\/__preview\/about", previewOnly\(dssr\(d0/); expect(e.app[0]).toMatch(/hydrate: false/);
    expect(e.workerFirst).toEqual(["/__preview", "/__preview/*"]);
    expect(e.appPre[0]).toMatch(/draft\(\{"frameAncestors":\["https:\/\/cms\.example\.com"\],"previewPatterns":\["\/about"\]\}\)/);
    expect(e.api[0]).toMatch(/\.route\("\/draft", draftRoutes\(/);
  });
  it("no static pages -> no preview globs", () => {
    const e = draftConvention({}).emit(null, { root: "/r", entries: { pages: [] } } as never) as { workerFirst: string[]; app: string[] };
    expect(e.workerFirst).toEqual([]); expect(e.app).toEqual([]);
  });
  it("doctor CFL012: DRAFT_SECRET undeclared", () => {
    const d = mkdtempSync(join(tmpdir(), "cfl-doc-"));
    writeFileSync(join(d, "wrangler.jsonc"), JSON.stringify({ name: "x", main: "w.ts", compatibility_date: new Date().toISOString().slice(0, 10) }));
    mkdirSync(join(d, ".cf-lite")); writeFileSync(join(d, ".cf-lite/meta.json"), JSON.stringify({ draft: true }));
    expect(doctor(d).map((f) => f.code)).toContain("CFL012");
    writeFileSync(join(d, ".dev.vars.example"), "DRAFT_SECRET=\n");
    expect(doctor(d).map((f) => f.code)).not.toContain("CFL012");
  });
  it("doctor CFL013: SSO_PUBLIC_KEYS without SSO_AUDIENCE", () => {
    const d = mkdtempSync(join(tmpdir(), "cfl-doc-"));
    const cfg = (vars: object) => writeFileSync(join(d, "wrangler.jsonc"), JSON.stringify({ name: "x", main: "w.ts", compatibility_date: new Date().toISOString().slice(0, 10), vars }));
    cfg({ SSO_PUBLIC_KEYS: "{}", SSO_ISSUER: "i" });
    expect(doctor(d).filter((f) => f.code === "CFL013")).toMatchObject([{ level: "error" }]);
    cfg({ SSO_PUBLIC_KEYS: "{}", SSO_ISSUER: "i", SSO_AUDIENCE: "a" });
    expect(doctor(d).map((f) => f.code)).not.toContain("CFL013");
    cfg({});
    expect(doctor(d).map((f) => f.code)).not.toContain("CFL013");
  });
});

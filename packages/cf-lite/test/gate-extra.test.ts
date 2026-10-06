import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { addNonce, buildCsp, security } from "../src/modules/csp.js";
import { check, keyOf, memoryLimiter, rateLimit, tooMany, bindingLimiter } from "../src/modules/ratelimit.js";
import { applyHeaders, expand, matchRule, redirectFor, rewriteFor, routeconfMiddleware, REWRITTEN, compileSource, type RouteTable } from "../src/modules/routeconf.js";

describe("security() middleware", () => {
  const app = (o = {}, handler: (c: any) => Response | Promise<Response> = (c) => c.html("<script>1</script>")) => { const a = new Hono(); a.use("*", security({ dev: true, ...o })); a.get("/", handler); return a; };
  it("sets nonce CSP on HTML and the nonce appears in the policy", async () => {
    const r = await app().request("/");
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("fresh nonce per request", async () => {
    const a = app();
    const n = async () => /nonce-([^']+)'/.exec((await a.request("/")).headers.get("content-security-policy")!)![1];
    expect(await n()).not.toBe(await n());
  });
  it("csp:false -> base headers only; reportOnly uses the report-only header", async () => {
    const r = await app({ csp: false }).request("/");
    expect(r.headers.has("content-security-policy")).toBe(false);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    const ro = await app({ reportOnly: true }).request("/");
    expect(ro.headers.has("content-security-policy-report-only")).toBe(true);
    expect(ro.headers.has("content-security-policy")).toBe(false);
  });
  it("non-HTML gets no CSP; a handler-supplied CSP is kept", async () => {
    expect((await app({}, (c) => c.json({ a: 1 })).request("/")).headers.has("content-security-policy")).toBe(false);
    const own = await app({}, (c) => c.html("x", 200, { "content-security-policy": "default-src 'none'" })).request("/");
    expect(own.headers.get("content-security-policy")).toBe("default-src 'none'");
  });
  it("immutable (fetch-style) responses are rebuilt with the headers instead of throwing", async () => {
    const r = await app({}, () => { const x = new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }); Object.defineProperty(x.headers, "set", { value() { throw new TypeError("immutable"); } }); return x; }).request("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("nonce-");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("addNonce leaves tags that already have one (any case/spacing) and does not touch attribute text", () => {
    expect(addNonce('<script NONCE = "a">', "n")).toBe('<script NONCE = "a">');
    expect(addNonce('<script src="a>b">', "n")).toBe('<script nonce="n" src="a>b">'); // '>' inside a quoted attribute does not end the tag
    expect(addNonce("<style>a{}</style><scripty>", "n")).toBe('<style nonce="n">a{}</style><scripty>');
  });
  it("buildCsp honours directive overrides / false (removal)", () => {
    expect(buildCsp({ csp: { "img-src": ["'self'", "https://cdn.test"] } })).toContain("img-src 'self' https://cdn.test");
    expect(buildCsp({ csp: { "frame-ancestors": false } })).not.toContain("frame-ancestors");
    expect(buildCsp({ csp: { "img-src": "'self' data:" }, reportUri: "/r", styleAttr: false })).toMatch(/img-src 'self' data:.*report-uri \/r/);
    expect(buildCsp({ styleAttr: false })).not.toContain("style-src-attr");
    // nonces are merged into the directive (falling back to default-src)
    expect(buildCsp({ csp: { "script-src": false } }, { scriptSrc: ["'nonce-x'"] })).toContain("script-src 'self' 'nonce-x'");
  });
  it("hsts / header overrides (case-insensitive) in baseHeaders", async () => {
    const { baseHeaders } = await import("../src/modules/csp.js");
    expect(baseHeaders({ hsts: { maxAge: 10, includeSubDomains: true, preload: true } })["Strict-Transport-Security"]).toBe("max-age=10; includeSubDomains; preload");
    expect(baseHeaders().hasOwnProperty("Strict-Transport-Security")).toBe(false);
    const h = baseHeaders({ headers: { "x-content-type-options": false, "X-Frame-Options": "DENY" } });
    expect(h["X-Content-Type-Options"]).toBeUndefined();
    expect(h["X-Frame-Options"]).toBe("DENY");
  });
});

describe("ratelimit", () => {
  const ctx = (h: Record<string, string> = {}, extra: Record<string, unknown> = {}, env: unknown = {}) =>
    ({ req: { header: (k: string) => h[k.toLowerCase()], url: "https://x.test/login" }, get: (k: string) => extra[k], env }) as any;
  it("keyOf: cf-connecting-ip beats x-forwarded-for first hop; unknown bucket; session/user fallback; custom fn fallback", async () => {
    expect(await keyOf(ctx({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe("ip:1.1.1.1");
    expect(await keyOf(ctx({ "x-forwarded-for": " 2.2.2.2 , 3.3.3.3" }))).toBe("ip:2.2.2.2");
    expect(await keyOf(ctx())).toBe("ip:unknown");
    expect(await keyOf(ctx({ "cf-connecting-ip": "1.1.1.1" }, { session: { userId: "u9" } }), "session")).toBe("u:u9");
    expect(await keyOf(ctx({ "cf-connecting-ip": "1.1.1.1" }, {}), "session")).toBe("ip:1.1.1.1");
    expect(await keyOf(ctx({ "cf-connecting-ip": "1.1.1.1" }), () => undefined)).toBe("1.1.1.1"); // function sources fall back to the bare ip
    expect(await keyOf(ctx(), () => "tenant-5")).toBe("tenant-5");
  });
  it("memory limiter: window resets, remaining/retryAfter, prunes expired entries past max", () => {
    let t = 0; const l = memoryLimiter({ limit: 2, period: 10, now: () => t, max: 1 });
    expect(l.limit("a")).toMatchObject({ ok: true, remaining: 1 });
    l.limit("a");
    expect(l.limit("a")).toMatchObject({ ok: false, remaining: 0, retryAfter: 10 });
    t = 4000; expect((l.limit("a") as any).retryAfter).toBe(6);
    l.limit("b"); l.limit("c");
    t = 11_000; expect(l.limit("a")).toMatchObject({ ok: true });
  });
  it("check: over-limit -> 429 with Retry-After; scope separates paths", async () => {
    const o = { limit: 1, period: 30 } as const; const fb = {};
    expect((await check(ctx({ "cf-connecting-ip": "9.9.9.9" }), o, fb)).res).toBeUndefined();
    const r = (await check(ctx({ "cf-connecting-ip": "9.9.9.9" }), o, fb)).res!;
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(tooMany(5, "slow").status).toBe(429);
  });
  it("check: limiter failure fails OPEN by default but CLOSED with failOpen:false", async () => {
    const boom = { limit() { throw new Error("DO down"); } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await check(ctx(), { limiter: boom }, {})).toEqual({});
    const closed = await check(ctx(), { limiter: boom, failOpen: false, message: "busy" }, {});
    expect(closed.res!.status).toBe(429);
    warn.mockRestore();
  });
  it("check: binding limiter used when present in env, memory otherwise; limiter function form", async () => {
    const binding = { limit: vi.fn(async () => ({ success: false })) };
    const r = await check(ctx({}, {}, { RL: binding }), { binding: "RL", period: 12 }, {});
    expect(r.res!.headers.get("retry-after")).toBe("12");
    expect(binding.limit).toHaveBeenCalledWith({ key: "/login|ip:unknown" });
    expect((await check(ctx({}, {}, {}), { binding: "RL", limit: 5 }, {})).res).toBeUndefined();
    expect((await bindingLimiter(binding).limit("k")).ok).toBe(false);
    expect((await check(ctx(), { limiter: () => memoryLimiter({ limit: 0, period: 1 }) }, {})).res!.status).toBe(429);
  });
  it("rateLimit middleware end-to-end", async () => {
    const a = new Hono(); a.use("*", rateLimit({ limit: 2, period: 60 })); a.get("/", (c) => c.text("ok"));
    const go = () => a.request("/", { headers: { "cf-connecting-ip": "5.5.5.5" } });
    expect([(await go()).status, (await go()).status, (await go()).status]).toEqual([200, 200, 429]);
    expect((await a.request("/", { headers: { "cf-connecting-ip": "6.6.6.6" } })).status).toBe(200);
  });
});

describe("routeconf runtime", () => {
  const r = (src: string, extra: object = {}) => ({ re: compileSource(src).re, ...extra });
  const rq = (p: string, h: Record<string, string> = {}) => new Request("https://x.test" + p, { headers: h });
  it("compileSource rejects unsupported shapes (build error, not a guess)", () => {
    expect(() => compileSource("nope")).toThrow(/must start/);
    expect(() => compileSource("/a/*/b")).toThrow(/last segment/);
    expect(() => compileSource("/a/:x*/b")).toThrow(/last segment/);
    expect(() => compileSource("/a/(b|c)")).toThrow(/unsupported/);
    expect(() => compileSource("/a/b*")).toThrow(/unsupported/);
  });
  it("compileSource kinds + trailing slash", () => {
    expect(compileSource("/a/b")).toMatchObject({ kind: "static", base: "/a/b" });
    expect(compileSource("/a/:id")).toMatchObject({ kind: "param", names: ["id"] });
    expect(compileSource("/a/:r*")).toMatchObject({ kind: "splat", splat: "r" });
    expect(compileSource("/a/:r+")).toMatchObject({ kind: "splat1" });
    expect(compileSource("/a/*")).toMatchObject({ kind: "splat", splat: "splat" });
    expect(new RegExp(compileSource("/a/").re).test("/a")).toBe(true);
    expect(new RegExp(compileSource("/a.b").re).test("/aXb")).toBe(false); // '.' is literal
    expect(compileSource("/").re).toBe("^/$");
  });
  it("expand: empty splat drops its slash, unknown placeholder -> empty", () => {
    expect(expand("/guide/:rest*", {})).toBe("/guide");
    expect(expand("/guide/:rest*", { rest: "a/b" })).toBe("/guide/a/b");
    expect(expand("/x/:id", {})).toBe("/x/");
  });
  it("conditions: header/cookie/host/query, regex is anchored, missing is fail-closed on presence", () => {
    const u = (p: string, h = {}) => { const q = rq(p, h); return [q, new URL(q.url)] as const; };
    const rule = (has: any[], missing?: any[]) => ({ ...r("/p"), has, missing });
    expect(matchRule(rule([{ type: "cookie", key: "s", value: "a=b" }]), ...u("/p", { cookie: "x=1; s=a=b" }))).toEqual({});
    expect(matchRule(rule([{ type: "cookie", key: "s" }]), ...u("/p", { cookie: "x=1" }))).toBeNull();
    expect(matchRule(rule([{ type: "host", value: "x.test" }]), ...u("/p"))).toEqual({});
    expect(matchRule(rule([{ type: "query", key: "a", value: "1" }]), ...u("/p?a=1"))).toEqual({});
    expect(matchRule(rule([{ type: "query", key: "a", value: "1" }]), ...u("/p?a=12"))).toBeNull();
    expect(matchRule(rule([{ type: "header", key: "ua", value: "Mob", regex: true }]), ...u("/p", { ua: "Mobile" }))).toBeNull(); // anchored
    expect(matchRule(rule([{ type: "header", key: "ua", value: "Mob.*", regex: true }]), ...u("/p", { ua: "Mobile" }))).toEqual({});
    expect(matchRule(rule([], [{ type: "query", key: "no" }]), ...u("/p?no=1"))).toBeNull();
  });
  it("redirect target cannot become another origin via splat (//evil.com, backslashes)", () => {
    const t: RouteTable = { redirects: [{ ...r("/go/:p*"), to: "/:p*" }], rewrites: [], headers: [] };
    for (const p of ["/go//evil.com", "/go/%2Fevil.com", "/go/\\evil.com", "/go///evil.com/x"]) {
      const res = redirectFor(t, rq(p))!;
      if (res) expect(new URL(res.headers.get("location")!).origin, p).toBe("https://x.test");
    }
    const loc = redirectFor(t, rq("/go//evil.com"))!.headers.get("location")!;
    expect(loc).toBe("https://x.test/evil.com");
  });
  it("redirect keeps the query unless the destination defines one; default 308; absolute target passes through", () => {
    const t: RouteTable = { redirects: [
      { ...r("/a"), to: "/b" }, { ...r("/c"), to: "/d?x=1", status: 301 }, { ...r("/e"), to: "https://other.test/f" },
    ], rewrites: [], headers: [] };
    const a = redirectFor(t, rq("/a?q=1"))!;
    expect(a.status).toBe(308); expect(a.headers.get("location")).toBe("https://x.test/b?q=1");
    expect(redirectFor(t, rq("/c?q=1"))!.headers.get("location")).toBe("https://x.test/d?x=1");
    expect(redirectFor(t, rq("/e?q=1"))!.headers.get("location")).toBe("https://other.test/f?q=1");
    expect(redirectFor(t, rq("/zzz"))).toBeNull();
  });
  it("rewriteFor flags external targets", () => {
    const t: RouteTable = { redirects: [], headers: [], rewrites: [{ ...r("/api/:p*"), to: "https://up.test/v1/:p*" }, { ...r("/m/:id"), to: "/mobile/:id" }] };
    expect(rewriteFor(t, rq("/api/a/b"))).toEqual({ url: "https://up.test/v1/a/b", external: true });
    expect(rewriteFor(t, rq("/m/3"))).toEqual({ url: "https://x.test/mobile/3", external: false });
    expect(rewriteFor({ ...t, rewrites: [{ ...r("/s"), to: "https://x.test/t" }] }, rq("/s"))!.external).toBe(false);
  });
  it("applyHeaders: first occurrence sets, later same-name appends", () => {
    const h = new Headers({ "x-a": "old" });
    applyHeaders(h, [["X-A", "1"], ["x-a", "2"], ["x-b", "3"]]);
    expect(h.get("x-a")).toBe("1, 2"); expect(h.get("x-b")).toBe("3");
  });
  describe("middleware", () => {
    const run = async (table: RouteTable, req: Request, opts: { env?: any; app?: any; next?: () => Promise<void>; res?: Response } = {}) => {
      const self: any = { app: opts.app };
      const c: any = { req: { raw: req }, env: opts.env ?? {}, executionCtx: {}, res: opts.res ?? new Response("page") };
      const out = await routeconfMiddleware(table, self)(c, opts.next ?? (async () => {}));
      return out ?? c.res;
    };
    const H = (p: string) => ({ ...r(p), headers: [["x-h", "1"]] as [string, string][] });
    it("redirect wins and still gets matching headers", async () => {
      const res = await run({ redirects: [{ ...r("/a"), to: "/b" }], rewrites: [], headers: [H("/a")] }, rq("/a"));
      expect(res.status).toBe(308); expect(res.headers.get("x-h")).toBe("1");
    });
    it("internal rewrite re-dispatches with the loop marker; 404 falls back to ASSETS", async () => {
      const seen: Request[] = [];
      const app = { fetch: async (q: Request) => { seen.push(q); return new Response("nf", { status: 404 }); } };
      const assets = { fetch: vi.fn(async () => new Response("asset")) };
      const t: RouteTable = { redirects: [], rewrites: [{ ...r("/m/:id"), to: "/mobile/:id" }], headers: [H("/m/:id")] };
      const res = await run(t, rq("/m/1"), { app, env: { ASSETS: assets } });
      expect(await res.text()).toBe("asset");
      expect(seen[0].headers.get(REWRITTEN)).toBe("1");
      expect(new URL(seen[0].url).pathname).toBe("/mobile/1");
      expect(res.headers.get("x-h")).toBe("1");
    });
    it("a request already marked rewritten is never rewritten again (no loop)", async () => {
      const app = { fetch: vi.fn() };
      const next = vi.fn(async () => {});
      await run({ redirects: [], rewrites: [{ ...r("/loop"), to: "/loop" }], headers: [] }, rq("/loop", { [REWRITTEN]: "1" }), { app, next });
      expect(app.fetch).not.toHaveBeenCalled(); expect(next).toHaveBeenCalled();
    });
    it("external rewrite proxies via fetch()", async () => {
      const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("up"));
      const res = await run({ redirects: [], rewrites: [{ ...r("/api/:p*"), to: "https://up.test/:p*" }], headers: [] }, rq("/api/x"));
      expect(await res.text()).toBe("up"); expect((f.mock.calls[0][0] as Request).url).toBe("https://up.test/x");
      f.mockRestore();
    });
    it("headers applied on the way out for normal responses; none -> untouched", async () => {
      const res = await run({ redirects: [], rewrites: [], headers: [H("/p")] }, rq("/p"));
      expect(res.headers.get("x-h")).toBe("1");
      const plain = await run({ redirects: [], rewrites: [], headers: [H("/other")] }, rq("/p"));
      expect(plain.headers.has("x-h")).toBe(false);
    });
  });
});

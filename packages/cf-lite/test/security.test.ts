import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { addNonce, baseHeaders, buildCsp, cspHash, hashesFor, inlineBlocks, makeNonce, security, staticHeaders } from "../src/modules/csp.js";
import { memoryLimiter, rateLimit, rateLimited, RateLimiterDO } from "../src/modules/ratelimit.js";

describe("csp", () => {
  it("strict preset has no unsafe-inline for scripts and locks down framing/objects/base", () => {
    const p = buildCsp();
    expect(p).toMatch(/script-src 'self'(;|$)/);
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(p).toContain("style-src-attr 'unsafe-inline'");
    expect(buildCsp({ styleAttr: false })).not.toContain("style-src-attr");
  });
  it("overrides merge per directive, false removes, dynamic sources are added", () => {
    const p = buildCsp({ csp: { "img-src": ["'self'", "https://cdn.test"], "frame-ancestors": false }, reportUri: "/csp" }, { scriptSrc: ["'nonce-abc'"] });
    expect(p).toContain("img-src 'self' https://cdn.test");
    expect(p).not.toContain("frame-ancestors");
    expect(p).toContain("script-src 'self' 'nonce-abc'");
    expect(p).toContain("report-uri /csp");
  });
  it("base headers: hsts opt-in, overrides and removal", () => {
    expect(baseHeaders()["Strict-Transport-Security"]).toBeUndefined();
    expect(baseHeaders({ hsts: { includeSubDomains: true } })["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    const h = baseHeaders({ headers: { "x-content-type-options": false, "X-Extra": "1" } });
    expect(h["X-Content-Type-Options"]).toBeUndefined();
    expect(h["X-Extra"]).toBe("1");
  });
  it("hashes inline executable scripts and styles only", async () => {
    const html = `<script>var a=1</script><script src="/x.js"></script><script type="application/ld+json">{"a":1}</script><script type="module">import 'x'</script><style>p{color:red}</style>`;
    const b = inlineBlocks(html);
    expect(b.scripts).toEqual(["var a=1", "import 'x'"]);
    expect(b.styles).toEqual(["p{color:red}"]);
    const h = await hashesFor([html, html]);
    expect(h.scriptSrc).toHaveLength(2);
    expect(h.scriptSrc).toContain(await cspHash("var a=1"));
    const sh = await staticHeaders([html], { reportOnly: true });
    expect(sh).toMatch(/^\/\*\n/);
    expect(sh).toContain("Content-Security-Policy-Report-Only:");
    expect(sh).toContain(await cspHash("var a=1"));
  });
  it("nonce: 128 bits, unique, stamped on scripts/styles keeping quoted `>` in attributes intact", () => {
    const a = makeNonce(), b = makeNonce();
    expect(a).not.toBe(b);
    expect(atob(a)).toHaveLength(16);
    const out = addNonce(`<script>1</script><script nonce="x">2</script><style>p{}</style><script data-x=">">3</script>`, "N");
    expect(out).toBe(`<script nonce="N">1</script><script nonce="x">2</script><style nonce="N">p{}</style><script nonce="N" data-x=">">3</script>`);
  });
  it("security() middleware: nonce CSP on HTML, base headers everywhere, hash policy from assets is kept", async () => {
    const app = new Hono();
    app.use("*", security({ dev: true }));
    app.get("/", (c) => c.html(`<script nonce="${c.get("cspNonce")}">1</script>`));
    app.get("/api", (c) => c.json({ ok: 1 }));
    app.get("/static", (c) => c.html("<p>x</p>", 200, { "content-security-policy": "default-src 'none'" }));
    let r = await app.request("/");
    const csp = r.headers.get("content-security-policy")!;
    const n = /'nonce-([^']+)'/.exec(csp)![1];
    expect(await r.text()).toContain(`nonce="${n}"`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    r = await app.request("/api");
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    r = await app.request("/static");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
  });
  it("security({csp:false}) sends only the base headers; reportOnly switches the header", async () => {
    const a = new Hono(); a.use("*", security({ csp: false, dev: true })); a.get("/", (c) => c.html("x"));
    const r = await a.request("/");
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("referrer-policy")).toBeTruthy();
    const b = new Hono(); b.use("*", security({ reportOnly: true, dev: true })); b.get("/", (c) => c.html("x"));
    const r2 = await b.request("/");
    expect(r2.headers.get("content-security-policy-report-only")).toBeTruthy();
    expect(r2.headers.get("content-security-policy")).toBeNull();
  });
});

describe("ratelimit", () => {
  it("memoryLimiter: fixed window, resets, keys independent", () => {
    let t = 0;
    const l = memoryLimiter({ limit: 2, period: 10, now: () => t });
    expect(l.limit("a")).toMatchObject({ ok: true, remaining: 1 });
    expect(l.limit("a")).toMatchObject({ ok: true, remaining: 0 });
    const over = l.limit("a") as { ok: boolean; retryAfter: number };
    expect(over.ok).toBe(false);
    expect(over.retryAfter).toBe(10);
    expect((l.limit("b") as { ok: boolean }).ok).toBe(true);
    t = 4000;
    expect((l.limit("a") as { retryAfter: number }).retryAfter).toBe(6);
    t = 10_001;
    expect((l.limit("a") as { ok: boolean }).ok).toBe(true);
  });
  const mk = (o: Parameters<typeof rateLimit>[0]) => { const a = new Hono(); a.use("*", rateLimit(o)); a.get("/", (c) => c.text("ok")); return a; };
  const req = (a: Hono, ip = "1.1.1.1", env?: unknown) => a.request("/", { headers: { "cf-connecting-ip": ip } }, env as never);
  it("middleware: 429 + Retry-After over the limit, per-IP keys", async () => {
    const a = mk({ limit: 2, period: 30 });
    expect((await req(a)).status).toBe(200);
    expect((await req(a)).status).toBe(200);
    const r = await req(a);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await req(a, "2.2.2.2")).status).toBe(200);
  });
  it("uses the ratelimit binding when present in env", async () => {
    const seen: string[] = [];
    const binding = { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: seen.length < 2 }; } };
    const a = mk({ binding: "RL" });
    expect((await req(a, "9.9.9.9", { RL: binding })).status).toBe(200);
    expect((await req(a, "9.9.9.9", { RL: binding })).status).toBe(429);
    expect(seen[0]).toContain("ip:9.9.9.9");
  });
  it("limiter failure: fails open by default, closed with failOpen:false", async () => {
    const bad = { limit() { throw new Error("boom"); } };
    expect((await req(mk({ limiter: bad }))).status).toBe(200);
    expect((await req(mk({ limiter: bad, failOpen: false }))).status).toBe(429);
  });
  it("rateLimited() wraps an action: over the limit returns the 429 Response, handler not run", async () => {
    let ran = 0;
    const act = rateLimited({ limit: 1, period: 60 }, () => { ran++; return "done"; });
    const c = { req: { url: "https://x.test/a", header: (h: string) => (h === "cf-connecting-ip" ? "3.3.3.3" : undefined) }, env: {}, get: () => undefined } as never;
    expect(await act(new FormData(), c)).toBe("done");
    const r = (await act(new FormData(), c)) as Response;
    expect(r.status).toBe(429);
    expect(ran).toBe(1);
  });
  it("RateLimiterDO: counts, rejected attempts still count, window resets", async () => {
    const store = new Map<string, unknown>();
    let alarm = 0;
    const d = new RateLimiterDO({ storage: { get: async (k: string) => store.get(k) as never, put: async (k: string, v: unknown) => void store.set(k, v), deleteAll: async () => store.clear(), setAlarm: async (t: number) => void (alarm = t) } });
    const hit = async () => (await d.fetch(new Request("https://r/", { method: "POST", body: JSON.stringify({ limit: 2, period: 60 }) }))).json() as Promise<{ ok: boolean }>;
    expect((await hit()).ok).toBe(true);
    expect((await hit()).ok).toBe(true);
    expect((await hit()).ok).toBe(false);
    expect(alarm).toBeGreaterThan(Date.now());
    await d.alarm();
    expect((await hit()).ok).toBe(true);
  });
});

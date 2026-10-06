import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileRouteConf, countUserRules, type RouteConf } from "../src/config.js";
import { headersFor, redirectFor, rewriteFor } from "../src/modules/routeconf.js";
import { generate } from "../src/vite.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const golden = (name: string, got: string) => {
  const g = join(here, "golden", name);
  if (process.env.UPDATE_GOLDEN || !existsSync(g)) writeFileSync(g, got);
  expect(got).toBe(readFileSync(g, "utf8"));
};
const req = (u: string, h: Record<string, string> = {}) => new Request("https://x.test" + u, { headers: h });

const CONF: RouteConf = {
  redirects: [
    { source: "/old", destination: "/new", status: 301 },
    { source: "/blog/:slug", destination: "/posts/:slug", status: 301 },
    { source: "/docs/:rest*", destination: "/guide/:rest*" },
    { source: "/legacy/:rest+", destination: "https://archive.example.com/:rest" },
    { source: "/app", destination: "/login", status: 307, missing: [{ type: "cookie", key: "sess" }] },
  ],
  rewrites: [
    { source: "/api-proxy/:path*", destination: "https://upstream.example.com/v1/:path*" },
    { source: "/m/:id", destination: "/mobile/:id", has: [{ type: "header", key: "user-agent", value: "Mobile.*", regex: true }] },
  ],
  headers: [
    { source: "/fonts/:file", headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
    { source: "/:path*", headers: [{ key: "X-Frame-Options", value: "DENY" }] },
    { source: "/eu/:path*", has: [{ type: "host", value: "eu.example.com" }], headers: { "X-Region": "eu" } },
  ],
  security: { "X-Content-Type-Options": "nosniff" },
};

describe("compileRouteConf", () => {
  const c = compileRouteConf(CONF);
  it("golden _redirects", () => golden("routeconf.redirects.txt", c.redirects));
  it("golden _headers", () => golden("routeconf.headers.txt", c.headers));
  it("golden worker-first globs + report", () => golden("routeconf.worker.json", JSON.stringify({ workerFirst: c.workerFirst.sort(), report: c.report }, null, 2) + "\n"));
  it("conditional + rewrite rules reach the Worker only for their own glob", () => {
    expect(c.workerFirst).toContain("/app");
    expect(c.workerFirst).toContain("/m/*");
    expect(c.workerFirst).not.toContain("/*");
    expect(c.workerFirst).not.toContain("/blog/*"); // static + placeholder redirects stay in the assets layer
    expect(c.workerFirst).not.toContain("/old");
  });
  it("no conditional rules -> nothing Worker-first", () => {
    expect(compileRouteConf({ redirects: [{ source: "/a", destination: "/b" }], headers: [{ source: "/*", headers: { A: "b" } }] }).workerFirst).toEqual([]);
  });
});

describe("limits", () => {
  it("static overflow errors with counts and the Bulk Redirects hint", () => {
    const redirects = Array.from({ length: 2001 }, (_, i) => ({ source: `/r${i}`, destination: "/x" }));
    expect(() => compileRouteConf({ redirects })).toThrow(/2001 static redirects \(limit 2000\).*Bulk Redirects/);
  });
  it("dynamic + header overflow", () => {
    const redirects = Array.from({ length: 101 }, (_, i) => ({ source: `/r${i}/:id`, destination: "/x/:id" }));
    expect(() => compileRouteConf({ redirects })).toThrow(/101 dynamic .*limit 100/);
    const headers = Array.from({ length: 101 }, (_, i) => ({ source: `/h${i}`, headers: { A: "b" } }));
    expect(() => compileRouteConf({ headers })).toThrow(/101 header rules \(limit 100\)/);
  });
  it("counts rules in the user's public/_redirects", () => {
    const u = countUserRules("/a /b\n# c\n/x/:y /z/:y\n", "/p\n  A: b\n");
    expect(u).toEqual({ staticRedirects: 1, dynamicRedirects: 1, headerRules: 1 });
    expect(() => compileRouteConf({ redirects: [{ source: "/a", destination: "/b" }] }, { reserved: { staticRedirects: 2000 } })).toThrow(/2001 static/);
  });
});

describe("validation", () => {
  it("rejects open-redirect shaped destinations and undefined placeholders", () => {
    expect(() => compileRouteConf({ redirects: [{ source: "/a/:p*", destination: "/:p*" }] })).toThrow(/wildcard placeholder/);
    expect(() => compileRouteConf({ redirects: [{ source: "/a", destination: "//evil.com" }] })).toThrow(/single "\/"/);
    expect(() => compileRouteConf({ redirects: [{ source: "/a/:p", destination: "https://:p.evil.com/" }] })).toThrow(/host/);
    expect(() => compileRouteConf({ redirects: [{ source: "/a", destination: "/b/:nope" }] })).toThrow(/:nope/);
    expect(() => compileRouteConf({ redirects: [{ source: "/a", destination: "/b", status: 200 as never }] })).toThrow(/status/);
    expect(() => compileRouteConf({ headers: [{ source: "/a", headers: { "Bad\nName": "x" } }] })).toThrow(/invalid header/);
    expect(() => compileRouteConf({ redirects: [{ source: "/a/:p*/b", destination: "/x" }] })).toThrow(/last segment/);
  });
  it("splat cannot turn a path target into another origin at runtime", () => {
    const { table } = compileRouteConf({ redirects: [{ source: "/go/:p*", destination: "/t/:p*" }, { source: "/z/:p*", destination: "/:p" }] });
    expect(redirectFor(table, req("/go//evil.com"))!.headers.get("location")).toBe("https://x.test/t//evil.com");
    expect(redirectFor(table, req("/z/a"))!.headers.get("location")).toBe("https://x.test/a");
  });
});

describe("runtime table (same semantics as the assets layer + conditions)", () => {
  const { table } = compileRouteConf(CONF);
  it("redirects", () => {
    expect(redirectFor(table, req("/old"))!.status).toBe(301);
    expect(redirectFor(table, req("/blog/hi?x=1"))!.headers.get("location")).toBe("https://x.test/posts/hi?x=1");
    expect(redirectFor(table, req("/docs"))!.headers.get("location")).toBe("https://x.test/guide");
    expect(redirectFor(table, req("/docs/a/b"))!.headers.get("location")).toBe("https://x.test/guide/a/b");
    expect(redirectFor(table, req("/legacy/a/b"))!.headers.get("location")).toBe("https://archive.example.com/a/b");
    expect(redirectFor(table, req("/legacy"))).toBeNull();
    expect(redirectFor(table, req("/nope"))).toBeNull();
  });
  it("has / missing", () => {
    expect(redirectFor(table, req("/app"))!.status).toBe(307);
    expect(redirectFor(table, req("/app", { cookie: "a=1; sess=ok" }))).toBeNull();
    expect(rewriteFor(table, req("/m/7"))).toBeNull();
    expect(rewriteFor(table, req("/m/7", { "user-agent": "Mobile Safari" }))).toEqual({ url: "https://x.test/mobile/7", external: false });
    expect(rewriteFor(table, req("/api-proxy/a/b?q=1"))).toEqual({ url: "https://upstream.example.com/v1/a/b?q=1", external: true });
  });
  it("headers append in rule order; host condition", () => {
    expect(headersFor(table, req("/fonts/a.woff2")).map(([k]) => k)).toEqual(["X-Content-Type-Options", "Cache-Control", "X-Frame-Options"]);
    expect(headersFor(table, req("/eu/x"))).toHaveLength(2);
    const eu = new Request("https://eu.example.com/eu/x");
    expect(headersFor(table, eu).some(([k]) => k === "X-Region")).toBe(true);
  });
});

describe("generate()", () => {
  const mk = (conf?: RouteConf) => {
    const root = mkdtempSync(join(tmpdir(), "rc-"));
    mkdirSync(join(root, "server/api"), { recursive: true });
    writeFileSync(join(root, "server/api/hello.ts"), `import { Hono } from "hono";\nexport default new Hono().get("/", (c) => c.text("hi"));\n`);
    return generate(root, "none", [], conf);
  };
  it("no routeConf -> no routeconf.ts, app.ts untouched", () => {
    const g = mk();
    expect(g.files["routeconf.ts"]).toBeUndefined();
    expect(g.files["app.ts"]).not.toContain("routeconf");
  });
  it("routeConf -> routeconf.ts + front middleware + worker-first only for conditional rules", () => {
    const g = mk(CONF);
    expect(g.files["routeconf.ts"]).toContain("export const table");
    const app = g.files["app.ts"];
    expect(app.indexOf("routeconfMiddleware(rcTable")).toBeGreaterThan(0);
    expect(app.indexOf("routeconfMiddleware(rcTable")).toBeLessThan(app.indexOf('.route("/api", api)'));
    expect(g.workerFirst).toContain("/m/*");
    expect(g.workerFirst).not.toContain("/old");
  });
  it("assets-only config (no conditions) still never adds worker-first globs", () => {
    expect(mk({ redirects: [{ source: "/a", destination: "/b" }] }).workerFirst).toEqual([]);
  });
});

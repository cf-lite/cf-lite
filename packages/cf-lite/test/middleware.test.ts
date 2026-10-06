import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMatcher, compilePattern, fitWorkerFirst, normalizeGatePath, RUN_WORKER_FIRST_LIMIT } from "../src/conventions/middleware.js";
import { builtinConventions } from "../src/conventions/index.js";
import { runConventions } from "../src/generate.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-mw-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};
const matches = (patterns: string[], path: string) => {
  const c = compileMatcher(patterns);
  return c.include.some((r) => new RegExp(r).test(path)) && !c.exclude.some((r) => new RegExp(r).test(path));
};

describe("matcher compile", () => {
  it("/admin/:path* -> worker-first globs /admin and /admin/*", () => {
    expect(compileMatcher(["/admin/:path*"]).globs).toEqual(["/admin", "/admin/*"]);
    expect(compilePattern("/admin/:path+").globs).toEqual(["/admin/*"]);
    expect(compilePattern("/").globs).toEqual(["/"]);
    expect(compilePattern("/:path*").globs).toEqual(["/*"]);
  });
  it("runtime regexes agree with the globs", () => {
    const m = ["/admin/:path*"];
    for (const p of ["/admin", "/admin/", "/admin/x", "/admin/x/y"]) expect(matches(m, p), p).toBe(true);
    for (const p of ["/", "/administrator", "/api/hello", "/x/admin"]) expect(matches(m, p), p).toBe(false);
    expect(matches(["/admin/:path+"], "/admin")).toBe(false);
    expect(matches(["/u/:id"], "/u/7")).toBe(true);
    expect(matches(["/u/:id"], "/u/7/x")).toBe(false);
    expect(matches(["/", "/about"], "/")).toBe(true);
  });
  it("negative patterns exclude (and become ! globs); negatives-only = broad mode", () => {
    const c = compileMatcher(["/:path*", "!/public/:path*", "!/favicon.ico"]);
    expect(c.globs).toEqual(["/*", "!/public", "!/public/*", "!/favicon.ico"]);
    expect(matches(["/:path*", "!/public/:path*"], "/public/a.css")).toBe(false);
    expect(matches(["/:path*", "!/public/:path*"], "/private")).toBe(true);
    expect(matches(["!/public/:path*"], "/anything")).toBe(true);
  });
  it("rejects what it cannot compile exactly", () => {
    expect(() => compilePattern("admin")).toThrow(/start with/);
    expect(() => compilePattern("/a/:p*/b")).toThrow(/last segment/);
    expect(() => compilePattern("/((?!x).*)")).toThrow(/unsupported/);
  });
  it("over the 100-entry limit falls back to /* minus static", () => {
    const many = Array.from({ length: 120 }, (_, i) => `/p${i}/*`);
    const r = fitWorkerFirst(many);
    expect(r.fellBack).toBe(true);
    expect(r.globs).toEqual(["/*", "!/assets/*"]);
    expect(r.conflicts).toEqual([]);
    expect(fitWorkerFirst(many.slice(0, RUN_WORKER_FIRST_LIMIT)).fellBack).toBe(false);
  });
});

describe("gate path normalisation (router-equivalent variants must not skip the middleware)", () => {
  const gated = (patterns: string[], raw: string) => matches(patterns, normalizeGatePath(raw));
  it("trailing slash, doubled slashes and percent-encoded letters reach the same gate", () => {
    for (const raw of ["/admin", "/admin/", "//admin", "/admin//", "/%61dmin", "/%61dmin/"]) expect(gated(["/admin"], raw), raw).toBe(true);
    for (const raw of ["/admin/x", "/admin//x", "/%61dmin/x", "/admin/x/"]) expect(gated(["/admin/:path+"], raw), raw).toBe(true);
    expect(gated(["/:path*", "!/health"], "/%68ealth/")).toBe(false);
  });
  it("encoded slash stays one segment; malformed escapes do not throw", () => {
    expect(normalizeGatePath("/a%2Fb/c")).toBe("/a%2Fb/c");
    expect(normalizeGatePath("/%E0%A4%A")).toBe("/%E0%A4%A");
    expect(normalizeGatePath("/")).toBe("/");
    expect(normalizeGatePath("")).toBe("/");
  });
  it("generated guard normalises before matching", () => {
    const root = tmp({ "server/middleware.ts": `export const config = { matcher: ["/admin"] };\nexport default async (c, next) => { await next(); };\n` });
    const app = runConventions(root, undefined, builtinConventions).files["app.ts"];
    const m = /const mwNorm = (.*);\nconst mwOn = .*;/.exec(app);
    expect(m).toBeTruthy();
    expect(m![1]).toMatch(/^\(p: string\): string =>/); // typed: generated code is type-checked in user apps (noImplicitAny)
    expect(app).toMatch(/const mwOn = \(raw: string\) => \{ const p = mwNorm\(raw\)/);
  });
});

describe("middleware convention", () => {
  const mw = (matcher?: string) => `export const config = { ${matcher ? `matcher: ${matcher}` : ""} };\nexport default async (c, next) => { await next(); };\n`;
  it("no server/middleware.ts -> nothing emitted", () => {
    const g = runConventions(tmp({ "server/api/a.ts": "" }), undefined, builtinConventions);
    expect(g.files["app.ts"]).not.toContain("mwOn");
    expect(g.workerFirst).toEqual([]);
  });
  it("runs before /api and guards by matcher; worker-first globs contributed", () => {
    const root = tmp({ "server/middleware.ts": mw(`["/admin/:path*", "/api/secure/:path*"]`), "server/api/a.ts": "" });
    const g = runConventions(root, undefined, builtinConventions);
    const app = g.files["app.ts"];
    expect(app).toContain(`import mw from "../server/middleware";`);
    expect(app.indexOf("mwOn(c.req.path)")).toBeLessThan(app.indexOf('.route("/api", api)'));
    expect(g.workerFirst).toEqual(["/admin", "/admin/*", "/api/secure", "/api/secure/*"]);
  });
  it("no matcher = broad mode: /* minus static prefixes", () => {
    const g = runConventions(tmp({ "server/middleware.ts": mw() }), undefined, builtinConventions);
    expect(g.workerFirst).toEqual(["/*", "!/assets/*"]);
  });
  it("string matcher, single quotes, negatives; doctor checks", () => {
    const g = runConventions(tmp({ "server/middleware.ts": `export const config = { matcher: ['/:path*', '!/health'] };\nexport const x = 1;\n` }), undefined, builtinConventions);
    expect(g.workerFirst).toEqual(expect.arrayContaining(["/*", "!/health", "!/assets/*"]));
    const warns = g.checks.flatMap((c) => c({}));
    expect(warns.join()).toMatch(/no default export/);
    expect(g.checks.flatMap((c) => c({ assets: { run_worker_first: false } })).join()).toMatch(/run_worker_first is false/);
  });
});

describe("fitWorkerFirst vs Cloudflare's validation", () => {
  it("drops rules a `*` rule already covers (same polarity), keeps them across polarities", () => {
    expect(fitWorkerFirst(["/api/*", "/api/private", "/api/private/*", "/admin", "/admin/*", "!/admin/public", "!/admin/public/*"]).globs)
      .toEqual(["/api/*", "/admin", "/admin/*", "!/admin/public", "!/admin/public/*"]);
  });
  it("prunes against what wrangler already lists; reports existing rules a broad glob would swallow", () => {
    expect(fitWorkerFirst(["/api/private/*", "/admin/*"], ["/api/*"]).globs).toEqual(["/admin/*"]);
    expect(fitWorkerFirst(["/*", "!/assets/*"], ["/api/*"]).conflicts).toEqual(["/api/*"]);
  });
});

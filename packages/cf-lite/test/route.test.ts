import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsRouting, fileToPath, scanHandlers, scanPages, sortRoutes, toWorkerGlobs } from "../src/scan.js";
import { matchPath, matchRoute } from "../src/client.js";
import { isNavigationSignal, notFound, permanentRedirect, redirect } from "../src/navigation.js";
import { fillPath } from "../src/prerender.js";
import { genRoutes, routesConvention, pagesConvention } from "../src/conventions/index.js";
import { runConventions } from "../src/generate.js";
import { builtinConventions } from "../src/conventions/index.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cflite-route-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}

describe("fileToPath: groups + optional catch-all", () => {
  it.each([
    ["(marketing)/pricing.tsx", "/pricing"], ["(a)/(b)/x/index.tsx", "/x"], ["(g)/index.tsx", "/"],
    ["docs/[[...slug]].tsx", "/docs/*?"], ["[[...all]].tsx", "/*?"], ["docs/[...rest].tsx", "/docs/*"],
  ])("%s -> %s", (f, p) => expect(fileToPath(f)).toBe(p));
});

describe("matchPath: * requires a segment, *? does not", () => {
  it("required catch-all", () => {
    expect(matchPath("/docs/*", "/docs/a/b")).toEqual({ "*": "a/b" });
    expect(matchPath("/docs/*", "/docs")).toBeNull();
  });
  it("optional catch-all", () => {
    expect(matchPath("/docs/*?", "/docs")).toEqual({ "*": "" });
    expect(matchPath("/docs/*?", "/docs/a/b")).toEqual({ "*": "a/b" });
    expect(matchPath("/*?", "/")).toEqual({ "*": "" });
    expect(matchPath("/docs/*?", "/other")).toBeNull();
  });
  it("optional catch-all sorts after specific routes", () => {
    const r = sortRoutes([{ path: "/docs/*?" }, { path: "/docs/:id" }, { path: "/docs/intro" }]);
    expect(r.map((x) => x.path)).toEqual(["/docs/intro", "/docs/:id", "/docs/*?"]);
    expect(matchRoute(r as never, "/docs")!.route.path).toBe("/docs/*?");
  });
});

describe("worker globs for optional catch-all", () => {
  it("needs the parent path too", () => {
    expect(toWorkerGlobs("/docs/*?")).toEqual(["/docs", "/docs/*"]);
    expect(toWorkerGlobs("/*?")).toEqual(["/", "/*"]);
    expect(toWorkerGlobs("/posts/:id")).toEqual(["/posts/*"]);
  });
});

describe("scanPages: groups, boundaries, paths()", () => {
  const root = project({
    "app/routes/_layout.tsx": "",
    "app/routes/_not-found.tsx": "export default () => null",
    "app/routes/(marketing)/_layout.tsx": "",
    "app/routes/(marketing)/pricing.tsx": "export default () => null",
    "app/routes/x/_error.tsx": "", "app/routes/x/_loading.tsx": "",
    "app/routes/x/a.tsx": `export const render = "ssr"`,
    "app/routes/x/deep/_error.tsx": "", "app/routes/x/deep/b.tsx": `export const render = "ssr"`,
    "app/routes/blog/[slug].tsx": `export const render = "static"\nexport async function paths() { return [] }`,
    "app/routes/news/[id].tsx": `export const render = "static"\nexport const dynamicParams = true\nexport const paths = async () => []`,
  });
  const pages = scanPages(root), by = (p: string) => pages.find((r) => r.path === p)!;
  it("groups strip from the URL but keep their layout", () => {
    expect(by("/pricing").layouts).toEqual(["app/routes/_layout.tsx", "app/routes/(marketing)/_layout.tsx"]);
  });
  it("boundary files are not routes; nearest directory wins", () => {
    expect(pages.map((p) => p.path).some((p) => /_error|_loading|_not-found/.test(p))).toBe(false);
    expect(by("/x/a").error).toBe("app/routes/x/_error.tsx");
    expect(by("/x/deep/b").error).toBe("app/routes/x/deep/_error.tsx");
    expect(by("/x/deep/b").loading).toBe("app/routes/x/_loading.tsx");
    expect(by("/pricing").error).toBeUndefined();
    expect(by("/pricing").notFound).toBe("app/routes/_not-found.tsx");
  });
  it("static + dynamic is allowed with paths(); dynamicParams = true => SSR fallback", () => {
    expect(by("/blog/:slug")).toMatchObject({ hasPaths: true });
    expect(by("/blog/:slug").ssrFallback).toBeUndefined();
    expect(by("/news/:id")).toMatchObject({ hasPaths: true, ssrFallback: true });
  });
  it("only ssrFallback static routes get Worker globs (prerendered ones stay asset-only)", () => {
    const g = assetsRouting(pages).ssrGlobs;
    expect(g).toContain("/news/*"); expect(g).toContain("/x/a"); expect(g).not.toContain("/blog/*");
  });
  it("two boundaries of one kind in a directory are an error", () => {
    expect(() => scanPages(project({ "app/routes/_error.tsx": "", "app/routes/_error.ts": "" }))).toThrow(/both the error boundary/);
  });
  it("group collisions are caught", () => {
    expect(() => scanPages(project({ "app/routes/(a)/x.tsx": "", "app/routes/(b)/x.tsx": "" }))).toThrow(/both map to \/x/);
  });
});

describe("genRoutes: boundaries + root _not-found", () => {
  const root = project({
    "app/routes/index.tsx": "", "app/routes/_not-found.tsx": "", "app/routes/x/_error.tsx": "", "app/routes/x/a.tsx": "",
  });
  const out = genRoutes(scanPages(root));
  it("adds lazy boundary imports and a last-resort route", () => {
    expect(out).toContain(`error: () => import("../app/routes/x/_error")`);
    expect(out).toContain(`notFound: () => import("../app/routes/_not-found")`);
    expect(out).toMatch(/path: "\/\*\?", render: "spa".*isNotFound: true/);
  });
  it("is byte-identical for apps without boundaries", () => {
    const plain = genRoutes(scanPages(project({ "app/routes/a.tsx": "" })));
    expect(plain).not.toMatch(/loading|error|notFound|isNotFound/);
  });
});

describe("server/routes convention", () => {
  const root = project({ "server/routes/feed.xml.ts": "", "server/routes/og/[slug].ts": "", "server/routes/sw/[[...p]].ts": "" });
  it("scans mounts", () => expect(scanHandlers(root).map((r) => r.mount)).toEqual(["/feed.xml", "/og/:slug", "/sw/*?"]));
  it("emits routes before pages + Worker-first globs", () => {
    const g = runConventions(root, undefined, builtinConventions);
    expect(g.files["app.ts"]).toContain('.route("/feed.xml", h0)');
    expect(g.files["app.ts"]).toContain('.route("/og/:slug", h1)');
    expect(g.files["app.ts"]).toContain('.route("/sw/*", h2)');
    expect(g.workerFirst.sort()).toEqual(["/feed.xml", "/og/*", "/sw", "/sw/*"]);
    expect(routesConvention.name).toBe("routes");
    expect(pagesConvention.name).toBe("pages");
  });
});

describe("pages emit: path / boundaries / static-first", () => {
  it("only adds options when needed", () => {
    const root = project({
      "app/routes/a.tsx": `export const render = "ssr"`,
      "app/routes/d/[[...s]].tsx": `export const render = "ssr"`,
      "app/routes/n/[id].tsx": `export const render = "static"\nexport const dynamicParams = true\nexport const paths = async () => []`,
      "app/routes/_error.tsx": "",
    });
    const ui = { server: "@cf-lite/react/server", extensions: [".tsx"], id: "x", client: "", vite: () => ({ plugins: [] }) } as never;
    const app = runConventions(root, ui, builtinConventions).files["app.ts"];
    expect(app).toMatch(/\.get\("\/d\/\*", ssr\(s\d as never, \{[^}]*path: "\/d\/\*\?"/);
    expect(app).toMatch(/\.on\("GET", \["\/n\/:id", "\/n\/:id\/"\], ssr\(.*staticFirst: true/);
    expect(app).toMatch(/\.get\("\/a", ssr\(s\d as never, \{ ui, hydrate: false, layouts: \[\] as never, error: b0 \}\)\)/);
  });
});

describe("navigation sentinels", () => {
  it("throw typed signals identified by symbol", () => {
    let e: unknown;
    try { notFound(); } catch (x) { e = x; }
    expect(isNavigationSignal(e)).toBe(true); expect((e as any).kind).toBe("not-found");
    try { redirect("/a"); } catch (x) { e = x; }
    expect(e).toMatchObject({ kind: "redirect", url: "/a", status: 307 });
    try { permanentRedirect("/b"); } catch (x) { e = x; }
    expect(e).toMatchObject({ status: 308 });
    expect(isNavigationSignal(new Error("x"))).toBe(false);
    expect(isNavigationSignal(null)).toBe(false);
  });
});

describe("fillPath (paths() -> URL)", () => {
  it("fills params, splats, encodes", () => {
    expect(fillPath("/blog/:slug", { slug: "a b" })).toBe("/blog/a%20b");
    expect(fillPath("/docs/*", { "*": "x/y" })).toBe("/docs/x/y");
    expect(fillPath("/docs/*?", { "*": "" })).toBe("/docs");
    expect(fillPath("/a/:x/b/:y", { x: "1", y: "2" })).toBe("/a/1/b/2");
  });
  it("rejects missing params", () => {
    expect(() => fillPath("/blog/:slug", {})).toThrow(/missing "slug"/);
    expect(() => fillPath("/docs/*", {})).toThrow(/missing/);
  });
});

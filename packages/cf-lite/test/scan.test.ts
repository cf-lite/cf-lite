import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsRouting, detectExports, fileToPath, isLayoutFile, scanApi, scanPages, toWorkerGlob, sortRoutes } from "../src/scan.js";
import { genApp, genRoutes } from "../src/generate.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cflite-"));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}

describe("fileToPath", () => {
  it.each([
    ["index.tsx", "/"], ["about.tsx", "/about"], ["posts/index.tsx", "/posts"],
    ["posts/[id].tsx", "/posts/:id"], ["docs/[...rest].tsx", "/docs/*"],
  ])("%s -> %s", (f, p) => expect(fileToPath(f)).toBe(p));
});

describe("detectExports", () => {
  it("defaults to spa", () => expect(detectExports("export default () => null")).toEqual({ render: "spa", hydrate: false, hasLoader: false, hasCache: false }));
  it("reads render/hydrate/loader", () => {
    expect(detectExports(`export const render = "ssr"; export const hydrate = true; export async function loader(){}`)).toEqual({ render: "ssr", hydrate: true, hasLoader: true, hasCache: false });
    expect(detectExports(`export const render = 'static'`).render).toBe("static");
  });
});

describe("scan", () => {
  it("scans pages + api, specific routes first, ignores tests", () => {
    const root = project({
      "app/routes/index.tsx": "export default () => null",
      "app/routes/[slug].tsx": "export default () => null",
      "app/routes/about.tsx": `export const render = "static"; export default () => null`,
      "app/routes/about.test.tsx": "x",
      "server/api/hello.ts": "export default 1",
      "server/api/users/index.ts": "export default 1",
    });
    const pages = scanPages(root);
    expect(pages.map((p) => p.path)).toEqual(["/about", "/:slug", "/"].sort((a, b) => pages.findIndex((p) => p.path === a) - pages.findIndex((p) => p.path === b)));
    expect(pages.findIndex((p) => p.path === "/about")).toBeLessThan(pages.findIndex((p) => p.path === "/:slug"));
    expect(scanApi(root).map((a) => a.mount)).toEqual(["/hello", "/users"]);
  });
  it("rejects static + dynamic and duplicate paths", () => {
    expect(() => scanPages(project({ "app/routes/[id].tsx": `export const render = "static"` }))).toThrow(/dynamic/);
    expect(() => scanPages(project({ "app/routes/a.tsx": "", "app/routes/a/index.tsx": "" }))).toThrow(/both map/);
  });
  it("empty project is fine", () => expect(scanPages(project({}))).toEqual([]));
});

describe("toWorkerGlob / sortRoutes", () => {
  it("globs", () => {
    expect(toWorkerGlob("/posts/:id")).toBe("/posts/*");
    expect(toWorkerGlob("/ssr")).toBe("/ssr");
    expect(toWorkerGlob("/:a")).toBe("/*");
  });
  it("sorts static before param before splat", () => {
    expect(sortRoutes([{ path: "/*" }, { path: "/:a" }, { path: "/x" }]).map((r) => r.path)).toEqual(["/x", "/:a", "/*"]);
  });
});

describe("generate", () => {
  const pages = [
    { file: "app/routes/index.tsx", path: "/", render: "spa" as const, hydrate: false, hasLoader: false, hasCache: false, layouts: [] as string[] },
    { file: "app/routes/posts/[id].tsx", path: "/posts/:id", render: "ssr" as const, hydrate: false, hasLoader: true, hasCache: false, layouts: ["app/routes/_layout.tsx", "app/routes/posts/_layout.tsx"] },
  ];
  it("routes.ts lazy-imports every page", () => {
    const s = genRoutes(pages);
    expect(s).toContain(`import("../app/routes/index")`);
    expect(s).toContain(`"/posts/:id"`);
  });
  it("app.ts mounts api under /api and registers only ssr pages", () => {
    const s = genApp([{ file: "server/api/hello.ts", mount: "/hello" }], pages);
    expect(s).toContain(`.route("/hello", a0)`);
    expect(s).toContain(`.route("/api", api)`);
    expect(s).toContain(`.get("/posts/:id", ssr(s0`);
    expect(s).not.toContain(`"/", ssr`);
  });
  it("app.ts without ssr pages does not import react-dom/server helper", () => {
    expect(genApp([], [pages[0]])).not.toContain("cf-lite/server");
  });
});

describe("nested layouts", () => {
  const P = "export default () => null";
  it("_layout files are not routes; each page lists ancestor layouts outermost first", () => {
    const root = project({
      "app/routes/_layout.tsx": P, "app/routes/index.tsx": P,
      "app/routes/docs/_layout.tsx": P, "app/routes/docs/intro.tsx": `export const render = "static"`,
      "app/routes/docs/api/_layout.ts": P, "app/routes/docs/api/[fn].tsx": `export const render = "ssr"`,
      "app/routes/other/x.tsx": P,
    });
    const by = Object.fromEntries(scanPages(root).map((p) => [p.path, p.layouts]));
    expect(Object.keys(by).sort()).toEqual(["/", "/docs/api/:fn", "/docs/intro", "/other/x"]);
    expect(by["/"]).toEqual(["app/routes/_layout.tsx"]);
    expect(by["/docs/intro"]).toEqual(["app/routes/_layout.tsx", "app/routes/docs/_layout.tsx"]);
    expect(by["/docs/api/:fn"]).toEqual(["app/routes/_layout.tsx", "app/routes/docs/_layout.tsx", "app/routes/docs/api/_layout.ts"]);
    expect(by["/other/x"]).toEqual(["app/routes/_layout.tsx"]);
  });
  it("no layouts -> empty list; two layouts in one dir is an error", () => {
    expect(scanPages(project({ "app/routes/a.tsx": P }))[0].layouts).toEqual([]);
    expect(() => scanPages(project({ "app/routes/_layout.tsx": P, "app/routes/_layout.ts": P }))).toThrow(/layout/);
  });
  it("isLayoutFile", () => {
    expect(isLayoutFile("a/_layout.tsx")).toBe(true);
    expect(isLayoutFile("a/_layouts.tsx")).toBe(false);
    expect(isLayoutFile("_layout.d.ts")).toBe(false);
  });
  it("generated routes/app import layouts (dedupe, outer first)", () => {
    const pages = [
      { file: "app/routes/a.tsx", path: "/a", render: "ssr" as const, hydrate: false, hasLoader: false, hasCache: false, layouts: ["app/routes/_layout.tsx"] },
      { file: "app/routes/b/c.tsx", path: "/b/c", render: "ssr" as const, hydrate: true, hasLoader: false, hasCache: false, layouts: ["app/routes/_layout.tsx", "app/routes/b/_layout.tsx"] },
    ];
    const app = genApp([], pages);
    expect(app.match(/import \* as l\d+ from/g)).toHaveLength(2);
    expect(app).toContain("layouts: [l0] as never");
    expect(app).toContain("layouts: [l0, l1] as never");
    expect(genRoutes(pages)).toContain(`layouts: [() => import("../app/routes/_layout"), () => import("../app/routes/b/_layout")]`);
  });
});

describe("static / alongside SPA routes", () => {
  const P = "export default () => null";
  it("allowed with fixed-path SPA routes; assets fall back to 404-page", () => {
    const pages = scanPages(project({ "app/routes/index.tsx": `export const render = "static"`, "app/routes/app/dash.tsx": P, "app/routes/s/[id].tsx": `export const render = "ssr"` }));
    expect(assetsRouting(pages)).toMatchObject({ ssrGlobs: ["/s/*"], notFound: "404-page" });
  });
  it("a dynamic SPA route + static / is a build error with a clear message", () => {
    expect(() => scanPages(project({ "app/routes/index.tsx": `export const render = "static"`, "app/routes/u/[id].tsx": P }))).toThrow(/dynamic SPA route.*static "\/"/);
    expect(() => scanPages(project({ "app/routes/index.tsx": `export const render = "static"`, "app/routes/docs/[...r].tsx": P }))).toThrow(/dynamic SPA/);
  });
  it("SPA / keeps the default fallback (notFound null)", () => {
    expect(assetsRouting(scanPages(project({ "app/routes/index.tsx": P }))).notFound).toBeNull();
  });
  it("routing signature changes when an ssr route appears (drives the dev restart)", () => {
    const a = assetsRouting(scanPages(project({ "app/routes/index.tsx": P })));
    const b = assetsRouting(scanPages(project({ "app/routes/index.tsx": P, "app/routes/p/[id].tsx": `export const render = "ssr"` })));
    expect(a.sig).not.toBe(b.sig);
  });
});

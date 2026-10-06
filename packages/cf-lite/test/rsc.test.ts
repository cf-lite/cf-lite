import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectExports, assetsRouting, scanPages } from "../src/scan.js";
import { genApp, genRoutes } from "../src/generate.js";
import { generate } from "../src/vite.js";

const ui = { id: "x", extensions: [".tsx"], client: "x/client", server: "x/server", vite: () => ({ plugins: [] }) };
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cflite-rsc-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), c); }
  return root;
}

describe('render = "rsc" (opt-in, experimental, docs/design/rsc.md)', () => {
  it("is detected, and is Worker-first like ssr", () => {
    expect(detectExports('export const render = "rsc"; export default () => null').render).toBe("rsc");
    const root = project({ "app/routes/r.tsx": 'export const render = "rsc"; export default () => null' });
    expect(assetsRouting(scanPages(root, "app/routes", [".tsx"]), false).ssrGlobs).toEqual(["/r"]);
  });

  it("`export const isr` on an rsc page gets the same Worker wiring as on an ssr page (queue consumer, revalidate endpoint, isrOrigin)", () => {
    const on = project({ "app/routes/r.tsx": 'export const render = "rsc"; export const isr = { maxAge: 60 }; export default () => null' });
    const g = generate(on, ui as never);
    expect(g.files["app.ts"]).toContain("rscRoute({ path: \"/r\", isr: true })");
    expect(g.files["app.ts"]).toContain("isrOrigin()");
    expect(g.files["app.ts"]).toContain("/_isr/revalidate");
    expect(g.files["handlers.ts"]).toContain("queue");
  });

  it("never reaches the client route table (server components must not enter the browser bundle)", () => {
    const root = project({ "app/routes/r.tsx": 'export const render = "rsc"; export default () => null', "app/routes/s.tsx": "export default () => null" });
    const pages = scanPages(root, "app/routes", [".tsx"]);
    expect(genRoutes(pages)).not.toContain('path: "/r"');
    expect(genRoutes(pages)).toContain('path: "/s"');
  });

  it("emits rscRoute + the rsc/browser entries only when a page opts in", () => {
    const on = project({ "app/routes/r.tsx": 'export const render = "rsc"; export default () => null' });
    const g = generate(on, ui as never);
    expect(g.files["app.ts"]).toContain('import { rscRoute, rscActionRoute } from "cf-lite/modules/rsc"');
    expect(g.files["app.ts"]).toContain('rscRoute({ path: "/r" })');
    expect(Object.keys(g.files)).toEqual(expect.arrayContaining(["rsc-entry.tsx", "rsc-browser.tsx"]));
    expect(readFileSync(join(on, ".cf-lite/rsc-entry.tsx"), "utf8")).toContain('"/r": { load: () => import(');

    const off = project({ "app/routes/s.tsx": 'export const render = "ssr"; export default () => null' });
    const h = generate(off, ui as never);
    expect(h.files["app.ts"]).not.toMatch(/rsc/i);
    expect(Object.keys(h.files).some((f) => f.startsWith("rsc"))).toBe(false);
    void genApp;
  });
});

describe("server actions: build-time allowlist", () => {
  it('"use server" only under app/actions/** or *.actions.ts; node_modules and ordinary code ignored', async () => {
    const { rscActions } = await import("../src/vite.js");
    const t = (rscActions("/app") as any).transform as (this: any, c: string, id: string) => void;
    const ctx = { error: (m: string) => { throw new Error(m); } };
    expect(() => t.call(ctx, '"use server";\nexport async function a(){}', "/app/app/x.ts")).toThrow(/only allowed in app\/actions/);
    expect(() => t.call(ctx, "// c\n'use server'\nexport const a = 1", "/app/src/x.tsx?v=1")).toThrow(/allowlist/);
    expect(() => t.call(ctx, '"use server";', "/app/app/actions/g.ts")).not.toThrow();
    expect(() => t.call(ctx, '"use server";', "/app/app/lib/g.actions.ts")).not.toThrow();
    expect(() => t.call(ctx, '"use server"', "/app/node_modules/p/i.js")).not.toThrow();
    expect(() => t.call(ctx, 'export const s = "use server"', "/app/app/x.ts")).not.toThrow();
    expect(() => t.call(ctx, '"use client"', "/app/app/c.tsx")).not.toThrow();
  });
});

describe("rsc P3 generation", () => {
  it("hydrate = false is detected for rsc routes only, POST is mounted, browser entry carries the rsc route patterns", () => {
    const root = project({ "app/routes/p.tsx": 'export const render = "rsc"; export const hydrate = false; export default () => null', "app/routes/q/:id.tsx": 'export const render = "rsc"; export default () => null' });
    const g = generate(root, ui as never);
    expect(g.files["app.ts"]).toContain('rscRoute({ path: "/p", js: false })');
    expect(g.files["app.ts"]).toContain('.post("/p", rscActionRoute({ path: "/p", js: false }))');
    expect(g.files["app.ts"]).toContain('.post("/q/:id", rscActionRoute({ path: "/q/:id" }))');
    expect(JSON.parse(/paths: (\[.*\])/.exec(g.files["rsc-browser.tsx"])![1]).sort()).toEqual(["/p", "/q/:id"]);
    expect(g.files["rsc-browser.tsx"]).toContain("cf-lite/modules/rsc-client");
    expect(g.files["rsc-entry.tsx"]).toContain("loadAction: loadServerAction");
  });
});

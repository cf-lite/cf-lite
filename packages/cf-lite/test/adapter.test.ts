import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileToPath, scanPages } from "../src/scan.js";
import { genApp } from "../src/generate.js";
import { generate } from "../src/vite.js";
import { addUi, patchViteConfig } from "../src/add.js";
import { e2eLogin } from "../src/modules/e2e-login.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-ad-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};

describe("adapter extensions in the scan", () => {
  it(".vue / .svelte route + layout files map to URLs and keep their extension in the import", () => {
    const vue = tmp({ "app/routes/index.vue": "", "app/routes/_layout.vue": "", "app/routes/posts/[id].vue": `<script>export const render = "ssr"</script>`, "app/routes/ignored.tsx": "" });
    const pages = scanPages(vue, "app/routes", [".vue"]);
    expect(pages.map((p) => p.path)).toEqual(["/posts/:id", "/"]);
    expect(pages[0]).toMatchObject({ render: "ssr", layouts: ["app/routes/_layout.vue"] });
    expect(fileToPath("a/b.svelte")).toBe("/a/b");
    const app = genApp([], pages, { server: "@cf-lite/vue/server" });
    expect(app).toContain(`import * as s0 from "../app/routes/posts/[id].vue"`);
    expect(app).toContain(`import * as ui from "@cf-lite/vue/server"`);
    expect(app).toContain("ssr(s0 as never, { ui,");
  });
  it("an app with no ssr route imports no adapter server module", () => {
    expect(genApp([], [], { server: "@cf-lite/zzz/server" })).not.toContain("zzz");
  });
});

describe('renderer "none"', () => {
  it("ignores nothing silently: page files without an adapter are an error that says how to fix it", () => {
    const root = tmp({ "app/routes/index.tsx": "export default () => null" });
    expect(() => generate(root, "none")).toThrow(/cf-lite add/);
  });
  it("API-only app generates, no pages", () => {
    const root = tmp({ "server/api/hello.ts": "export default 1" });
    expect(generate(root, "none").pages).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, ".cf-lite/meta.json"), "utf8"))).toEqual({ adapter: null });
    expect(readFileSync(join(root, ".cf-lite/app.ts"), "utf8")).not.toContain("cf-lite/server");
  });
});

describe("patchViteConfig", () => {
  const base = `import { defineConfig } from "vite";\nimport cfLite from "cf-lite/vite";\n\nexport default defineConfig({ plugins: [cfLite()] });\n`;
  it("adds import + renderer, idempotently", () => {
    const a = patchViteConfig(base, "vue", "@cf-lite/vue")!;
    expect(a).toContain(`import vue from "@cf-lite/vue";`);
    expect(a).toContain("cfLite({ renderer: vue() })");
    expect(patchViteConfig(a, "vue", "@cf-lite/vue")).toBe(a);
  });
  it("handles options object and replaces renderer none / another adapter", () => {
    expect(patchViteConfig(base.replace("cfLite()", `cfLite({ wrangler: {} })`), "svelte", "@cf-lite/svelte")).toContain("cfLite({ renderer: svelte(), wrangler: {} })");
    expect(patchViteConfig(base.replace("cfLite()", `cfLite({ renderer: "none" })`), "react", "@cf-lite/react")).toContain("renderer: react()");
    expect(patchViteConfig(base.replace("cfLite()", `cfLite({ renderer: react() })`), "vue", "@cf-lite/vue")).toContain("renderer: vue()");
  });
  it("gives up (null) on a config it cannot patch", () => expect(patchViteConfig("export default {}", "vue", "@cf-lite/vue")).toBeNull());
});

describe("addUi (no install)", () => {
  const starter = () => tmp({
    "package.json": JSON.stringify({ name: "x", dependencies: { "cf-lite": "*", hono: "^4" } }),
    "vite.config.ts": `import { defineConfig } from "vite";\nimport cfLite from "cf-lite/vite";\nexport default defineConfig({ plugins: [cfLite()] });\n`,
    "index.html": `<div id="root"></div><script type="module" src="/app/main.tsx"></script>`,
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  });
  for (const ui of ["react", "preact", "vue", "svelte"]) {
    it(`${ui}: wires config, deps, entry, starter; second run changes nothing`, async () => {
      const root = starter();
      const first = await addUi(root, ui, { install: false });
      expect(first.changed).toContain("vite.config.ts");
      const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(pj.dependencies[`@cf-lite/${ui}`]).toBeTruthy();
      expect(readFileSync(join(root, "vite.config.ts"), "utf8")).toContain(`renderer: ${ui}()`);
      expect(readFileSync(join(root, "index.html"), "utf8")).toMatch(/src="\/app\/main\.(tsx|ts)"/);
      expect(existsSync(join(root, "app/routes/index." + (ui === "vue" ? "vue" : ui === "svelte" ? "svelte" : "tsx")))).toBe(true);
      const snap = ["package.json", "vite.config.ts", "index.html", "tsconfig.json"].map((f) => readFileSync(join(root, f), "utf8"));
      expect((await addUi(root, ui, { install: false })).changed).toEqual([]);
      expect(["package.json", "vite.config.ts", "index.html", "tsconfig.json"].map((f) => readFileSync(join(root, f), "utf8"))).toEqual(snap);
    });
  }
  it("htmx preset: no adapter package, renderer stays none, fragments route + root attrs; idempotent", async () => {
    const root = tmp({
      "package.json": JSON.stringify({ name: "x", dependencies: { "cf-lite": "*", hono: "^4" } }),
      "vite.config.ts": `import { defineConfig } from "vite";\nimport cfLite from "cf-lite/vite";\nexport default defineConfig({ plugins: [cfLite()] });\n`,
      "index.html": `<div id="root"></div><script type="module" src="/app/main.ts"></script>`,
      "app/main.ts": "// cf-lite:none-starter\n",
    });
    const vite = readFileSync(join(root, "vite.config.ts"), "utf8");
    const first = await addUi(root, "htmx", { install: false });
    expect(first.changed).not.toContain("vite.config.ts");
    expect(readFileSync(join(root, "vite.config.ts"), "utf8")).toBe(vite);
    const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(Object.keys(pj.dependencies)).toEqual(["alpinejs", "cf-lite", "hono", "htmx.org"]);
    expect(pj.devDependencies["@types/alpinejs"]).toBeTruthy();
    expect(readFileSync(join(root, "index.html"), "utf8")).toContain('<div id="root" hx-get="/api/ui" hx-trigger="load" hx-swap="innerHTML">');
    expect(readFileSync(join(root, "app/main.ts"), "utf8")).toContain("Alpine.start()");
    expect(readFileSync(join(root, "server/api/ui.ts"), "utf8")).toContain('hx-post="/api/ui/count"');
    expect(existsSync(join(root, "app/routes"))).toBe(false);
    expect((await addUi(root, "htmx", { install: false })).changed).toEqual([]);
  });
  it("does not overwrite an existing starter route", async () => {
    const root = starter();
    mkdirSync(join(root, "app/routes"), { recursive: true });
    writeFileSync(join(root, "app/routes/index.tsx"), "MINE");
    await addUi(root, "react", { install: false });
    expect(readFileSync(join(root, "app/routes/index.tsx"), "utf8")).toBe("MINE");
  });
});

describe("e2e-login module", () => {
  const app = e2eLogin({ issue: (c, w) => c.json({ user: w.user }) });
  const post = (env: object, headers: Record<string, string> = {}) => app.request("/login", { method: "POST", headers, body: JSON.stringify({ user: "qa" }) }, env);
  it("is inert (404) when no secret is configured", async () => expect((await post({}, { "x-e2e-secret": "anything" })).status).toBe(404));
  it("rejects a wrong or missing secret", async () => {
    expect((await post({ E2E_LOGIN_SECRET: "s3" })).status).toBe(403);
    expect((await post({ E2E_LOGIN_SECRET: "s3" }, { "x-e2e-secret": "s4" })).status).toBe(403);
  });
  it("calls issue() with the right secret", async () => {
    const r = await post({ E2E_LOGIN_SECRET: "s3" }, { "x-e2e-secret": "s3" });
    expect(await r.json()).toEqual({ user: "qa" });
  });
});

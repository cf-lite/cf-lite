import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { stripServerExports, stripServerCode } from "../src/vite-strip.js";

describe("stripServerExports", () => {
  const strip = (c: string, id = "/p/app/routes/x.tsx") => stripServerExports(c, id);
  it("removes loader/actions declarations (const, function, async function)", () => {
    const out = strip(`import { db } from "./db";\nexport const loader = async () => db.secret();\nexport async function actions() { return 1 }\nexport default function P() { return <p/> }`)!;
    expect(out).not.toContain("secret");
    expect(out).not.toContain("actions()");
    expect(out).toContain("export default function P");
    expect(out).toContain("var loader = undefined;");
  });
  it("handles `export { loader, default as Page }` and combined const declarations", () => {
    const out = strip(`const loader = () => "x"; function Page(){}\nexport { loader, Page as default };\nexport const cache = { a: 1 }, isr = { maxAge: 5 };`)!;
    expect(out).toContain("export { Page as default };");
    expect(out).toContain("var cache = undefined, isr = undefined;");
  });
  it("keeps other exports (head, render, metadata) and returns null when nothing to strip", () => {
    expect(strip(`export const render = "ssr"; export const head = () => ({});`)).toBeNull();
    expect(strip(`export const loaders = 1;`)).toBeNull();
  });
  it("tolerates unparsable input", () => expect(strip("export const loader = {{{")).toBeNull());
});

describe("client bundle (real vite build)", () => {
  it("contains no loader/actions body nor their server-only imports; the plugin is client-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "cflite-strip-"));
    mkdirSync(join(root, "app/routes"), { recursive: true });
    writeFileSync(join(root, "server-only.ts"), `export const dbSecret = () => "SERVER_ONLY_IMPORT_SENTINEL";\n`);
    writeFileSync(join(root, "app/routes/x.ts"), [
      `import { dbSecret } from "../../server-only";`,
      `export const render = "ssr";`,
      `export async function loader() { return { v: dbSecret(), m: "LOADER_BODY_SENTINEL" } }`,
      `export const actions = { save: async () => "ACTION_BODY_SENTINEL" };`,
      `export const cache = { maxAge: 60, tags: () => ["CACHE_CFG_SENTINEL"] };`,
      `export default function Page() { return "PAGE_SENTINEL" }`,
    ].join("\n"));
    writeFileSync(join(root, "main.ts"), `import("./app/routes/x.ts").then((m) => console.log(m, m.default()));\n`);
    const out = join(root, "dist");
    await build({ root, logLevel: "silent", configFile: false, plugins: [stripServerCode()], build: { outDir: out, minify: false, rollupOptions: { input: join(root, "main.ts") } } });
    const files = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(out);
    const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(js).toContain("PAGE_SENTINEL");
    for (const s of ["LOADER_BODY_SENTINEL", "ACTION_BODY_SENTINEL", "CACHE_CFG_SENTINEL", "SERVER_ONLY_IMPORT_SENTINEL"]) expect(js).not.toContain(s);
    expect(stripServerCode().applyToEnvironment!({ name: "ssr" } as never)).toBe(false);
  });
});

describe("single-file components", () => {
  const sfc = (c: string, id: string) => stripServerExports(c, id);
  it("vue: strips the plain <script> block, leaves <script setup> and the template alone", () => {
    const src = `<script lang="ts">\nimport { db } from "../db";\nexport const render = "ssr";\nexport async function loader() { return db.secret("VUE_LOADER") }\nexport const actions = { save: async () => "VUE_ACTION" };\n</script>\n<script setup lang="ts">\nconst loader2 = 1;\n</script>\n<template><p>hi</p></template>`;
    const out = sfc(src, "/p/app/routes/x.vue")!;
    expect(out).not.toContain("VUE_LOADER");
    expect(out).not.toContain("VUE_ACTION");
    expect(out).toContain(`export const render = "ssr"`);
    expect(out).toContain("var loader = undefined;");
    expect(out).toContain("<template><p>hi</p></template>");
    expect(out).toContain("const loader2 = 1;");
  });
  it("svelte: strips <script module> (and legacy context=module), not the instance script", () => {
    const mod = `<script module lang="ts">\nexport const loader = async () => "SV_LOADER";\nexport const isr = { maxAge: 1 };\n</script>\n<script>\nlet loader = 1; export let data;\n</script>\n<p>{data}</p>`;
    const out = sfc(mod, "/p/app/routes/x.svelte")!;
    expect(out).not.toContain("SV_LOADER");
    expect(out).toContain("var loader = undefined;");
    expect(out).toContain("let loader = 1; export let data;");
    expect(sfc(`<script context="module">export const actions = {a(){ return "OLD_CTX" }};</script>`, "/p/app/routes/y.svelte")).not.toContain("OLD_CTX");
  });
  it("returns null when an SFC has nothing to strip", () => {
    expect(sfc(`<script lang="ts">export const render = "ssr";</script><template/>`, "/p/app/routes/x.vue")).toBeNull();
    expect(sfc(`<script>let loader = 1;</script>`, "/p/app/routes/x.svelte")).toBeNull();
    expect(sfc(`<template><p>loader</p></template>`, "/p/app/routes/x.vue")).toBeNull();
  });
  it("real builds: vue and svelte client bundles carry no loader/action bodies", async () => {
    const { default: vue } = await import("@vitejs/plugin-vue");
    const { svelte } = await import("@sveltejs/vite-plugin-svelte");
    const cleanup: string[] = [];
    try {
    for (const [ext, plugin, src] of [
      ["vue", () => vue(), `<script lang="ts">\nimport { dbSecret } from "../../server-only";\nexport const render = "ssr";\nexport async function loader() { return dbSecret() + "LOADER_BODY_SENTINEL" }\nexport const actions = { save: async () => "ACTION_BODY_SENTINEL" };\n</script>\n<script setup lang="ts">\nconst msg = "PAGE_SENTINEL";\n</script>\n<template><p>{{ msg }}</p></template>\n`],
      ["svelte", () => svelte(), `<script module lang="ts">\nimport { dbSecret } from "../../server-only";\nexport const render = "ssr";\nexport async function loader() { return dbSecret() + "LOADER_BODY_SENTINEL" }\nexport const actions = { save: async () => "ACTION_BODY_SENTINEL" };\n</script>\n<p>PAGE_SENTINEL</p>\n`],
    ] as const) {
      const root = mkdtempSync(join(process.cwd(), `.tmp-strip-${ext}-`)); // inside the repo so `vue` / `svelte` resolve from node_modules
      cleanup.push(root);
      mkdirSync(join(root, "app/routes"), { recursive: true });
      writeFileSync(join(root, "server-only.ts"), `export const dbSecret = () => "SERVER_ONLY_IMPORT_SENTINEL";\n`);
      writeFileSync(join(root, `app/routes/x.${ext}`), src);
      writeFileSync(join(root, "main.ts"), `import("./app/routes/x.${ext}").then((m) => console.log(m));\n`);
      const out = join(root, "dist");
      await build({ root, logLevel: "silent", configFile: false, plugins: [stripServerCode(), plugin()], build: { outDir: out, minify: false, rollupOptions: { input: join(root, "main.ts") } } });
      const files = (function walk(d: string): string[] { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); })(out);
      const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
      expect(js, ext).toContain("PAGE_SENTINEL");
      for (const s of ["LOADER_BODY_SENTINEL", "ACTION_BODY_SENTINEL", "SERVER_ONLY_IMPORT_SENTINEL"]) expect(js, `${ext} ${s}`).not.toContain(s);
    }
    } finally { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); }
  });
});

/**
 * `cf-lite g page|api|component|test <name>`: scaffold a file that follows the frozen conventions (docs/generators.md).
 * Same contract as `add`: a plain file writer, idempotent, never overwrites, `--dry-run` writes nothing, `--json` is the machine
 * surface (one object on stdout, used by the LLM layer / MCP). Planning is pure (`planGenerate`): it only reads the app to
 * detect the UI adapter and to see which files already exist; `applyPlan` is the only writer.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { appFacts } from "./ai-assets.js";

export const GENERATORS = ["page", "api", "component", "test"] as const;
export type Generator = (typeof GENERATORS)[number];
export const isGenerator = (s: string | undefined): s is Generator => (GENERATORS as readonly string[]).includes(s as string);

export const UIS = ["react", "preact", "solid", "vue", "svelte"] as const;
export type Ui = (typeof UIS)[number];
export const RENDERS = ["static", "ssr", "spa"] as const;

export class GenError extends Error {}

export interface GenOptions {
  ui?: string;
  /** page: `static` (default) | `ssr` | `spa` (no `render` export). */
  render?: string;
  /** page: add a `loader` (static or ssr). */
  loader?: boolean;
  /** component: write an `*.island.tsx` (hydrated in the preview frame; react/preact/solid). */
  island?: boolean;
  /** component: folder-per-component (`Card/Card.tsx`). */
  folder?: boolean;
  /** component: parent folder under `app/` (default `app/components`). */
  dir?: string;
  /** api: also write `mocks/api/<name>.json` (the `MOCK=1` fixture). */
  mock?: boolean;
  /** api: also write `seeds/<name>.d1.json` (for `cfl seed`). */
  seed?: boolean;
  /** test: `page|api|component` (default: detected from the files that exist). */
  kind?: string;
}

export interface PlanFile { path: string; action: "create" | "keep"; content: string }
export interface GenPlan { ok: true; generator: Generator; name: string; ui: Ui | null; files: PlanFile[]; notes: string[] }

const SEGMENT = /^(\[\[\.\.\.[A-Za-z0-9_]+\]\]|\[\.\.\.[A-Za-z0-9_]+\]|\[[A-Za-z0-9_]+\]|\([a-z0-9-]+\)|[a-z0-9][a-z0-9_-]*)$/;
const COMPONENT = /^[A-Z][A-Za-z0-9]*$/;
const API_NAME = /^[a-z0-9][a-z0-9-]*$/;

const has = (dir: string, rel: string) => existsSync(join(dir, rel));
const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const snake = (s: string) => s.replace(/-/g, "_");
const title = (s: string) => s.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export function detectUi(dir: string, override?: string): Ui | null {
  if (override !== undefined) {
    if (!(UIS as readonly string[]).includes(override)) throw new GenError(`--ui must be one of ${UIS.join(", ")} (got "${override}")`);
    return override as Ui;
  }
  const ui = appFacts(dir).ui;
  return (UIS as readonly string[]).includes(ui) ? (ui as Ui) : null;
}
const ext = (ui: Ui) => (ui === "vue" ? "vue" : ui === "svelte" ? "svelte" : "tsx");
const needUi = (ui: Ui | null, what: string): Ui => {
  if (!ui) throw new GenError(`no UI adapter in vite.config.* - ${what} needs one (run \`cf-lite add react\`, or pass --ui)`);
  return ui;
};

/** Public URL of a route file name: groups vanish, `index` is the directory, dynamic segments get a sample value. */
export function routeUrl(name: string): string {
  const segs = name.split("/").filter((s) => !/^\(.*\)$/.test(s)).map((s) => (/^\[\[\.\.\./.test(s) ? "" : /^\[/.test(s) ? "sample" : s)).filter((s, i, a) => s !== "" && !(s === "index" && i === a.length - 1));
  return "/" + segs.join("/");
}

// ---------------------------------------------------------------- templates (one place: the output IS the convention)

export function pageTemplate(ui: Ui, name: string, o: { render: string; loader: boolean }): string {
  const last = name.split("/").pop()!;
  const heading = /^\[|^\(/.test(last) || last === "index" ? title(name.split("/").filter((s) => !/^[[(]/.test(s)).pop() ?? "Home") : title(last);
  const dyn = name.split("/").some((s) => /^\[/.test(s));
  const exports = [
    o.render !== "spa" ? `export const render = ${JSON.stringify(o.render)};` : null,
    `export const head = { title: ${JSON.stringify(heading)} };`,
  ].filter(Boolean) as string[];
  const loaderTs = `export async function loader(c: { req: { param: (k: string) => string; url: string } }) {\n  return { path: new URL(c.req.url).pathname };\n}`;
  const props = `{ params${o.loader ? ", data" : ""} }: { params: Record<string, string>${o.loader ? "; data: { path: string }" : ""} }`;
  const body = (open: string, close: string) => `${open}<h1>${heading}</h1>${dyn ? "<p>{JSON.stringify(params)}</p>" : ""}${o.loader ? "<p>{data.path}</p>" : ""}${close}`;
  if (ui === "vue") {
    const pr = `defineProps<{ params?: Record<string, string>${o.loader ? "; data?: { path: string }" : ""} }>();`;
    return `<script lang="ts">\n${exports.join("\n")}${o.loader ? "\n" + loaderTs : ""}\n</script>\n<script setup lang="ts">\n${dyn || o.loader ? "const props = " : ""}${pr}\n</script>\n\n<template><main><h1>${heading}</h1>${dyn ? "<p>{{ props.params }}</p>" : ""}${o.loader ? "<p>{{ props.data?.path }}</p>" : ""}</main></template>\n`;
  }
  if (ui === "svelte") {
    return `<script module lang="ts">\n  ${exports.join("\n  ")}${o.loader ? "\n  " + loaderTs.replace(/\n/g, "\n  ") : ""}\n</script>\n<script lang="ts">\n  let { params = {}, data = undefined }: { params?: Record<string, string>; data?: { path: string } } = $props();\n</script>\n\n<main><h1>${heading}</h1>${dyn ? "<p>{JSON.stringify(params)}</p>" : ""}${o.loader ? "<p>{data?.path}</p>" : ""}</main>\n`;
  }
  const fn = pascalName(name);
  return `${exports.join("\n")}${o.loader ? "\n" + loaderTs : ""}\n\nexport default function ${fn}(${dyn || o.loader ? props : ""}) {\n  return ${body("<main>", "</main>")};\n}\n`;
}
function pascalName(name: string): string {
  const parts = name.split("/").filter((s) => !/^\(.*\)$/.test(s)).map((s) => s.replace(/[^A-Za-z0-9]+/g, " ")).join(" ").split(/\s+/).filter(Boolean);
  const p = parts.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
  return (/^[A-Za-z]/.test(p) ? p : "Page" + p) + (p.endsWith("Page") ? "" : "Page");
}

export function apiTemplate(name: string): string {
  return `import { Hono } from "hono";\n\ntype Item = { id: string; name: string };\n\n/** /api/${name}: list, get one, create. Typed in the client with \`hc<ApiType>\` from \`.cf-lite/app\`. Swap the stubs for your storage (\`cf-lite add d1\`). */\nexport default new Hono<{ Bindings: Env }>()\n  .get("/", (c) => c.json({ items: [] as Item[] }))\n  .get("/:id", (c) => c.json({ error: "not found" }, 404))\n  .post("/", async (c) => {\n    const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));\n    if (typeof body.name !== "string" || !body.name || body.name.length > 100) return c.json({ error: "name required (max 100 chars)" }, 400);\n    const item: Item = { id: crypto.randomUUID(), name: body.name };\n    return c.json(item, 201);\n  });\n`;
}
export const apiMock = (name: string): string => json({ items: [{ id: "1", name: `${title(name)} one` }, { id: "2", name: `${title(name)} two` }] });
export const apiSeed = (name: string): string => json({ table: snake(name), rows: [{ id: 1, name: `${title(name)} one` }, { id: 2, name: `${title(name)} two` }] });

export function componentTemplate(ui: Ui, name: string): string {
  if (ui === "vue") return `<script setup lang="ts">\nwithDefaults(defineProps<{ label?: string }>(), { label: "${name}" });\n</script>\n\n<template><div class="${lower1(name)}">{{ label }}</div></template>\n`;
  if (ui === "svelte") return `<script lang="ts">\n  let { label = "${name}" }: { label?: string } = $props();\n</script>\n\n<div class="${lower1(name)}">{label}</div>\n`;
  const cls = ui === "solid" ? "class" : "className";
  return `export interface ${name}Props { label?: string }\n\nexport default function ${name}({ label = "${name}" }: ${name}Props) {\n  return <div ${cls}="${lower1(name)}">{label}</div>;\n}\n`;
}
export function statesTemplate(name: string, importPath: string): string {
  return `import { defineStates } from "cf-lite/preview";\nimport ${name} from ${JSON.stringify(importPath)};\n\n/** Named prop sets rendered by \`/__preview\` and \`cfl export\` (docs/preview.md). */\nexport default defineStates(${name}, {\n  default: { label: "${name}" },\n  long: { label: "${name} with a much longer label to check wrapping" },\n  empty: { label: "" },\n});\n`;
}

export function apiTestTemplate(name: string): string {
  return `import { describe, expect, it } from "vitest";\nimport { testApp } from "@cf-lite/testing";\n\ndescribe("/api/${name}", () => {\n  const app = testApp();\n\n  it("GET lists items", async () => {\n    const res = await app.fetch("/api/${name}");\n    expect(res.status).toBe(200);\n    expect(Array.isArray(((await res.json()) as { items: unknown[] }).items)).toBe(true);\n  });\n\n  it("GET unknown id is 404", async () => {\n    expect((await app.fetch("/api/${name}/nope")).status).toBe(404);\n  });\n\n  it("POST validates the body", async () => {\n    const post = (body: unknown) => app.fetch("/api/${name}", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });\n    expect((await post({})).status).toBe(400);\n    expect((await post({ name: "x" })).status).toBe(201);\n  });\n});\n`;
}
export function pageTestTemplate(name: string): string {
  const url = routeUrl(name);
  return `import { describe, expect, it } from "vitest";\nimport { testApp } from "@cf-lite/testing";\n\ndescribe(${JSON.stringify(url)}, () => {\n  it("renders", async () => {\n    const res = await testApp().fetch(${JSON.stringify(url)});\n    expect(res.status).toBe(200);\n    expect(res.headers.get("content-type")).toContain("text/html");\n  });\n});\n`;
}
export function componentTestTemplate(name: string, statesImport: string): string {
  return `import { describe, expect, it } from "vitest";\nimport states from ${JSON.stringify(statesImport)};\n\n// Every state is plain data the preview renders: keep at least one, and keep each a props object or a function returning one.\ndescribe("${name} states", () => {\n  it("defines a default state", () => {\n    expect(Object.keys(states.states)).toContain("default");\n  });\n\n  it.each(Object.entries(states.states))("%s resolves to props", async (_n, s) => {\n    const props = typeof s === "function" ? await s() : s;\n    expect(typeof props).toBe("object");\n  });\n});\n`;
}

// ---------------------------------------------------------------- planning

function checkName(generator: Generator, name: string | undefined): string {
  if (!name) throw new GenError(`usage: cf-lite g ${generator} <name>${generator === "component" ? " (PascalCase)" : ""}`);
  if (generator === "component") { if (!COMPONENT.test(name)) throw new GenError(`component name must be PascalCase letters/digits (got "${name}")`); return name; }
  if (generator === "page") {
    if (name.split("/").some((s) => !SEGMENT.test(s))) throw new GenError(`invalid name "${name}": use route-file segments (about, posts/[id], docs/[...rest], (group)/pricing)`);
    return name;
  }
  if (generator === "test") return name; // validated against the detected kind in planGenerate
  if (!API_NAME.test(name)) throw new GenError(`api name must be lowercase letters, digits and dashes (got "${name}")`);
  return name;
}
function componentLocation(o: GenOptions, name: string, ui: Ui) {
  const parent = (o.dir ?? "app/components").replace(/\/+$/, "");
  if (!/^app(\/[A-Za-z0-9_.-]+)*$/.test(parent) || parent.split("/").includes("..") || /^app\/routes(\/|$)/.test(parent)) throw new GenError(`--dir must be a folder under app/ (not app/routes, no ..): got "${o.dir}"`);
  const base = o.folder ? `${parent}/${name}` : parent;
  const e = o.island ? `island.${ext(ui)}` : ext(ui);
  return { file: `${base}/${name}.${e}`, states: `${base}/${name}.states.ts`, stem: `${base}/${name}` };
}

export function planGenerate(dir: string, generator: Generator, nameArg: string | undefined, o: GenOptions = {}): GenPlan {
  if (!has(dir, "package.json")) throw new GenError("run it in your app directory (no package.json here)");
  const name = checkName(generator, nameArg);
  const files: PlanFile[] = [];
  const notes: string[] = [];
  const add = (path: string, content: string) => files.push({ path, action: has(dir, path) ? "keep" : "create", content });
  let ui: Ui | null = null;

  if (generator === "page") {
    ui = needUi(detectUi(dir, o.ui), "a page");
    const render = o.render ?? "static";
    if (!(RENDERS as readonly string[]).includes(render)) throw new GenError(`--render must be one of ${RENDERS.join(", ")} (got "${render}")`);
    if (o.loader && render === "spa") throw new GenError("--loader needs --render static|ssr (a spa page has no server loader)");
    const dyn = name.split("/").some((s) => /^\[/.test(s));
    if (dyn && render === "static") notes.push("a dynamic static page also needs `export const paths = ...` (docs/routing.md), or use --render ssr");
    add(`app/routes/${name}.${ext(ui)}`, pageTemplate(ui, name, { render, loader: !!o.loader }));
    notes.push(`URL: ${routeUrl(name)}`, "typed routes regenerate on `cf-lite prepare`");
  } else if (generator === "api") {
    add(`server/api/${name}.ts`, apiTemplate(name));
    if (o.mock) add(`mocks/api/${name}.json`, apiMock(name));
    if (o.seed) { add(`seeds/${name}.d1.json`, apiSeed(name)); notes.push(`seed table "${snake(name)}" must exist: \`cf-lite db new create_${snake(name)}\`, then \`cf-lite seed\``); }
    notes.push(`mounted at /api/${name} by the api convention (no wiring needed)`);
  } else if (generator === "component") {
    ui = needUi(detectUi(dir, o.ui), "a component");
    if (o.island && !["react", "preact", "solid"].includes(ui)) throw new GenError(`--island is for react|preact|solid (got ${ui}); Vue/Svelte islands use their own conventions`);
    const loc = componentLocation(o, name, ui);
    add(loc.file, componentTemplate(ui, name));
    if (ui === "svelte") notes.push("Svelte has no preview bind() yet: no states file written (docs/preview.md#adapters)");
    else add(loc.states, statesTemplate(name, `./${name}${ui === "vue" ? ".vue" : ""}`));
    notes.push("preview: `cf-lite dev` then /__preview");
  } else {
    const kind = o.kind ?? detectTestKind(dir, name);
    if (kind === "api") { if (!API_NAME.test(name)) throw new GenError(`api name must be lowercase letters, digits and dashes (got "${name}")`); add(`test/api/${name}.test.ts`, apiTestTemplate(name)); }
    else if (kind === "page") { checkName("page", name); add(`test/routes/${name.replace(/[[\]()]/g, "_").replace(/\//g, "-")}.test.ts`, pageTestTemplate(name)); }
    else if (kind === "component") {
      if (!COMPONENT.test(name)) throw new GenError(`component name must be PascalCase (got "${name}")`);
      const st = findStates(dir, name);
      if (!st) throw new GenError(`no ${name}.states.ts under app/ - run \`cf-lite g component ${name}\` first`);
      const rel = relativeImport(`test/components/${name}.states.test.ts`, st);
      add(`test/components/${name}.states.test.ts`, componentTestTemplate(name, rel));
    } else throw new GenError(`--kind must be page|api|component (got "${kind}")`);
    if (!has(dir, "vitest.config.ts")) notes.push("no vitest.config.ts: see docs/testing.md (`cfLiteTest`) before running `bun run test`");
  }
  return { ok: true, generator, name, ui, files, notes };
}

function detectTestKind(dir: string, name: string): string {
  if (COMPONENT.test(name)) return "component";
  if (has(dir, `server/api/${name}.ts`)) return "api";
  for (const e of ["tsx", "vue", "svelte"]) if (has(dir, `app/routes/${name}.${e}`)) return "page";
  throw new GenError(`nothing named "${name}" to test: no server/api/${name}.ts or app/routes/${name}.*; pass --kind page|api|component`);
}
function findStates(dir: string, name: string): string | null {
  const walk = (rel: string): string | null => {
    let ents: Dirent[];
    try { ents = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return null; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { if (e.name === "node_modules" || e.name.startsWith(".")) continue; const r = walk(`${rel}/${e.name}`); if (r) return r; }
      else if (e.name === `${name}.states.ts` || e.name === `${name}.states.tsx`) return `${rel}/${e.name}`;
    }
    return null;
  };
  return walk("app");
}
function relativeImport(from: string, to: string): string {
  const a = dirname(from).split("/"), b = to.replace(/\.tsx?$/, "").split("/");
  while (a.length && b.length > 1 && a[0] === b[0]) { a.shift(); b.shift(); }
  return [...a.map(() => ".."), ...b].join("/").replace(/^(?!\.)/, "./");
}

// ---------------------------------------------------------------- apply / report

export function applyPlan(dir: string, plan: GenPlan, log: (m: string) => void = () => {}): string[] {
  const changed: string[] = [];
  for (const f of plan.files) {
    if (f.action === "keep") { log(`  keep   ${f.path} (exists)`); continue; }
    const p = join(dir, f.path);
    if (existsSync(p)) { log(`  keep   ${f.path} (exists)`); continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.content);
    changed.push(f.path); log(`  create ${f.path}`);
  }
  return changed;
}

/** The `--json` report: the plan as data (content included, so a caller can show the diff before applying). */
export function reportJson(plan: GenPlan, dryRun: boolean): string {
  return JSON.stringify({ ok: true, generator: plan.generator, name: plan.name, ui: plan.ui, dryRun, files: plan.files, notes: plan.notes }, null, 2);
}
export const errorJson = (e: unknown): string => JSON.stringify({ ok: false, error: (e as Error).message }, null, 2);
/** The `--dry-run` text report, same shape as `add --dry-run`: `+ path` for new files. */
export function reportDry(plan: GenPlan): string[] {
  const out = plan.files.map((f) => (f.action === "create" ? `+ ${f.path}` : `= ${f.path} (exists, kept)`));
  return out.length ? out : ["(no changes)"];
}

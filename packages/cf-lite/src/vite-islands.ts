/**
 * Vite side of SSR islands (docs/design/islands.md). `*.island.tsx|jsx` (React, Preact) and `*.island.vue` (Vue) files:
 *   - transform (every environment, and the prerender server): `export default Comp` becomes `export default island(Comp, id, strategy)`; the adapter's
 *     `island()` renders `<cfl-island data-i data-p data-w>` around it. The raw component stays on `.inner`.
 *   - client build: one extra entry `islands` (a virtual module mapping id -> dynamic import) so each island is its own chunk; its URL is
 *     written to `_islands.json` for the Worker / prerender to put in a <script>.
 * Apps without island files get none of this (the plugin is not even added).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAst, type Plugin, type Rollup } from "vite";
type OutputChunk = Rollup.OutputChunk;
import type { UiAdapter } from "./adapter.js";
import { STRATEGIES, type IslandsAuto, type Strategy } from "./islands.js";

export const ISLAND_FILE = /\.island\.(?:[jt]sx|vue)$/;
export const ISLANDS_MANIFEST = "_islands.json";
const VIRTUAL = "virtual:cf-lite-islands";
const COMPAT: Record<string, string> = { react: "preact/compat", "react-dom": "preact/compat", "react-dom/client": "preact/compat/client", "react/jsx-runtime": "preact/jsx-runtime", "react/jsx-dev-runtime": "preact/jsx-runtime" };
const SKIP = new Set(["node_modules", "dist", "build", "coverage"]);

/** Island files under `root` (absolute paths), skipping dot-dirs, node_modules and build output. */
export function findIslandFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (ISLAND_FILE.test(e.name)) out.push(p);
    }
  };
  try { walk(root); } catch { /* unreadable root */ }
  return out.sort();
}
/** Stable island id: the path relative to the root without `.island.tsx` (`app/islands/Counter`). */
export const islandId = (root: string, file: string) => file.slice(root.length + 1).replace(ISLAND_FILE, "");

/** One island entry of a module: `export` is "default" or a named export; `id` is its stable key (`data-i`). */
export interface IslandEntry { id: string; export: string; strategy?: Strategy }
/** A module that contains islands. Marker files (`*.island.tsx`) have one `default` entry whose strategy is read from the file; auto modules list what `adapter.islands.detect` found. */
export interface IslandSpec { file: string; entries: IslandEntry[]; auto?: boolean }
const specOf = (root: string, f: string | IslandSpec): IslandSpec => typeof f !== "string" ? f : { file: f, entries: [{ id: islandId(root, f), export: "default" }] };

const AUTO_SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "test", "tests", "__tests__", "e2e", "generated", "scripts", "server", "worker", "public", "docs"]);
const AUTO_FILE = /\.[jt]sx$/;
const AUTO_NOT = /\.(?:test|spec|stories|island)\.[jt]sx$|(?:^|\/)_(?:layout|not-found|error|loading|og)\.[jt]sx$/;
const autoId = (root: string, file: string) => file.slice(root.length + 1).replace(AUTO_FILE, "");
/** Source files `islands.auto` looks at: `.tsx|jsx` outside routes (`app/routes`), tests, build output and `exclude` prefixes. Pure scan, no detection. */
export function autoCandidates(root: string, auto?: IslandsAuto): string[] {
  const out: string[] = [];
  const skipped = (rel: string) => rel === "app/routes" || (auto?.exclude ?? []).some((x) => rel === x || rel.startsWith(x.replace(/\/$/, "") + "/"));
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name), rel = p.slice(root.length + 1);
      if (e.isDirectory()) { if (!AUTO_SKIP_DIRS.has(e.name) && !skipped(rel)) walk(p); }
      else if (AUTO_FILE.test(e.name) && !AUTO_NOT.test(e.name)) out.push(p);
    }
  };
  try { walk(root); } catch { /* unreadable root */ }
  return out.sort();
}
/** `export const island = false` (a literal) keeps every export of the module out of auto-islands. */
const OPT_OUT = /export\s+const\s+island\s*=\s*false\b/;
const EXPLICIT = /export\s+const\s+client\s*=\s*(["'])([^"']*)\1/;

/** All island modules of the app: marker files, plus (adapter has `detect` and `islands.auto` is on) the interactive components found in plain sources. `warn` receives "not wrapped" reasons. */
export function discoverIslands(root: string, adapter?: UiAdapter, warn?: (msg: string) => void): IslandSpec[] {
  if (!adapter?.islands) return [];
  const specs: IslandSpec[] = findIslandFiles(root).map((f) => specOf(root, f));
  const { detect, auto } = adapter.islands;
  if (!auto || !detect) return specs;
  for (const f of autoCandidates(root, auto)) {
    let src: string;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    if (OPT_OUT.test(src)) continue;
    let found: ReturnType<NonNullable<typeof detect>>;
    try { found = detect(src, f); } catch (e) { warn?.(`${f.slice(root.length + 1)}: auto-island detection failed (${(e as Error).message})`); continue; }
    if (!found) continue;
    const explicit = EXPLICIT.exec(src)?.[2] as Strategy | undefined;
    const base = autoId(root, f), entries: IslandEntry[] = [];
    for (const c of found) {
      if (!c.strategy) { if (c.skip) warn?.(`${f.slice(root.length + 1)}#${c.export}: interactive but not an island: ${c.skip}`); continue; }
      entries.push({ id: c.export === "default" ? base : `${base}#${c.export}`, export: c.export, strategy: explicit ?? c.strategy ?? auto.client ?? "visible" });
    }
    if (entries.length) specs.push({ file: f, entries, auto: true });
  }
  return specs;
}

/** The `export const client = "..."` strategy of an island module's source (default `load`). */
export const islandStrategy = (code: string) => (/export\s+const\s+client\s*=\s*(["'])([^"']*)\1/.exec(code)?.[2] ?? "load") as Strategy;

/** What `_islands.json` carries: the runtime entry, its static import closure, and per island its strategy + chunk files not already in `preload`. */
export interface IslandsManifest { runtime?: string; preload?: string[]; islands?: Record<string, { w: string; deps: string[] }> }

/** Pure rewrite of one island module; exported for unit tests. */
export function wrapIsland(code: string, file: string, id: string, wrap: string, strategy?: Strategy): string {
  const when = strategy ?? islandStrategy(code);
  if (!STRATEGIES.includes(when)) throw new Error(`cf-lite: ${file}: \`export const client = "${when}"\` - expected ${STRATEGIES.map((s) => `"${s}"`).join(" | ")}`);
  // `.vue`: this is the module @vitejs/plugin-vue already compiled (plain JS); the strategy comes from the SFC source, see islandVueTransform
  const ast = parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "jsx" });
  const def = (ast.body as any[]).find((n) => n.type === "ExportDefaultDeclaration");
  if (!def) throw new Error(`cf-lite: ${file}: an island file must \`export default\` its component`);
  const d = def.declaration;
  const body = code.slice(d.start, d.end);
  let name = "__cflInner";
  let out: string;
  if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) { name = d.id.name; out = code.slice(0, def.start) + body + code.slice(def.end); }
  else out = code.slice(0, def.start) + `const ${name} = ${body};` + code.slice(def.end);
  return `import { island as __cflWrap } from ${JSON.stringify(wrap)};\n${out}\nexport default __cflWrap(${name}, ${JSON.stringify(id)}, ${JSON.stringify(when)});\n`;
}

/**
 * Auto-islands: wraps the listed exports of a plain module (default and/or named). The declaration stays as written (minus `export`), so the module's own
 * references keep the raw component; the exported binding becomes `island(Comp, id, strategy, true)`. `true` = soft: props that cannot cross into the
 * browser (functions, children) make the adapter render the component plainly instead of throwing.
 */
export function wrapExports(code: string, file: string, entries: IslandEntry[], wrap: string): string {
  const want = new Map(entries.map((e) => [e.export, e]));
  for (const e of entries) if (!STRATEGIES.includes(e.strategy ?? "load")) throw new Error(`cf-lite: ${file}: strategy "${e.strategy}" - expected ${STRATEGIES.map((x) => `"${x}"`).join(" | ")}`);
  const ast = parseAst(code, { lang: file.endsWith(".tsx") ? "tsx" : "jsx" });
  const edits: Array<[number, number, string]> = []; // [start, end, replacement], applied back to front
  const tail: string[] = [];
  const wrapped = (local: string, exported: string) => {
    const e = want.get(exported)!;
    const w = `__cflW_${exported}`;
    tail.push(`const ${w} = __cflWrap(${local}, ${JSON.stringify(e.id)}, ${JSON.stringify(e.strategy ?? "load")}, true);`);
    return w;
  };
  for (const n of ast.body as any[]) {
    if (n.type === "ExportDefaultDeclaration" && want.has("default")) {
      const d = n.declaration;
      if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) {
        edits.push([n.start, d.start, ""]);
        tail.push(`export default ${wrapped(d.id.name, "default")};`);
      } else if (d.type === "Identifier") {
        edits.push([n.start, n.end, ""]);
        tail.push(`export default ${wrapped(d.name, "default")};`);
      } else {
        edits.push([n.start, d.start, "const __cflInner = "]);
        edits.push([d.end, n.end, ";"]);
        tail.push(`export default ${wrapped("__cflInner", "default")};`);
      }
    } else if (n.type === "ExportNamedDeclaration" && n.declaration && !n.source) {
      const d = n.declaration, declared: string[] = d.type === "VariableDeclaration" ? d.declarations.map((x: any) => x.id.name).filter(Boolean) : d.id ? [d.id.name] : [];
      if (!declared.some((x) => want.has(x))) continue;
      edits.push([n.start, d.start, ""]);
      for (const x of declared) tail.push(want.has(x) ? `export { ${wrapped(x, x)} as ${x} };` : `export { ${x} };`);
    } else if (n.type === "ExportNamedDeclaration" && !n.declaration && !n.source) {
      const specs = n.specifiers as any[];
      if (!specs.some((sp) => want.has(sp.exported.name ?? sp.exported.value))) continue;
      edits.push([n.start, n.end, ""]);
      for (const sp of specs) {
        const out = sp.exported.name ?? sp.exported.value, loc = sp.local.name ?? sp.local.value;
        tail.push(want.has(out) ? `export { ${wrapped(loc, out)} as ${JSON.stringify(out)} };` : `export { ${loc} as ${JSON.stringify(out)} };`);
      }
    }
  }
  let out = code;
  for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + r + out.slice(b);
  return `import { island as __cflWrap } from ${JSON.stringify(wrap)};\n${out}\n${tail.join("\n")}\n`;
}

export function islandTransform(root: string, adapter: UiAdapter, specs: IslandSpec[] = discoverIslands(root, adapter)): Plugin {
  const auto = new Map(specs.filter((x) => x.auto).map((x) => [x.file, x]));
  return {
    name: "cf-lite:islands-transform",
    enforce: "pre",
    transform(code, id) {
      const f = id.split("?")[0]!;
      if (!f.startsWith(root + "/") || f.includes("/node_modules/")) return null;
      const a = auto.get(f);
      if (a) return { code: wrapExports(code, f.slice(root.length + 1), a.entries, adapter.islands!.wrap), map: null };
      if (!ISLAND_FILE.test(f) || f.endsWith(".vue")) return null;
      return { code: wrapIsland(code, f.slice(root.length + 1), islandId(root, f), adapter.islands!.wrap), map: null };
    },
  };
}

/**
 * `*.island.vue`: same wrap, but AFTER @vitejs/plugin-vue compiled the SFC (an SFC is not JS, so the `pre` AST rewrite cannot see its default export).
 * The main module only: sub-block requests carry a `?vue&type=...` query. The strategy is read from the SFC source (`<script>`: `export const client = "idle"`),
 * because under the dev server the compiled main module re-exports the script block instead of containing it.
 */
export function islandVueTransform(root: string, adapter: UiAdapter): Plugin {
  return {
    name: "cf-lite:islands-vue-transform",
    enforce: "post",
    transform(code, id) {
      if (id.includes("?")) return null;
      const f = id;
      if (!/\.island\.vue$/.test(f) || !f.startsWith(root + "/") || f.includes("/node_modules/")) return null;
      let when: Strategy = "load";
      try { when = islandStrategy(readFileSync(f, "utf8")); } catch { /* unreadable: load */ }
      return { code: wrapIsland(code, f.slice(root.length + 1), islandId(root, f), adapter.islands!.wrap, when), map: null };
    },
  };
}

export function islandsBuild(root: string, adapter: UiAdapter, files: Array<string | IslandSpec>, runtime: "react" | "preact"): Plugin {
  const specs = files.map((f) => specOf(root, f));
  let base = "/";
  const resolved = "\0" + VIRTUAL;
  return {
    name: "cf-lite:islands-build",
    enforce: "pre",
    configResolved(c) { base = c.base; },
    configEnvironment(name) {
      if (name === "client") return { build: { rollupOptions: { input: { index: join(root, "index.html"), islands: VIRTUAL } } } };
    },
    // `preact` runtime: the client bundle (islands + any hydrate pages) runs on preact/compat; the server keeps rendering with the real React.
    async resolveId(id, importer, o) {
      if (id === VIRTUAL) return resolved;
      if (runtime !== "preact" || this.environment?.name !== "client") return null;
      const to = COMPAT[id];
      return to ? this.resolve(to, importer, { ...o, skipSelf: true }) : null;
    },
    load(id) {
      if (id !== resolved) return null;
      const rows = specs.flatMap((sp) => sp.entries.map((e) => `  ${JSON.stringify(e.id)}: () => import(${JSON.stringify(sp.file)})${e.export === "default" ? "" : `.then((m) => ({ default: m[${JSON.stringify(e.export)}] }))`},`)).join("\n");
      return `import { start } from "cf-lite/islands-client";\nimport { mount } from ${JSON.stringify(adapter.islands!.mount)};\nstart({\n${rows}\n}, mount);\n`;
    },
    generateBundle(_o, bundle) {
      if (this.environment?.name !== "client") return;
      const entry = Object.values(bundle).find((c) => c.type === "chunk" && c.isEntry && c.name === "islands");
      if (!entry || entry.type !== "chunk") return;
      this.emitFile({ type: "asset", fileName: ISLANDS_MANIFEST, source: JSON.stringify(islandsManifest(bundle as Record<string, OutputChunk | { type: "asset" }>, entry, base, root, specs)) + "\n" });
    },
  };
}

type Bundle = Record<string, OutputChunk | { type: "asset" }>;
/** Static import closure of `file` (itself first), following `imports` only (dynamic imports are separate round trips by design). */
function closure(bundle: Bundle, file: string, seen = new Set<string>()): string[] {
  const c = bundle[file];
  if (!c || c.type !== "chunk" || seen.has(file)) return [];
  seen.add(file);
  return [file, ...c.imports.flatMap((i) => closure(bundle, i, seen))];
}

/**
 * Without hints the browser learns about the chain one hop at a time (runtime entry -> framework chunk -> island chunk -> its own imports).
 * The manifest lists every file of those hops so the server can emit `<link rel=modulepreload>` for all of them next to the runtime `<script>`:
 * `preload` = what every page with islands needs, `islands[id].deps` = what a `load` island adds (other strategies are fetched when they fire).
 */
export function islandsManifest(bundle: Bundle, entry: OutputChunk, base: string, root: string, files: Array<string | IslandSpec>): IslandsManifest {
  const core = closure(bundle, entry.fileName).slice(1);
  const have = new Set([entry.fileName, ...core]);
  const islands: NonNullable<IslandsManifest["islands"]> = {};
  for (const sp of files.map((f) => specOf(root, f))) {
    const f = sp.file;
    const chunk = (Object.values(bundle).find((c) => c.type === "chunk" && (c.facadeModuleId ?? "").split("?")[0] === f) ?? Object.values(bundle).find((c) => c.type === "chunk" && c.moduleIds?.includes(f))) as OutputChunk | undefined;
    if (!chunk) continue;
    let src: string | undefined;
    for (const e of sp.entries) {
      let w: string = e.strategy ?? "load";
      if (!e.strategy) { try { src ??= readFileSync(f, "utf8"); w = islandStrategy(src); } catch { /* unreadable: treat as load */ } }
      islands[e.id] = { w, deps: closure(bundle, chunk.fileName).filter((d) => !have.has(d)).map((d) => base + d) };
    }
  }
  return { runtime: base + entry.fileName, preload: core.map((d) => base + d), islands };
}

/**
 * `cf-lite add <ui>` (also used by create-cf-lite): installs an adapter package and wires it into an existing app.
 * Idempotent - every step checks before it writes, so a second run changes nothing. Edits are text-level on purpose
 * (no config AST): when vite.config.ts is too unusual to patch, it stops with the exact line to add by hand.
 */
import { detectPm } from "./pm.js";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterScaffold } from "./adapter.js";
import { PRESETS, isPreset } from "./presets.js";

/** UI adapter packages, plus built-in presets that keep `renderer: "none"` (htmx = htmx + Alpine over server-rendered Hono fragments). */
export const KNOWN_UI = ["react", "preact", "vue", "svelte", "htmx"] as const;

export interface AddOptions {
  /** Run the package manager (default true). Tests and offline use pass false. */
  install?: boolean;
  log?: (msg: string) => void;
  /** Version range written for the adapter package itself. */
  version?: string;
}
export interface AddResult { changed: string[] }

export const adapterPackage = (ui: string) => (ui.startsWith("@") || ui.includes("/") ? ui : `@cf-lite/${ui}`);

async function loadScaffold(dir: string, pkg: string): Promise<AdapterScaffold> {
  // resolve from the app first, then from where cf-lite itself is installed (monorepo / `bunx cf-lite add` before install)
  for (const base of [join(dir, "package.json"), import.meta.url]) {
    try {
      const file = createRequire(base).resolve(`${pkg}/scaffold`);
      const mod = await import(pathToFileURL(file).href);
      return structuredClone(mod.scaffold ?? mod.default);
    } catch { /* try next base */ }
  }
  throw new Error(`cf-lite add: cannot find ${pkg}/scaffold - is ${pkg} installed?`);
}

const deepMerge = (a: any, b: any): any => {
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
  if (a && b && typeof a === "object" && typeof b === "object") { const o = { ...a }; for (const k of Object.keys(b)) o[k] = k in a ? deepMerge(a[k], b[k]) : b[k]; return o; }
  return a === undefined ? b : a; // existing user value wins
};

/** Patch vite.config.ts so `cfLite({ renderer: <ident>() })`. Returns new text, or null when it cannot. */
export function patchViteConfig(src: string, ident: string, pkg: string): string | null {
  let out = src;
  const importLine = `import ${ident} from "${pkg}";`;
  const call = `${ident}()`;
  if (new RegExp(`renderer:\\s*${ident}\\(\\)`).test(out)) return out.includes(importLine) ? out : addImport(out, importLine);
  if (/renderer:\s*(?:"none"|'none'|[A-Za-z_$][\w$]*\(\))/.test(out)) out = out.replace(/renderer:\s*(?:"none"|'none'|[A-Za-z_$][\w$]*\(\))/, `renderer: ${call}`);
  else if (/cfLite\(\s*\)/.test(out)) out = out.replace(/cfLite\(\s*\)/, `cfLite({ renderer: ${call} })`);
  else if (/cfLite\(\s*\{/.test(out)) out = out.replace(/cfLite\(\s*\{/, `cfLite({ renderer: ${call},`);
  else return null;
  return out.includes(importLine) ? out : addImport(out, importLine);
}
const addImport = (src: string, line: string) => {
  const lines = src.split("\n");
  let last = -1;
  lines.forEach((l, i) => { if (/^import\s/.test(l)) last = i; });
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
};

export async function addUi(dir: string, ui: string, opts: AddOptions = {}): Promise<AddResult> {
  const log = opts.log ?? (() => {});
  const pkg = adapterPackage(ui);
  const ident = ui.replace(/^.*\//, "").replace(/[^A-Za-z0-9_$]/g, "_") || "ui";
  const changed: string[] = [];
  const write = (rel: string, body: string, onlyIfAbsent = false) => {
    const p = join(dir, rel);
    if (existsSync(p)) { if (onlyIfAbsent || readFileSync(p, "utf8") === body) return; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    changed.push(rel);
  };

  const preset = isPreset(ui); // no adapter package, no vite.config change: only files + deps
  // 1. package.json: add the adapter package first so its scaffold descriptor can be resolved, then the framework deps.
  const pjPath = join(dir, "package.json");
  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  pj.dependencies ??= {};
  const before = JSON.stringify(pj);
  if (!preset && !pj.dependencies[pkg]) pj.dependencies[pkg] = opts.version ?? "^0.4.0";
  writeFileSync(pjPath, JSON.stringify(pj, null, 2) + "\n");
  if (opts.install !== false && JSON.stringify(pj) !== before) install(dir, log);
  const sc = preset ? structuredClone(PRESETS[ui]) : await loadScaffold(dir, pkg);
  const pj2 = JSON.parse(readFileSync(pjPath, "utf8"));
  const add = (field: "dependencies" | "devDependencies", deps: Record<string, string> = {}) => {
    for (const [k, v] of Object.entries(deps)) if (!pj2.dependencies?.[k] && !pj2.devDependencies?.[k]) (pj2[field] ??= {})[k] = v;
  };
  add("dependencies", sc.deps); add("devDependencies", sc.devDeps);
  for (const f of ["dependencies", "devDependencies"]) if (pj2[f]) pj2[f] = Object.fromEntries(Object.entries(pj2[f]).sort(([a], [b]) => a.localeCompare(b)));
  const pjText = JSON.stringify(pj2, null, 2) + "\n";
  const depsChanged = pjText !== readFileSync(pjPath, "utf8");
  if (depsChanged || JSON.stringify(pj) !== before) changed.push("package.json");
  writeFileSync(pjPath, pjText);

  // 2. vite.config.ts (presets keep the default renderer)
  if (!preset) {
    const vc = ["vite.config.ts", "vite.config.mts", "vite.config.js"].find((f) => existsSync(join(dir, f)));
    if (!vc) throw new Error("cf-lite add: no vite.config.ts found");
    const src = readFileSync(join(dir, vc), "utf8");
    const patched = patchViteConfig(src, ident, pkg);
    if (patched === null) throw new Error(`cf-lite add: could not patch ${vc}. Add by hand:\n  import ${ident} from "${pkg}";\n  cfLite({ renderer: ${ident}() })`);
    if (patched !== src) { writeFileSync(join(dir, vc), patched); changed.push(vc); }
  }

  // 3. entry + starter files (never overwrite), index.html script src, tsconfig
  const stale = join(dir, "app/main.ts"); // the "none" template's plain-DOM starter entry goes away once a UI owns the page
  if (existsSync(stale) && readFileSync(stale, "utf8").includes("cf-lite:none-starter")) { rmSync(stale); if (sc.entry.file !== "app/main.ts") changed.push("app/main.ts"); }
  write(sc.entry.file, sc.entry.content, true);
  for (const [f, body] of Object.entries(sc.starter)) write(f, body, true);
  const html = join(dir, "index.html");
  if (existsSync(html)) {
    const h = readFileSync(html, "utf8");
    let h2 = h.replace(/(<script type="module" src=")\/app\/main\.[a-z]+(")/, `$1/${sc.entry.file}$2`);
    if (!/id="root"/.test(h2)) h2 = h2.replace(/<body([^>]*)>/, `<body$1><div id="root"></div>`);
    if (sc.rootAttrs && !h2.includes(sc.rootAttrs)) h2 = h2.replace(/<div id="root"([^>]*)>/, `<div id="root"$1 ${sc.rootAttrs}>`);
    if (!/<script type="module"/.test(h2)) h2 = h2.replace("</body>", `<script type="module" src="/${sc.entry.file}"></script></body>`);
    if (h2 !== h) { writeFileSync(html, h2); changed.push("index.html"); }
  }
  if (sc.tsconfig && existsSync(join(dir, "tsconfig.json"))) {
    try {
      const t = readFileSync(join(dir, "tsconfig.json"), "utf8");
      const merged = JSON.stringify(deepMerge(JSON.parse(t), sc.tsconfig), null, 2) + "\n";
      if (merged !== t && JSON.stringify(JSON.parse(merged)) !== JSON.stringify(JSON.parse(t))) { writeFileSync(join(dir, "tsconfig.json"), merged); changed.push("tsconfig.json"); }
    } catch { log("tsconfig.json has comments - not edited; see the adapter README for the options it needs"); }
  }

  // 4. install the framework deps added in step 1
  if (opts.install !== false && depsChanged) install(dir, log);
  log(changed.length ? `added ${preset ? ui : pkg}: ${changed.join(", ")}` : `${pkg} already set up - nothing to change`);
  return { changed };
}

function install(dir: string, log: (m: string) => void) {
  const pm = detectPm(dir);
  log(`${pm} install`);
  const r = spawnSync(pm, ["install"], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${pm} install failed`);
}

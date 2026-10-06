/**
 * `cf-lite analyze`: size report of the last build - Worker bundle (raw + gzip, biggest modules) and client JS per page
 * (JS files a prerendered/built HTML page loads, transitively via modulepreload + static imports in the entry chunks).
 * Pure over a build directory so it is unit-tested with a synthetic dist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { parseJsonc } from "./wrangler-edit.js";

export interface FileSize { file: string; raw: number; gzip: number }
export interface PageReport { page: string; js: FileSize[]; rawTotal: number; gzipTotal: number }
export interface AnalyzeReport { worker: { files: FileSize[]; rawTotal: number; gzipTotal: number } | null; pages: PageReport[]; clientDir: string | null }

const size = (p: string, rel: string): FileSize => { const b = readFileSync(p); return { file: rel, raw: b.length, gzip: gzipSync(b, { level: 9 }).length }; };
const sum = (f: FileSize[], k: "raw" | "gzip") => f.reduce((s, x) => s + x[k], 0);
function* walk(d: string): Generator<string> { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) yield* walk(p); else yield p; } }

/** JS files a chunk pulls in statically: `import "./x.js"`, `from"./x.js"`, and vite's `__vite__mapDeps` preload list is ignored (dynamic). */
export function staticImports(src: string): string[] {
  return [...src.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[^'"();]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g)].map((m) => m[1]);
}

export function analyze(dir: string): AnalyzeReport {
  const report: AnalyzeReport = { worker: null, pages: [], clientDir: null };
  let redirect: string | undefined;
  try { redirect = JSON.parse(readFileSync(join(dir, ".wrangler/deploy/config.json"), "utf8")).configPath; } catch { /* no build */ }
  if (!redirect) return report;
  const cfgPath = join(dir, ".wrangler/deploy", redirect);
  const cfg = parseJsonc<any>(readFileSync(cfgPath, "utf8"));
  const workerDir = join(cfgPath, "..", cfg.main ?? "index.js", "..");
  if (existsSync(workerDir)) {
    const files = [...walk(workerDir)].filter((p) => /\.(m?js|wasm)$/.test(p)).map((p) => size(p, relative(workerDir, p))).sort((a, b) => b.gzip - a.gzip);
    report.worker = { files, rawTotal: sum(files, "raw"), gzipTotal: sum(files, "gzip") };
  }
  const assets = cfg.assets?.directory ? join(cfgPath, "..", cfg.assets.directory) : null;
  if (assets && existsSync(assets)) {
    report.clientDir = assets;
    for (const htmlPath of [...walk(assets)].filter((p) => p.endsWith(".html"))) {
      const html = readFileSync(htmlPath, "utf8");
      const seen = new Map<string, FileSize>();
      const visit = (urlPath: string) => {
        const p = join(assets, urlPath.replace(/^\//, ""));
        if (seen.has(p) || !existsSync(p)) return;
        const fs = size(p, urlPath.replace(/^\//, "")); seen.set(p, fs);
        for (const i of staticImports(readFileSync(p, "utf8"))) visit(new URL(i, "http://x" + (urlPath.startsWith("/") ? urlPath : "/" + urlPath)).pathname);
      };
      for (const m of html.matchAll(/(?:src|href)="(\/[^"]+\.js)"/g)) visit(m[1]);
      const js = [...seen.values()].sort((a, b) => b.gzip - a.gzip);
      const page = "/" + relative(assets, htmlPath).replace(/index\.html$/, "").replace(/\.html$/, "");
      report.pages.push({ page: page.replace(/\/$/, "") || "/", js, rawTotal: sum(js, "raw"), gzipTotal: sum(js, "gzip") });
    }
    report.pages.sort((a, b) => b.gzipTotal - a.gzipTotal);
  }
  return report;
}

const kib = (n: number) => (n / 1024).toFixed(1).padStart(7) + " KiB";
export function formatReport(r: AnalyzeReport, top = 5): string {
  const L: string[] = [];
  if (!r.worker) return "no build found - run `cf-lite build` first";
  L.push(`Worker: ${kib(r.worker.rawTotal)} raw, ${kib(r.worker.gzipTotal)} gzip  (limits: 3 MiB free / 10 MiB paid, gzip)`);
  for (const f of r.worker.files.slice(0, top)) L.push(`  ${kib(f.gzip)} gz  ${f.file}`);
  L.push("");
  if (!r.pages.length) L.push("Client JS: no HTML pages with scripts (API-only or SSR-only app)");
  else { L.push("Client JS per page (gzip, what the browser downloads):"); for (const p of r.pages) { L.push(`  ${kib(p.gzipTotal)}  ${p.page}  (${p.js.length} file${p.js.length === 1 ? "" : "s"})`); for (const f of p.js.slice(0, 3)) L.push(`      ${kib(f.gzip)}  ${f.file}`); } }
  return L.join("\n");
}

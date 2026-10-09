/**
 * `cfl export` (docs/export.md): renders every component state through the real UI adapter (the dev server's `/__preview`) and writes
 * the HTML fragments + a manifest + an asset manifest in a stable, diff-clean layout, so a backend that is not JavaScript
 * (Razor, Twig, JSP...) can include the markup instead of re-typing it.
 *
 *   <out>/<component id>/<state>.html   one fragment per state (no <html>/<head>; island markup included)
 *   <out>/manifest.json                 components, states, files, bytes, sha256
 *   <out>/assets.json                   CSS/JS of the last `cfl build` (dist/client) + the island runtime
 *
 * Diff-clean means: sorted keys/lists, LF, one trailing newline, no timestamps, no absolute paths, and files that no longer
 * belong to the export are removed. Running it twice changes nothing (`--check` fails when it would).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative } from "node:path";
import { safeName } from "./preview-scan.js";

export interface ExportItem { id: string; name: string; group: string; island: boolean; states: string[]; error?: string }
export interface AssetFile { file: string; bytes: number; sha256: string }
export interface AssetsInfo { version: 1; source: string | null; css: AssetFile[]; js: AssetFile[]; islands: { runtime?: string; preload?: string[] } | null }

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
/** LF line endings, exactly one trailing newline. */
export const normalizeHtml = (h: string) => h.replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
const stable = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** The fragment file of one state, relative to the export dir. Throws when two names collapse to one file. */
export const fragmentPath = (id: string, state: string) => `${id}/${safeName(state)}.html`;

/** Files of an export (path -> content), manifest and assets included. `fragments` is keyed `<id>\0<state>`. Pure. */
export function planExport(items: ExportItem[], fragments: Map<string, string>, assets: AssetsInfo): Map<string, string> {
  const files = new Map<string, string>();
  const comps = [...items].sort((a, b) => a.id.localeCompare(b.id)).map((it) => ({
    id: it.id, name: it.name, group: it.group, island: it.island,
    states: [...it.states].sort().map((s) => {
      const html = normalizeHtml(fragments.get(`${it.id}\0${s}`) ?? "");
      const file = fragmentPath(it.id, s);
      if (files.has(file)) throw new Error(`export: states of "${it.id}" collide on ${file} (state names differ only in characters that are not file-safe)`);
      files.set(file, html);
      return { name: s, file, bytes: Buffer.byteLength(html), sha256: sha(html) };
    }),
  }));
  files.set("manifest.json", stable({ version: 1, tool: "cf-lite export", components: comps }));
  files.set("assets.json", stable(assets));
  return files;
}

/** CSS/JS in `<root>/dist/client` (after `cfl build`) and the island runtime from `_islands.json`. No build = empty lists, `source: null`. */
export function readAssets(root: string): AssetsInfo {
  const dir = join(root, "dist", "client");
  if (!existsSync(dir)) return { version: 1, source: null, css: [], js: [], islands: null };
  const out: AssetFile[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(css|m?js)$/.test(e.name)) out.push({ file: relative(dir, p).split("\\").join("/"), bytes: statSync(p).size, sha256: sha(readFileSync(p)) }); } };
  walk(dir);
  out.sort((a, b) => a.file.localeCompare(b.file));
  let islands: AssetsInfo["islands"] = null;
  try { const m = JSON.parse(readFileSync(join(dir, "_islands.json"), "utf8")); islands = { ...(m.runtime ? { runtime: m.runtime } : {}), ...(m.preload ? { preload: [...m.preload].sort() } : {}) }; } catch { /* no islands */ }
  return { version: 1, source: "dist/client", css: out.filter((f) => f.file.endsWith(".css")), js: out.filter((f) => !f.file.endsWith(".css")), islands };
}

export interface SyncResult { written: string[]; removed: string[]; changed: string[]; missing: string[]; stale: string[] }
/** Files listed by the previous manifest (+ the manifests themselves): what a re-export may remove. */
function previousFiles(dir: string): string[] {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { components?: { states?: { file: string }[] }[] };
    return ["manifest.json", "assets.json", ...(m.components ?? []).flatMap((c) => (c.states ?? []).map((s) => s.file))];
  } catch { return []; }
}
/** Write `planned` into `dir` (or only compare with `check`). Removes files the previous export wrote that are gone now, and empty folders. */
export function syncExport(dir: string, planned: Map<string, string>, check = false): SyncResult {
  const r: SyncResult = { written: [], removed: [], changed: [], missing: [], stale: [] };
  const prev = previousFiles(dir); // before the new manifest overwrites the list
  for (const [f, body] of [...planned].sort(([a], [b]) => a.localeCompare(b))) {
    const p = join(dir, f);
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (cur === body) continue;
    (cur === null ? r.missing : r.changed).push(f);
    if (!check) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); r.written.push(f); }
  }
  for (const f of prev.filter((x) => !planned.has(x)).sort()) {
    if (!existsSync(join(dir, f))) continue;
    r.stale.push(f);
    if (!check) {
      rmSync(join(dir, f));
      r.removed.push(f);
      for (let d = dirname(join(dir, f)); d !== dir && readdirSync(d).length === 0; d = dirname(d)) rmdirSync(d);
    }
  }
  return r;
}

export interface ExportOptions {
  root: string;
  /** Export directory (default `patterns-export`). */
  out?: string;
  check?: boolean;
  /** Serve `mocks/` while rendering (MOCK=1). */
  mock?: boolean;
  /** Absolute path of vite's CLI entry. */
  viteBin: string;
  log?: (m: string) => void;
  /** Start-up wait for the dev server, ms (default 120 000). */
  timeoutMs?: number;
}

const freePort = () => new Promise<number>((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

/** Render all states through a throw-away `vite dev` server and write (or check) the export. Resolves with the process exit code. */
export async function runExport(o: ExportOptions): Promise<number> {
  const log = o.log ?? (() => {});
  const out = join(o.root, o.out ?? "patterns-export");
  const port = await freePort();
  const child = spawn(process.execPath, [o.viteBin, "dev", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: o.root, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...(o.mock ? { MOCK: "1" } : {}) }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let slog = "", exited = false;
  child.stdout!.on("data", (d) => (slog += d)); child.stderr!.on("data", (d) => (slog += d));
  child.on("exit", () => { exited = true; });
  const stop = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } };
  const base = `http://127.0.0.1:${port}`;
  try {
    let manifest: { items: ExportItem[]; adapterBind: boolean } | undefined;
    const t0 = Date.now();
    while (!manifest) {
      if (exited) throw new Error(`the dev server exited before it was ready:\n${slog.slice(-1500)}`);
      if (Date.now() - t0 > (o.timeoutMs ?? 120_000)) throw new Error(`the dev server did not answer /__preview/api/manifest in time:\n${slog.slice(-1500)}`);
      try { const r = await fetch(`${base}/__preview/api/manifest`); if (r.ok) manifest = (await r.json()) as never; } catch { /* not up yet */ }
      if (!manifest) await new Promise((r) => setTimeout(r, 400));
    }
    if (!manifest.adapterBind) throw new Error("this UI adapter cannot render components (react, preact and vue can)");
    if (!manifest.items.length) throw new Error("no components found under app/ (add app/components/Name.tsx or Name.states.ts)");
    const errors: string[] = manifest.items.filter((i) => i.error).map((i) => `${i.id}: ${i.error}`);
    const items = manifest.items.filter((i) => !i.error);
    const fragments = new Map<string, string>();
    const jobs = items.flatMap((i) => i.states.map((s) => [i, s] as const));
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let j = next++; j < jobs.length; j = next++) {
        const [i, s] = jobs[j]!;
        const r = await fetch(`${base}/__preview/frame/${i.id.split("/").map(encodeURIComponent).join("/")}?s=${encodeURIComponent(s)}&fragment=1`);
        const body = await r.text();
        if (!r.ok) errors.push(`${i.id}/${s}: ${body.trim().split("\n")[0]}`); else fragments.set(`${i.id}\0${s}`, body);
      }
    }));
    if (errors.length) { errors.forEach((e) => console.error(`cfl export: ${e}`)); return 1; }
    const assets = readAssets(o.root);
    if (!assets.source) log("no dist/client: assets.json is empty (run `cfl build` first to list the CSS/JS the fragments need)");
    const res = syncExport(out, planExport(items, fragments, assets), o.check);
    const rel = relative(o.root, out) || ".";
    if (o.check) {
      const d = [...res.changed.map((f) => `~ ${f}`), ...res.missing.map((f) => `+ ${f}`), ...res.stale.map((f) => `- ${f}`)];
      if (d.length) { console.error(`cfl export --check: ${rel} is out of date\n  ${d.join("\n  ")}`); return 1; }
      log(`${rel} is up to date (${jobs.length} fragments)`);
    } else log(`exported ${jobs.length} fragments from ${items.length} components to ${rel} (${res.written.length} written, ${res.removed.length} removed)`);
    return 0;
  } finally { stop(); }
}

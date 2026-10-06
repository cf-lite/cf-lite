/** File scan behind `/__preview` (Node only; pure fs, no Vite). Authoring helper: `preview.ts`. */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** A previewable component found on disk. Paths are project-relative with `/` separators. */
export interface PreviewEntry {
  /** URL-safe id: the path under `app/` without extension (`patterns/atoms/Button/Button` -> `patterns/atoms/Button`). */
  id: string;
  name: string;
  group: string;
  /** Component file; absent when the states file imports the component itself (`StatesDef.component`). */
  file?: string;
  /** `Name.states.ts`, absent for a component without states (rendered once with no props). */
  states?: string;
  island: boolean;
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "routes"]);
const STATES_FILE = /^(.+)\.states\.[cm]?[jt]sx?$/;
const NOT_COMPONENT = /\.(states|test|spec|stories|setup|d)\.[a-z]+$/;

/** Component files under `app/` (not `app/routes`): `Capitalised.<adapter ext>`; plus every `*.states.*` file. Pure fs, sorted. */
export function scanPreview(root: string, exts: string[] = [".tsx", ".jsx", ".vue", ".svelte"]): PreviewEntry[] {
  const app = join(root, "app");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name.startsWith("_") || SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else files.push(p);
    }
  };
  if (existsSync(app)) walk(app);
  const rel = (p: string) => p.slice(root.length + 1).split("\\").join("/");
  const all = files.map(rel).sort();
  const isComp = (f: string) => exts.some((x) => f.endsWith(x)) && !NOT_COMPONENT.test(f) && /^[A-Z]/.test(basename(f));
  const out = new Map<string, PreviewEntry>();
  const add = (e: PreviewEntry) => { if (!out.has(e.id)) out.set(e.id, e); };
  for (const f of all.filter((x) => STATES_FILE.test(basename(x)))) {
    const stem = STATES_FILE.exec(basename(f))![1]!;
    const dir = dirname(f);
    // sibling component: same stem, else `Stem.island.<ext>`, else `index.<ext>` in the same folder
    const sib = (base: string) => all.find((x) => exts.some((e) => x === `${dir}/${base}${e}`));
    const sibling = sib(stem) ?? sib(`${stem}.island`) ?? sib("index");
    const id = idOf(`${dir}/${stem}`);
    add({ id, name: stem.replace(/\.island$/, ""), group: groupOf(id), file: sibling, states: f, island: /\.island\./.test(sibling ?? "") });
  }
  for (const f of all.filter(isComp)) {
    const stem = basename(f).replace(/\.[^.]+$/, "");
    const id = idOf(f.replace(/\.[^.]+$/, ""));
    if ([...out.values()].some((e) => e.file === f)) continue;
    add({ id, name: stem.replace(/\.island$/, ""), group: groupOf(id), file: f, island: /\.island\./.test(f) });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** `app/a/b/Name/Name` -> `a/b/Name`; `app/a/Name` -> `a/Name`; `app/a/Name/index` -> `a/Name`. */
function idOf(noExt: string): string {
  const parts = noExt.replace(/^app\//, "").split("/");
  const last = parts[parts.length - 1]!;
  if (parts.length > 1 && (last === "index" || last === parts[parts.length - 2])) parts.pop();
  return parts.join("/");
}
function groupOf(id: string): string {
  const parts = id.split("/");
  parts.pop();
  return parts.join("/") || "app";
}

/** Names that are safe to use as a URL segment / file name (export layout). */
export const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");

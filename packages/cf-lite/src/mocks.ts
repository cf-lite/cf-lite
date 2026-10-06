/**
 * Mock layer file convention (docs/mocks.md). Pure functions, no Vite:
 *   mocks/api/products.json            GET  /api/products   (JSON body)
 *   mocks/api/products/[id].json       GET  /api/products/:id
 *   mocks/api/orders.post.json         POST /api/orders
 *   mocks/api/search.ts                any method, `export default (ctx) => ...` (value -> JSON, Response passes through)
 *   mocks/api.example.com/items.json   GET  https://api.example.com/items  (first segment with a dot = another origin)
 *   mocks/api/files/[...rest].json     GET  /api/files/*
 *   mocks/_*, *.d.ts, other extensions are ignored
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
export interface MockFile {
  /** Project-relative, `/` separators. */
  file: string;
  /** Upper-case method, or `*` for any (handler files without a method suffix). */
  method: string;
  /** Other origin's host (`api.example.com`); undefined = this app's own origin. */
  host?: string;
  /** Route pattern in cf-lite's matcher syntax (`/api/products/:id`, `/api/files/*`). */
  pattern: string;
  kind: "json" | "handler";
}

/** `mocks/api/orders.post.json` -> route description; null for files that are not mocks. Exported for unit tests. */
export function parseMockFile(rel: string): MockFile | null {
  const m = /^mocks\/(.+)\.(json|[cm]?[jt]s)$/.exec(rel);
  if (!m || /\.d$/.test(m[1]!)) return null;
  const segs = m[1]!.split("/");
  if (segs.some((s) => s.startsWith("_"))) return null;
  const kind = m[2] === "json" ? "json" : "handler";
  let method = kind === "json" ? "GET" : "*";
  const last = segs[segs.length - 1]!;
  const mm = /^(.*)\.(get|post|put|patch|delete)$/.exec(last);
  if (mm) { segs[segs.length - 1] = mm[1]!; method = mm[2]!.toUpperCase(); }
  let host: string | undefined;
  if (segs.length > 1 && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(segs[0]!)) host = segs.shift();
  if (segs[segs.length - 1] === "index") segs.pop();
  const path = segs.map((s) => (/^\[\.\.\.[^\]]+\]$/.test(s) ? "*" : /^\[[^\]]+\]$/.test(s) ? ":" + s.slice(1, -1) : s));
  if (!path.length && !host) return { file: rel, method, pattern: "/", kind };
  return { file: rel, method, ...(host ? { host } : {}), pattern: "/" + path.join("/"), kind };
}

/** Most specific first: more static segments, no catch-all, specific method before `*`. */
const rank = (r: MockFile) => {
  const segs = r.pattern.split("/").filter(Boolean);
  return segs.reduce((n, s) => n + (s === "*" ? 0 : s.startsWith(":") ? 1 : 10), 0) - (segs.includes("*") ? 1000 : 0) + (r.method === "*" ? 0 : 5);
};

/** Every mock file under `<root>/mocks`, ordered for matching (most specific first, then by path). Duplicate method+host+pattern throws. */
export function scanMocks(root: string): MockFile[] {
  const dir = join(root, "mocks");
  const out: MockFile[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(join(d, e.name), rel); continue; }
      const f = parseMockFile(rel);
      if (f) out.push(f);
    }
  };
  if (existsSync(dir)) walk(dir, "mocks");
  const seen = new Map<string, string>();
  for (const f of out) {
    const k = `${f.method} ${f.host ?? ""}${f.pattern}`;
    if (seen.has(k)) throw new Error(`cf-lite: ${f.file} and ${seen.get(k)} both mock ${k} - keep one`);
    seen.set(k, f.file);
  }
  return out.sort((a, b) => rank(b) - rank(a) || a.file.localeCompare(b.file));
}

export { METHODS as MOCK_METHODS };

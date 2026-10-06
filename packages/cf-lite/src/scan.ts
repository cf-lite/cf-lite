/**
 * File-system conventions -> route tables. Pure functions (no Vite), so they are cheap to unit-test.
 *   app/routes/index.tsx        -> /
 *   app/routes/about.tsx        -> /about
 *   app/routes/posts/[id].tsx   -> /posts/:id
 *   server/api/hello.ts         -> /api/hello   (default export = a Hono app)
 *   server/api/users/index.ts   -> /api/users
 *   app/routes/_layout.tsx      -> not a route: wraps every page below it (nested: root layout outermost)
 *   app/routes/(group)/x.tsx    -> /x   (a parenthesised directory is stripped from the URL; it may own a _layout)
 *   app/routes/docs/[[...s]].tsx-> /docs/*?  (optional catch-all: also matches /docs)
 *   app/routes/_loading|_error|_not-found.tsx -> boundary files (nearest ancestor directory wins)
 *   server/routes/feed.xml.ts   -> /feed.xml (non-API Hono handler, Worker-first)
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type RenderMode = "spa" | "static" | "ssr" | "rsc";
export interface PageRoute {
  /** Path relative to project root, posix separators, e.g. app/routes/index.tsx */
  file: string;
  /** URL pattern, e.g. /posts/:id */
  path: string;
  render: RenderMode;
  hydrate: boolean;
  /** true when the file exports `loader` (ssr only) */
  hasLoader: boolean;
  /** true when the file exports `cache` (ssr only) - the route is wrapped with cf-lite/modules/cache */
  hasCache: boolean;
  /** Layout files wrapping this page, outermost first (app/routes/**\/_layout.tsx in every ancestor dir). */
  layouts: string[];
  /** Nearest `_loading` / `_error` / `_not-found` module in the page's directory or an ancestor (undefined when none). */
  loading?: string;
  error?: string;
  notFound?: string;
  forbidden?: string;
  unauthorized?: string;
  /** true when the file exports `actions` (ssr only): the route also answers `POST ?/name` (conventions/pages.ts mounts it). */
  hasActions?: boolean;
  /** true when the file exports `isr` (ssr only): GET is served through `isrRoute` (R2 durable static, docs/isr.md). */
  hasIsr?: boolean;
  /** render="static" + dynamic segments: exports `paths()` (prerendered at build). */
  hasPaths?: boolean;
  /** static + `paths`: `export const dynamicParams = true` - unlisted params fall through to SSR (assets are tried first). Default false = 404. */
  ssrFallback?: boolean;
  /** render="rsc" only (docs/design/rsc.md): `_layout.rsc.tsx` chain (outermost first) and nearest `_error.rsc.tsx` / `_not-found.rsc.tsx`. */
  rscLayouts?: string[];
  rscError?: string;
  rscNotFound?: string;
  rscForbidden?: string;
  rscUnauthorized?: string;
  /** render="rsc" + `export const hydrate = false`: pure server page, ships no client JS and no inline Flight payload (P3). */
  rscNoJs?: boolean;
}
export interface ApiRoute {
  file: string;
  /** Mount path inside the /api sub-app, e.g. /users */
  mount: string;
}
/** `server/routes/**` - a Hono sub-app mounted at the URL path itself (not under /api). */
export type HandlerRoute = ApiRoute;

const CODE_EXT = [".tsx", ".ts", ".jsx", ".js"];
/** Every extension a page/layout/api file can have (adapters add .vue/.svelte); used to strip it from URLs. */
const ANY_EXT = /\.(tsx|ts|jsx|js|vue|svelte)$/;
const extRe = (exts: string[]) => new RegExp("(" + exts.map((e) => e.replace(/\./g, "\\.")).join("|") + ")$");

function walk(dir: string, exts = CODE_EXT): string[] {
  const EXT = extRe(exts);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (EXT.test(name) && !name.endsWith(".d.ts") && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

/** "posts/[id]" -> "/posts/:id", "index" -> "/", "a/index" -> "/a" */
export function fileToPath(rel: string): string {
  const noExt = rel.replace(ANY_EXT, "");
  const segs = noExt.split("/").filter((s) => s !== "index");
  return "/" + segs.filter((s) => !/^\(.+\)$/.test(s)).map((s) => s.replace(/^\[\[\.\.\.(.+)\]\]$/, "*?").replace(/^\[\.\.\.(.+)\]$/, "*").replace(/^\[(.+)\]$/, ":$1")).join("/");
}

/** Static analysis of `export const render = "static"` etc. Conventions are deliberately regex-simple. */
export function detectExports(src: string): { render: RenderMode; hydrate: boolean; hasLoader: boolean; hasCache: boolean } {
  const m = /export\s+const\s+render\s*=\s*["'](static|ssr|spa|rsc)["']/.exec(src);
  const h = /export\s+const\s+hydrate\s*=\s*true\b/.test(src);
  const l = /export\s+(async\s+)?function\s+loader\b|export\s+const\s+loader\b/.test(src);
  const cc = /export\s+(const|(async\s+)?function)\s+cache\b/.test(src);
  return { render: (m?.[1] as RenderMode) ?? "spa", hydrate: h, hasLoader: l, hasCache: cc };
}

/** Specific routes first: static segments beat :params beat splat. */
function specificity(p: string): number[] {
  return p.split("/").filter(Boolean).map((s) => (s === "*?" ? -1 : s === "*" ? 0 : s.startsWith(":") ? 1 : 2));
}
export function sortRoutes<T extends { path: string }>(rs: T[]): T[] {
  return [...rs].sort((a, b) => {
    const x = specificity(a.path), y = specificity(b.path);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? -1) - (x[i] ?? -1);
      if (d) return d;
    }
    return 0;
  });
}

/** `_og.tsx`: the Open Graph image template of its directory (conventions/metadata.ts), not a page. */
export const isOgFile = (name: string) => /^_og\.(tsx|ts|jsx|js)$/.test(name.split("/").pop()!);
export const isLayoutFile = (name: string) => /^_layout\.(tsx|ts|jsx|js|vue|svelte)$/.test(name.split("/").pop()!);
/** `_layout.rsc.tsx` / `_error.rsc.tsx` / `_not-found.rsc.tsx`: server-component conventions of render="rsc" routes (never pages, never client-style layouts/boundaries). */
const RSC_CONV = /^_(layout|error|not-found|forbidden|unauthorized)\.rsc\.(tsx|ts|jsx|js)$/;
export type RscConvKind = "layout" | "error" | "notFound" | "forbidden" | "unauthorized";
export const rscConvKind = (name: string): RscConvKind | null => {
  const m = RSC_CONV.exec(name.split("/").pop()!);
  return m ? (m[1] === "not-found" ? "notFound" : (m[1] as RscConvKind)) : null;
};
const BOUNDARY = /^_(loading|error|not-found|forbidden|unauthorized)\.(tsx|ts|jsx|js|vue|svelte)$/;
export type BoundaryKind = "loading" | "error" | "notFound" | "forbidden" | "unauthorized";
export const BOUNDARY_KINDS = ["loading", "error", "notFound", "forbidden", "unauthorized"] as const;
export const boundaryKind = (name: string): BoundaryKind | null => {
  const m = BOUNDARY.exec(name.split("/").pop()!);
  return m ? (m[1] === "not-found" ? "notFound" : (m[1] as BoundaryKind)) : null;
};

export function scanPages(root: string, dir = "app/routes", exts: string[] = CODE_EXT): PageRoute[] {
  const base = join(root, dir);
  const all = walk(base, exts).map((abs) => ({ abs, rel: relative(base, abs).split(sep).join("/") }));
  // layouts: directory (relative, "" = root) -> file
  const layoutByDir = new Map<string, string>();
  for (const { abs, rel } of all.filter((f) => isLayoutFile(f.rel))) {
    const d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const file = relative(root, abs).split(sep).join("/");
    if (layoutByDir.has(d)) throw new Error(`cf-lite: ${file} and ${layoutByDir.get(d)} are both the layout of ${d || "the routes root"}`);
    layoutByDir.set(d, file);
  }
  const layoutsFor = (rel: string): string[] => {
    const parts = rel.split("/").slice(0, -1), out: string[] = [];
    for (let i = 0; i <= parts.length; i++) {
      const l = layoutByDir.get(parts.slice(0, i).join("/"));
      if (l) out.push(l);
    }
    return out;
  };
  // boundaries: kind -> directory -> file; the nearest ancestor directory wins
  const boundaries: Record<BoundaryKind, Map<string, string>> = { loading: new Map(), error: new Map(), notFound: new Map(), forbidden: new Map(), unauthorized: new Map() };
  for (const { abs, rel } of all) {
    const k = boundaryKind(rel);
    if (!k) continue;
    const d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const file = relative(root, abs).split(sep).join("/");
    if (boundaries[k].has(d)) throw new Error(`cf-lite: ${file} and ${boundaries[k].get(d)} are both the ${k === "notFound" ? "not-found" : k} boundary of ${d || "the routes root"}`);
    boundaries[k].set(d, file);
  }
  const nearest = (k: BoundaryKind, rel: string): string | undefined => {
    const parts = rel.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) {
      const f = boundaries[k].get(parts.slice(0, i).join("/"));
      if (f) return f;
    }
    return undefined;
  };
  // rsc conventions: directory -> file, per kind; layouts compose outer -> inner, error / not-found: the nearest wins
  const rscConv: Record<RscConvKind, Map<string, string>> = { layout: new Map(), error: new Map(), notFound: new Map(), forbidden: new Map(), unauthorized: new Map() };
  for (const { abs, rel } of all) {
    const k = rscConvKind(rel);
    if (!k) continue;
    const d = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const file = relative(root, abs).split(sep).join("/");
    if (rscConv[k].has(d)) throw new Error(`cf-lite: ${file} and ${rscConv[k].get(d)} are both the rsc ${k} of ${d || "the routes root"}`);
    rscConv[k].set(d, file);
  }
  const rscChain = (rel: string): string[] => {
    const parts = rel.split("/").slice(0, -1), out: string[] = [];
    for (let i = 0; i <= parts.length; i++) { const l = rscConv.layout.get(parts.slice(0, i).join("/")); if (l) out.push(l); }
    return out;
  };
  const rscNearest = (k: Exclude<RscConvKind, "layout">, rel: string): string | undefined => {
    const parts = rel.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) { const f = rscConv[k].get(parts.slice(0, i).join("/")); if (f) return f; }
    return undefined;
  };
  const routes = all.filter((f) => !isLayoutFile(f.rel) && !boundaryKind(f.rel) && !isOgFile(f.rel) && !rscConvKind(f.rel)).map(({ abs, rel }): PageRoute => {
    const file = relative(root, abs).split(sep).join("/");
    const src = readFileSync(abs, "utf8");
    const r: PageRoute = { file, path: fileToPath(rel), ...detectExports(src), layouts: layoutsFor(rel) };
    for (const k of BOUNDARY_KINDS) { const b = nearest(k, rel); if (b) r[k] = b; }
    if (r.render === "rsc") {
      r.rscLayouts = rscChain(rel);
      const e = rscNearest("error", rel), nf = rscNearest("notFound", rel), fb = rscNearest("forbidden", rel), un = rscNearest("unauthorized", rel);
      if (e) r.rscError = e;
      if (nf) r.rscNotFound = nf;
      if (fb) r.rscForbidden = fb;
      if (un) r.rscUnauthorized = un;
      if (/export\s+const\s+hydrate\s*=\s*false\b/.test(src)) r.rscNoJs = true;
    }
    if (/export\s+const\s+actions\b/.test(src)) r.hasActions = true;
    if (/export\s+const\s+isr\b/.test(src)) r.hasIsr = true;
    if (r.render === "static" && /[:*]/.test(r.path) && /export\s+(const|(async\s+)?function)\s+paths\b/.test(src)) {
      r.hasPaths = true;
      if (/export\s+const\s+dynamicParams\s*=\s*true\b/.test(src)) r.ssrFallback = true;
    }
    return r;
  });
  const seen = new Map<string, string>();
  for (const r of routes) {
    if (seen.has(r.path)) throw new Error(`cf-lite: ${r.file} and ${seen.get(r.path)} both map to ${r.path}`);
    seen.set(r.path, r.file);
    if (r.hasActions && r.render !== "ssr") throw new Error(`cf-lite: ${r.file}: \`export const actions\` only applies to render="ssr" pages (this one is "${r.render}") - a static/SPA page has no Worker to receive the POST.`);
    if (r.hasIsr && r.render !== "ssr" && r.render !== "rsc") throw new Error(`cf-lite: ${r.file}: \`export const isr\` only applies to render="ssr" pages (this one is "${r.render}").`);
    if (r.hasCache && r.render !== "ssr" && r.render !== "rsc") throw new Error(`cf-lite: ${r.file}: \`export const cache\` only applies to render="ssr" pages (this one is "${r.render}").`);
    if (r.render === "static" && /[:*]/.test(r.path) && !r.hasPaths)
      throw new Error(`cf-lite: ${r.file}: render="static" cannot have dynamic segments (${r.path}) unless it exports \`paths()\`; use "ssr" or "spa", or add \`export async function paths() { return [{ ... }] }\`.`);
  }
  // Static "/" takes index.html, which is the SPA fallback. SPA routes then get their own copy of the shell
  // (prerender.ts) - possible only for routes with a fixed path.
  if (routes.some((r) => r.path === "/" && r.render === "static")) {
    const dyn = routes.find((r) => r.render === "spa" && /[:*]/.test(r.path));
    if (dyn) throw new Error(`cf-lite: ${dyn.file}: a dynamic SPA route (${dyn.path}) cannot coexist with a static "/" page - there is no fallback shell to serve it. Make it render="ssr", or make "/" an SPA/ssr page.`);
  }
  return sortRoutes(routes);
}

/** The bits of wrangler `assets` config that depend on the route table. */
export function assetsRouting(pages: PageRoute[], dev = false, locales?: readonly string[]): { ssrGlobs: string[]; notFound: "404-page" | null; sig: string } {
  // i18n: `/:locale/posts/:slug` would be the glob `/*` (every path Worker-first); with known locales it is one narrow glob per locale.
  const expand = (p: string) => (locales?.length && (p === "/:locale" || p.startsWith("/:locale/")) ? locales.map((l) => p.replace(":locale", l)) : [p]);
  const ssrGlobs = [...new Set(pages.filter((p) => p.render === "ssr" || p.render === "rsc" || p.ssrFallback).flatMap((p) => expand(p.path).flatMap(toWorkerGlobs)))].sort();
  // dev has no prerendered files (Vite serves the SPA shell for everything), so the SPA fallback stays on there.
  const notFound = !dev && pages.some((p) => p.path === "/" && p.render === "static") ? "404-page" : null;
  return { ssrGlobs, notFound, sig: JSON.stringify([ssrGlobs, notFound]) };
}

export function scanApi(root: string, dir = "server/api"): ApiRoute[] {
  const base = join(root, dir);
  return walk(base).map((abs) => {
    const file = relative(root, abs).split(sep).join("/");
    const mount = fileToPath(relative(base, abs).split(sep).join("/"));
    return { file, mount };
  });
}

/** `server/routes/**`: non-API handlers mounted at their own URL path. */
export function scanHandlers(root: string, dir = "server/routes"): HandlerRoute[] {
  return scanApi(root, dir);
}

/** Wrangler `run_worker_first` glob for a URL pattern: /posts/:id -> /posts/* */
export function toWorkerGlob(path: string): string {
  const segs = path.split("/");
  const i = segs.findIndex((s) => s.startsWith(":") || s === "*" || s === "*?");
  return i === -1 ? path : segs.slice(0, i).join("/") + "/*";
}
/** Like toWorkerGlob, but an optional catch-all also needs its parent path (`/docs/*` does not match `/docs`): /docs/*? -> [/docs, /docs/*] */
export function toWorkerGlobs(path: string): string[] {
  const g = toWorkerGlob(path);
  return path.endsWith("/*?") ? [path.slice(0, -3) || "/", g] : [g];
}

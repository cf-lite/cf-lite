/**
 * Build-time prerender for `render = "static"` pages. Runs in plain Node after `vite build`:
 * loads the route modules through a throwaway Vite SSR server, renders to a string, writes
 * <outDir>/<path>/index.html from the built index.html shell. Static pages ship NO JS unless `hydrate = true`.
 *
 * Static "/" + SPA routes: index.html becomes the static home page, so the pristine SPA shell is written to
 * <path>/index.html for every (non-dynamic) SPA route and to 404.html (the plugin switches assets to
 * `not_found_handling: "404-page"`). Dynamic SPA routes can't coexist with a static "/" (see scanPages).
 *
 * `paths()`: a static page with dynamic segments exports `paths = async () => [{ id: "1" }, ...]`; one file per entry.
 * `loader(c)` on a static page runs here (Node) with a minimal context (`c.req.param()`, `c.req.url`, `c.env = {}`) and feeds
 * `data` to the render/head. With a root `_not-found` and a static "/", 404.html is that page rendered (no JS), not the SPA shell.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createServer, mergeConfig, type UserConfig } from "vite";
import { tsconfigAliases } from "./aliases.js";
import { scanPages, type PageRoute } from "./scan.js";
import { isNavigationSignal } from "./navigation.js";
import { staticSitemap } from "./conventions/metadata.js";
import { headFor, injectHead } from "./head.js";
import type { UiAdapter, UiServer } from "./adapter.js";
import type { SecurityOptions } from "./modules/csp.js";
import type { I18nConfig } from "./modules/i18n.js";
import { applySecurityHeaders } from "./vite-security.js";
import { ISLAND_TAG, type IslandsAuto } from "./islands.js";
import { islandIds, islandPreloads, islandTail } from "./islands-server.js";
import { islandTransform, islandVueTransform, ISLANDS_MANIFEST, type IslandsManifest } from "./vite-islands.js";

const SCRIPTS = /<script type="module"[^>]*><\/script>|<link rel="modulepreload"[^>]*>/g;

/** Fill a route pattern: `/posts/:id` + { id: "1" } -> `/posts/1`; splat (`*` / `*?`) takes params["*"]. */
export function fillPath(pattern: string, params: Record<string, string>): string {
  const out = pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*" || seg === "*?") {
      const v = params["*"] ?? "";
      if (!v && seg === "*") throw new Error(`cf-lite prerender: paths() entry for ${pattern} is missing "*"`);
      return v.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    }
    if (seg.startsWith(":")) {
      const v = params[seg.slice(1)];
      if (v === undefined || v === "") throw new Error(`cf-lite prerender: paths() entry ${JSON.stringify(params)} for ${pattern} is missing "${seg.slice(1)}"`);
      return encodeURIComponent(v);
    }
    return seg;
  }).filter((x) => x !== "");
  return "/" + out.join("/");
}

export interface Meta { adapter: string | null; options?: unknown; islandsAuto?: IslandsAuto; security?: SecurityOptions; i18n?: I18nConfig; islands?: boolean }
/** .cf-lite/meta.json is written by the Vite plugin: prerender runs outside the user's vite config, so it re-creates the adapter from its package name. */
export function readMeta(root: string): Meta {
  try { return { adapter: null, ...JSON.parse(readFileSync(join(root, ".cf-lite/meta.json"), "utf8")) }; } catch { return { adapter: null }; }
}
export async function loadAdapter(root: string, meta: Meta): Promise<UiAdapter | null> {
  if (!meta.adapter) return null;
  const file = createRequire(join(root, "package.json")).resolve(meta.adapter);
  const mod = await import(pathToFileURL(file).href);
  const ui = (mod.default ?? mod.adapter)(meta.options) as UiAdapter;
  return meta.islandsAuto && ui.islands ? { ...ui, islands: { ...ui.islands, auto: meta.islandsAuto } } : ui; // same `islands.auto` the app build used
}

/** Prerender static pages, then (when `cfLite({ security })` is set) write the hash-based CSP + security headers into `_headers`. */
export async function prerender(opts: { root?: string; outDir?: string } = {}): Promise<string[]> {
  const written = await prerenderPages(opts);
  const root = resolve(opts.root ?? process.cwd());
  const security = readMeta(root).security;
  if (security) await applySecurityHeaders(outDirOf(root, opts.outDir), security);
  return written;
}

function outDirOf(root: string, outDir?: string): string {
  const v2 = join(root, ".cloudflare/output/v0/workers/default/assets");
  return resolve(root, outDir ?? (existsSync(v2) ? v2 : "dist/client"));
}

async function prerenderPages(opts: { root?: string; outDir?: string } = {}): Promise<string[]> {
  const root = resolve(opts.root ?? process.cwd());
  const v2 = join(root, ".cloudflare/output/v0/workers/default/assets"); // @cloudflare/vite-plugin 2.x (beta) output layout
  const outDir = resolve(root, opts.outDir ?? (existsSync(v2) ? v2 : "dist/client"));
  const indexPath = join(outDir, "index.html");
  if (!existsSync(indexPath)) throw new Error(`cf-lite prerender: ${indexPath} missing - run vite build first`);

  const meta = readMeta(root);
  const ui = await loadAdapter(root, meta);
  const all = ui ? scanPages(root, "app/routes", ui.extensions) : [];
  const shell = readFileSync(indexPath, "utf8"); // pristine SPA shell (before any static "/" overwrites index.html)
  // Keep it as /_shell.tpl for SSR pages (see server.ts) - only when there are some, otherwise it is a dead copy in the
  // deployed assets. Extension is not .html on purpose: Workers assets would 308-redirect /_shell.html -> /_shell.
  const shellPath = join(outDir, "_shell.tpl");
  if (all.some((p) => p.render === "ssr" || p.ssrFallback) && !existsSync(shellPath)) writeFileSync(shellPath, shell);
  const pages = all.filter((p) => p.render === "static");
  const rootNotFound = all.find((p) => p.notFound && !p.notFound.slice("app/routes/".length).includes("/"))?.notFound;
  const written: string[] = [];
  const put = (file: string, body: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); written.push(file); };
  const urls: string[] = [];
  const sitemap = () => written.push(...staticSitemap({ root, outDir, pages: all, urls, i18n: readMeta(root).i18n })); // needs SITE_URL; docs/metadata.md

  if (pages.some((p) => p.path === "/")) {
    for (const p of all.filter((p) => p.render === "spa")) put(join(outDir, p.path, "index.html"), shell);
    if (!existsSync(join(outDir, "404.html")) && !rootNotFound) put(join(outDir, "404.html"), shell);
  }
  if (!pages.length && !(rootNotFound && all.some((p) => p.path === "/" && p.render === "static"))) { sitemap(); return written; }

  const { plugins, config } = ui!.vite();
  const vite = await createServer(mergeConfig({
    root, configFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true },
    resolve: { alias: tsconfigAliases(root) }, // the same tsconfig `paths` aliases the app build has
    plugins: [...plugins, ...(meta.islands && ui!.islands ? [islandTransform(root, ui!), islandVueTransform(root, ui!)] : [])], ssr: { noExternal: ["cf-lite", ui!.id] },
  } as UserConfig, config ?? {}));
  try {
    const server = (await vite.ssrLoadModule(ui!.server)) as UiServer;
    const islandsMf = (() => { try { return JSON.parse(readFileSync(join(outDir, ISLANDS_MANIFEST), "utf8")) as IslandsManifest; } catch { return null; } })();
    const finish = (doc: string, html: string, hydrate: boolean, data?: unknown) => {
      if (!hydrate) doc = doc.replace(SCRIPTS, "");
      // islands: a page that rendered any gets the runtime <script> (not when the whole page hydrates anyway)
      if (html.includes("<" + ISLAND_TAG)) doc = doc.replace("</body>", () => islandTail(hydrate ? null : islandsMf?.runtime ?? null, undefined, hydrate ? [] : islandPreloads(islandsMf, islandIds(html))) + "</body>");
      const extra = hydrate && data !== undefined ? `<script>window.__CF_LITE_DATA__=${JSON.stringify(data).replace(/</g, "\\u003c")}</script>` : "";
      return doc.replace(/<div id="root">\s*<\/div>/, () => `${extra}<div id="root" data-ssr>${html}</div>`);
    };
    const one = async (p: PageRoute, mod: any, lmods: any[], url: string, params: Record<string, string>) => {
      let data: unknown;
      if (mod.loader) {
        const u = new URL(url, "http://localhost");
        try { data = await mod.loader({ req: { param: (k?: string) => (k ? params[k] : { ...params }), url: u.href, raw: new Request(u), header: () => undefined, query: () => undefined }, env: {}, var: {}, set() {}, get() {} }); }
        catch (e) {
          if (isNavigationSignal(e)) {
            if (e.kind === "not-found") { console.warn(`[cf-lite] prerender: ${url} called notFound(), skipped`); return; }
            if (e.kind === "forbidden" || e.kind === "unauthorized") throw new Error(`cf-lite prerender: ${p.file} loader called ${e.kind === "forbidden" ? "forbidden" : "unauthorized"}() while prerendering ${url}; a static page has no request to authorize - make it render="ssr"`);
            throw new Error(`cf-lite prerender: ${p.file} loader redirected (${e.url}) while prerendering ${url}; a static page cannot redirect - make it render="ssr"`);
          }
          throw e;
        }
      }
      const { body: html, head: uiHead } = await server.renderToString({ Page: mod.default, layouts: lmods.map((l) => l.default), params, data, hydrate: p.hydrate, loading: (p.loading ? (await vite.ssrLoadModule("/" + p.loading)).default : undefined) });
      let doc = injectHead(shell, headFor([...lmods, mod], { params, data, url }));
      if (uiHead) doc = doc.replace("</head>", () => uiHead + "</head>");
      put(url === "/" ? indexPath : join(outDir, url, "index.html"), finish(doc, html, p.hydrate, data));
      urls.push(url);
    };
    for (const p of pages) {
      const mod = await vite.ssrLoadModule("/" + p.file);
      const lmods = await Promise.all(p.layouts.map((l) => vite.ssrLoadModule("/" + l)));
      if (!p.hasPaths) { await one(p, mod, lmods, p.path, {}); continue; }
      const list = await mod.paths();
      if (!Array.isArray(list)) throw new Error(`cf-lite prerender: ${p.file}: paths() must return an array of param objects`);
      for (const params of list) await one(p, mod, lmods, fillPath(p.path, params), params);
    }
    if (rootNotFound && all.some((p) => p.path === "/" && p.render === "static") && !existsSync(join(outDir, "404.html"))) {
      const nf = await vite.ssrLoadModule("/" + rootNotFound);
      const { body: html, head: uiHead } = await server.renderToString({ Page: nf.default, layouts: [], params: {}, hydrate: false });
      let doc = injectHead(shell, headFor([nf], { params: {}, data: undefined }));
      if (uiHead) doc = doc.replace("</head>", () => uiHead + "</head>");
      put(join(outDir, "404.html"), finish(doc, html, false));
    }
  } finally {
    await vite.close();
  }
  sitemap();
  return written;
}

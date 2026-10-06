/**
 * Metadata convention (docs/metadata.md). Inert unless the project has one of:
 *   server/sitemap.ts   default export `(c) => SitemapEntry[]`  -> GET /sitemap.xml (+ /sitemap-N.xml when split), edge cached
 *   server/robots.ts    default export RobotsConfig | (c) => RobotsConfig -> GET /robots.txt (Disallow: / on preview hosts)
 *   server/manifest.ts  default export WebManifest | (c) => WebManifest  -> GET /manifest.webmanifest
 *   app/routes/**\/_og.tsx  default export `(ctx) => element`, `export const og = { fonts, ... }` -> GET <dir>/opengraph-image.png
 * Also exports the build-time pieces: `staticSitemap()` (prerender hook) and `iconsPlugin()` (app/icon.* -> hashed copies + <link> in the shell).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import type { Plugin } from "vite";
import { fileToPath, type PageRoute } from "../scan.js";
import { buildSitemapFiles, type SitemapEntry } from "../modules/sitemap.js";
import { withAlternates, type I18nConfig } from "../modules/i18n.js";
import { defineConvention } from "./types.js";
import { imp } from "./util.js";

export interface MetadataEntries { sitemap?: string; robots?: string; manifest?: string; og: { file: string; path: string }[] }
const CODE = /\.(tsx|ts|jsx|js)$/;
const first = (root: string, base: string) => [".ts", ".tsx", ".js", ".jsx"].map((e) => base + e).find((f) => existsSync(join(root, f)));

function findOg(root: string, dir = "app/routes"): { file: string; path: string }[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out: { file: string; path: string }[] = [];
  for (const n of readdirSync(abs).sort()) {
    const p = join(abs, n);
    if (statSync(p).isDirectory()) out.push(...findOg(root, dir + "/" + n));
    else if (/^_og\.(tsx|ts|jsx|js)$/.test(n)) {
      const rel = relative(join(root, "app/routes"), dirname(p)).split(sep).filter(Boolean).join("/");
      const base = fileToPath(rel ? rel + "/index.tsx" : "index.tsx");
      out.push({ file: dir + "/" + n, path: (base === "/" ? "" : base) + "/opengraph-image.png" });
    }
  }
  return out;
}

/** `/posts/:slug/opengraph-image.png` -> `/posts/*\/opengraph-image.png` (exact tail keeps the static pages under /posts/ asset-served). */
const ogGlob = (p: string) => p.split("/").map((s) => (s.startsWith(":") || s.startsWith("*") ? "*" : s)).join("/");

export const metadataConvention = defineConvention<MetadataEntries>({
  name: "metadata",
  scan: ({ root }) => ({ sitemap: first(root, "server/sitemap"), robots: first(root, "server/robots"), manifest: first(root, "server/manifest"), og: findOg(root) }),
  emit: (m) => {
    const any = m.sitemap || m.robots || m.manifest || m.og.length;
    if (!any) return {};
    const imports: string[] = [], pre: string[] = [`import { previewNoindex } from "cf-lite/modules/sitemap";`], app: string[] = [], wf: string[] = [];
    if (m.sitemap) {
      pre.push(`import { sitemapHandler } from "cf-lite/modules/sitemap";`);
      imports.push(`import * as sm from ${JSON.stringify(imp(m.sitemap))};`);
      app.push(`  .get("/sitemap.xml", sitemapHandler(sm.default as never, (sm as { options?: never }).options))`, `  .get("/sitemap-:n{[0-9]+}.xml", sitemapHandler(sm.default as never, (sm as { options?: never }).options))`);
      wf.push("/sitemap.xml", "/sitemap-*.xml");
    }
    if (m.robots) {
      pre.push(`import { robotsHandler } from "cf-lite/modules/sitemap";`);
      imports.push(`import * as rb from ${JSON.stringify(imp(m.robots))};`);
      app.push(`  .get("/robots.txt", robotsHandler(rb.default as never, (rb as { options?: never }).options))`);
      wf.push("/robots.txt");
    }
    if (m.manifest) {
      pre.push(`import { manifestHandler } from "cf-lite/modules/sitemap";`);
      imports.push(`import * as mf from ${JSON.stringify(imp(m.manifest))};`);
      app.push(`  .get("/manifest.webmanifest", manifestHandler(mf.default as never))`);
      wf.push("/manifest.webmanifest");
    }
    if (m.og.length) {
      pre.push(`import { ogHandler } from "cf-lite/modules/og";`);
      m.og.forEach((o, i) => {
        imports.push(`import * as og${i} from ${JSON.stringify(imp(o.file))};`);
        app.push(`  .get(${JSON.stringify(o.path)}, ogHandler(og${i}.default as never, (og${i} as unknown as { og: never }).og))`);
        wf.push(ogGlob(o.path));
      });
    }
    return {
      preImports: pre, imports,
      // Runs first: every Worker response on a *.workers.dev preview carries X-Robots-Tag: noindex.
      appPre: [`  .use("*", previewNoindex())`],
      app, workerFirst: wf,
      checks: m.og.length ? [(w) => (Array.isArray(w.services) && (w.services as { binding?: string }[]).some((s) => s.binding === "OG") ? [] : [`_og.tsx: add a service binding \`{ "binding": "OG", "service": "cf-lite-og" }\` to wrangler config (deploy packages/cf-lite/og-worker)`])] : [],
    };
  },
});

// ---- build time ----------------------------------------------------------------------------------------------------------------

const excluded = (root: string, file: string) => /export\s+const\s+sitemap\s*=\s*false\b/.test(readFileSync(join(root, file), "utf8"));

/**
 * Static sitemap from the route table: every prerendered URL (`urls`, includes `paths()` results) plus fixed-path ssr/spa pages.
 * Needs the origin (`SITE_URL`, or `siteUrl`); skipped (returns []) when unknown or when `server/sitemap.ts` (dynamic) exists.
 * A page opts out with `export const sitemap = false`. Returns the written files.
 */
export function staticSitemap(o: { root: string; outDir: string; pages: PageRoute[]; urls: string[]; siteUrl?: string; i18n?: I18nConfig }): string[] {
  const site = o.siteUrl ?? process.env.SITE_URL;
  if (first(o.root, "server/sitemap")) return [];
  if (!site) return [];
  const skip = new Set(o.pages.filter((p) => excluded(o.root, p.file)).map((p) => p.path));
  const fixed = o.pages.filter((p) => !/[:*]/.test(p.path) && (p.render !== "static") && !skip.has(p.path)).map((p) => p.path);
  const prerendered = o.urls.filter((u) => ![...skip].includes(u));
  const all: SitemapEntry[] = [...new Set([...prerendered, ...fixed])].sort().map((url) => ({ url }));
  const entries = o.i18n ? withAlternates(all, o.i18n, site) : all; // hreflang alternates for `/<locale>/...` (modules/i18n)
  if (!all.length) return [];
  const files = buildSitemapFiles(entries, { siteUrl: site });
  const written: string[] = [];
  for (const [name, xml] of Object.entries(files)) { const f = join(o.outDir, name); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, xml); written.push(f); }
  return written;
}

const ICONS: { re: RegExp; rel: string; sizes?: string }[] = [
  { re: /^favicon\.ico$/, rel: "icon" },
  { re: /^icon\.(png|svg|ico|jpg|jpeg|gif)$/, rel: "icon" },
  { re: /^apple-icon\.(png|jpg|jpeg)$/, rel: "apple-touch-icon" },
];
const MIME: Record<string, string> = { png: "image/png", svg: "image/svg+xml", ico: "image/x-icon", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };

/** `app/icon.png`, `app/favicon.ico`, `app/apple-icon.png` -> content-hashed copies in `assets/` and `<link>`s injected into the HTML shell (every page). */
export function iconsPlugin(root: string): Plugin {
  const dir = join(root, "app");
  const found = () => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const i = ICONS.find((x) => x.re.test(n)); return i ? [{ name: n, rel: i.rel, ext: n.split(".").pop()! }] : []; }) : []);
  let base = "/", build = false;
  const hashed = new Map<string, string>();
  return {
    name: "cf-lite:icons",
    configResolved(c) { base = c.base; build = c.command === "build"; },
    buildStart() {
      if (!build || (this as { environment?: { name: string } }).environment?.name !== "client") return;
      for (const f of found()) {
        const ref = this.emitFile({ type: "asset", name: f.name, source: readFileSync(join(dir, f.name)) });
        hashed.set(f.name, this.getFileName(ref));
      }
    },
    transformIndexHtml() {
      const icons = found();
      if (!icons.length) return;
      return icons.map((f) => ({
        tag: "link", injectTo: "head" as const,
        attrs: { rel: f.rel, type: MIME[f.ext], href: build ? base + hashed.get(f.name) : `/app/${f.name}` },
      }));
    },
  };
}

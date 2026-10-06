/**
 * OPTIONAL module. sitemap.xml (with sitemap-index splitting at 50k URLs / ~45 MB), robots.txt with automatic preview `noindex`, and the
 * web app manifest - served from the Worker with edge caching, or rendered at build by `conventions/metadata.ts`. Docs: docs/metadata.md.
 */
import type { Context, MiddlewareHandler } from "hono";
import { absoluteUrl, siteUrl } from "./seo.js";

export interface SitemapEntry {
  /** Path (`/posts/x`) or absolute URL. */
  url: string;
  lastmod?: string | Date;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
  /** hreflang alternates (xhtml:link). */
  alternates?: { hreflang: string; href: string }[];
}

export const MAX_URLS = 50_000;
/** The protocol limit is 50 MiB uncompressed; stay under it. */
export const MAX_BYTES = 45 * 1024 * 1024;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : d);
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n`;
const NS = `xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"`;

function urlXml(e: SitemapEntry, base?: string): string {
  const p = e.priority !== undefined ? `<priority>${Math.min(1, Math.max(0, e.priority)).toFixed(1)}</priority>` : "";
  const alts = (e.alternates ?? []).map((a) => `<xhtml:link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(absoluteUrl(a.href, base))}"/>`).join("");
  return `<url><loc>${esc(absoluteUrl(e.url, base))}</loc>` + (e.lastmod ? `<lastmod>${esc(iso(e.lastmod))}</lastmod>` : "") + (e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : "") + p + alts + `</url>`;
}

export function renderUrlset(entries: SitemapEntry[], base?: string): string {
  const xhtml = entries.some((e) => e.alternates?.length) ? ` xmlns:xhtml="http://www.w3.org/1999/xhtml"` : "";
  return `${HEAD}<urlset ${NS}${xhtml}>${entries.map((e) => urlXml(e, base)).join("")}</urlset>\n`;
}
export function renderIndex(locs: { loc: string; lastmod?: string | Date }[]): string {
  return `${HEAD}<sitemapindex ${NS}>${locs.map((l) => `<sitemap><loc>${esc(l.loc)}</loc>${l.lastmod ? `<lastmod>${esc(iso(l.lastmod))}</lastmod>` : ""}</sitemap>`).join("")}</sitemapindex>\n`;
}

export interface SplitOptions { siteUrl?: string; maxUrls?: number; maxBytes?: number }
/**
 * Entries -> files. One file `sitemap.xml` when it fits; otherwise `sitemap.xml` is a sitemap *index* and the URLs live in
 * `sitemap-1.xml`, `sitemap-2.xml`, ... (each <= maxUrls and <= maxBytes). URLs are de-duplicated (first wins).
 */
export function buildSitemapFiles(entries: SitemapEntry[], o: SplitOptions = {}): Record<string, string> {
  const base = o.siteUrl, maxUrls = o.maxUrls ?? MAX_URLS, maxBytes = o.maxBytes ?? MAX_BYTES;
  const seen = new Set<string>(), uniq: SitemapEntry[] = [];
  for (const e of entries) { const k = absoluteUrl(e.url, base); if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  const chunks: SitemapEntry[][] = [];
  let cur: SitemapEntry[] = [], bytes = 300;
  for (const e of uniq) {
    const b = new TextEncoder().encode(urlXml(e, base)).length;
    if (cur.length && (cur.length >= maxUrls || bytes + b > maxBytes)) { chunks.push(cur); cur = []; bytes = 300; }
    cur.push(e); bytes += b;
  }
  chunks.push(cur);
  if (chunks.length === 1) return { "sitemap.xml": renderUrlset(chunks[0], base) };
  const out: Record<string, string> = {};
  const locs = chunks.map((c, i) => {
    out[`sitemap-${i + 1}.xml`] = renderUrlset(c, base);
    const last = c.map((e) => e.lastmod && iso(e.lastmod)).filter(Boolean).sort().pop();
    return { loc: absoluteUrl(`/sitemap-${i + 1}.xml`, base), lastmod: last || undefined };
  });
  out["sitemap.xml"] = renderIndex(locs);
  return out;
}

export type SitemapLoader = (c: Context) => SitemapEntry[] | Promise<SitemapEntry[]>;
export interface SitemapHandlerOptions extends SplitOptions {
  /** Edge cache lifetime in seconds (Cache API + `s-maxage`). Default 3600; 0 disables the Worker-side cache. */
  ttl?: number;
}

/**
 * Hono handler for `/sitemap.xml` and `/sitemap-:n.xml`. The loader runs on a cache miss only (Cache API, keyed by URL); every response
 * carries `Last-Modified` (newest `lastmod`) and `x-cf-lite-sitemap: HIT|MISS`. Origin: options, `SITE_URL` var, or the request origin.
 */
export function sitemapHandler(load: SitemapLoader, o: SitemapHandlerOptions = {}) {
  const ttl = o.ttl ?? 3600;
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const base = o.siteUrl ?? siteUrl((c.env as { SITE_URL?: string } | undefined)?.SITE_URL) ?? url.origin;
    const name = url.pathname.replace(/^\//, "");
    const cache = ttl > 0 && typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
    const key = new Request(url.origin + url.pathname, { method: "GET" });
    const hit = await cache?.match(key);
    if (hit) { const r = new Response(hit.body, hit); r.headers.set("x-cf-lite-sitemap", "HIT"); return r; }
    const entries = await load(c);
    const files = buildSitemapFiles(entries, { ...o, siteUrl: base });
    const xml = files[name];
    if (xml === undefined) return c.notFound();
    const last = entries.map((e) => e.lastmod && iso(e.lastmod)).filter(Boolean).sort().pop();
    const headers: Record<string, string> = { "content-type": "application/xml; charset=utf-8", "cache-control": `public, max-age=0, s-maxage=${ttl}` };
    if (last) { const d = new Date(last as string); if (!isNaN(+d)) headers["last-modified"] = d.toUTCString(); }
    const res = new Response(xml, { headers });
    if (cache) c.executionCtx?.waitUntil(cache.put(key, res.clone()));
    const r = new Response(xml, { headers }); r.headers.set("x-cf-lite-sitemap", "MISS");
    return r;
  };
}

// ---- robots --------------------------------------------------------------------------------------------------------------------

export interface RobotsRule { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[]; crawlDelay?: number }
export interface RobotsConfig {
  rules?: RobotsRule[];
  /** Sitemap URLs/paths. Default: `/sitemap.xml` when `sitemap` is true. */
  sitemaps?: string[];
  sitemap?: boolean;
  host?: string;
}
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function robotsTxt(c: RobotsConfig, base?: string): string {
  const rules = c.rules?.length ? c.rules : [{ userAgent: "*", allow: "/" }];
  const out: string[] = [];
  for (const r of rules) {
    for (const ua of arr(r.userAgent ?? "*")) out.push(`User-agent: ${ua}`);
    for (const a of arr(r.allow)) out.push(`Allow: ${a}`);
    for (const d of arr(r.disallow)) out.push(`Disallow: ${d}`);
    if (r.crawlDelay !== undefined) out.push(`Crawl-delay: ${r.crawlDelay}`);
    out.push("");
  }
  for (const s of c.sitemaps ?? (c.sitemap === false ? [] : ["/sitemap.xml"])) out.push(`Sitemap: ${absoluteUrl(s, base)}`);
  if (c.host) out.push(`Host: ${c.host}`);
  return out.join("\n").trimEnd() + "\n";
}

/** Hosts that are previews/non-production by default: `*.workers.dev` (so a production custom domain is indexed, a preview URL never). */
export const DEFAULT_PREVIEW_HOSTS = ["*.workers.dev"];
export function isPreviewHost(host: string, patterns: string[] = DEFAULT_PREVIEW_HOSTS): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return patterns.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p.toLowerCase()));
}

export interface RobotsHandlerOptions { previewHosts?: string[] }
/** `GET /robots.txt`. On a preview host the body is `Disallow: /` whatever the config says. */
export function robotsHandler(config: RobotsConfig | ((c: Context) => RobotsConfig | Promise<RobotsConfig>) = {}, o: RobotsHandlerOptions = {}) {
  return async (c: Context): Promise<Response> => {
    const u = new URL(c.req.url);
    const cacheControl = "public, max-age=0, s-maxage=3600";
    if (isPreviewHost(u.host, o.previewHosts)) return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex, nofollow", "cache-control": "no-store" } });
    const cfg = typeof config === "function" ? await config(c) : config;
    const base = siteUrl((c.env as { SITE_URL?: string } | undefined)?.SITE_URL) ?? u.origin;
    return new Response(robotsTxt(cfg, base), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": cacheControl } });
  };
}

/** Adds `X-Robots-Tag: noindex, nofollow` to every Worker response on a preview host (HTML, JSON, feeds). */
export function previewNoindex(o: RobotsHandlerOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (isPreviewHost(new URL(c.req.url).host, o.previewHosts)) c.res.headers.set("x-robots-tag", "noindex, nofollow");
  };
}

// ---- web app manifest ------------------------------------------------------------------------------------------------------------

export interface WebManifest {
  name: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  scope?: string;
  id?: string;
  display?: "fullscreen" | "standalone" | "minimal-ui" | "browser";
  orientation?: string;
  background_color?: string;
  theme_color?: string;
  lang?: string;
  dir?: "ltr" | "rtl" | "auto";
  categories?: string[];
  icons?: { src: string; sizes?: string; type?: string; purpose?: string }[];
  screenshots?: { src: string; sizes?: string; type?: string; form_factor?: string; label?: string }[];
  shortcuts?: { name: string; url: string; short_name?: string; description?: string; icons?: WebManifest["icons"] }[];
  [k: string]: unknown;
}
export const defineManifest = (m: WebManifest): WebManifest => m;

/** `GET /manifest.webmanifest`. */
export function manifestHandler(m: WebManifest | ((c: Context) => WebManifest | Promise<WebManifest>)) {
  return async (c: Context): Promise<Response> => new Response(JSON.stringify(typeof m === "function" ? await m(c) : m), {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=3600" },
  });
}

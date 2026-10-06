/**
 * OPTIONAL module. Image optimisation for Workers: framework-agnostic URL/attribute helpers (used by each adapter's `<Image>`) and the
 * `IMAGES`-binding route handler (`GET /_img`). Docs: docs/images.md.
 *
 * Backends (`ImagesConfig.backend`):
 *   - "cdn-cgi": `/cdn-cgi/image/width=640,quality=75,format=auto/<src>` - Cloudflare Images transformations on a zone you own (zero Worker CPU).
 *   - "binding": `/_img?src=..&w=640&q=75` served by `imagesHandler()` via the `IMAGES` binding, cached with the Cache API (works on workers.dev).
 *   - "none":    plain `src`, dimensions only (static pre-sized assets, see `cf-lite/vite-images`).
 *
 * Every transform URL is constrained to a whitelist (`widths`, `qualities`) so a client cannot mint unbounded cache keys, and remote sources
 * must match `allowHosts` (https only, redirects are not followed) - the SSRF guard.
 */
import type { Context } from "hono";

export type ImageBackend = "cdn-cgi" | "binding" | "none";
export type ImageFormat = "avif" | "webp" | "jpeg" | "png";

export interface ImagesConfig {
  /** Default "binding". */
  backend?: ImageBackend;
  /** Allowed output widths (ascending). Default {@link DEFAULT_WIDTHS}. */
  widths?: number[];
  /** Allowed quality values; the first is the default. Default `[75]`. */
  qualities?: number[];
  /** Route path of the binding backend. Default "/_img". */
  route?: string;
  /** Remote hosts a `src` may point at: exact (`cdn.example.com`) or `*.example.com`. https only. Default: none (no remote sources). */
  allowHosts?: string[];
  /** R2 binding names that may be used as `r2:<BINDING>/<key>` sources. Default: none. */
  r2?: string[];
  /** Serve same-origin `/path` sources through the `ASSETS` binding. Default true. */
  allowLocal?: boolean;
  /** Output formats that may be negotiated from `Accept`. Default all. */
  formats?: ImageFormat[];
  /** Max source size in bytes (Content-Length / body). Default 15 MiB. */
  maxBytes?: number;
  /** `Cache-Control` of transformed responses. Default one day + SWR; hashed `/assets/*` sources are `immutable`. */
  cacheControl?: string;
  /** What to do when `env.IMAGES` is missing: 501 (default) or serve the untouched source. */
  onMissingBinding?: "error" | "passthrough";
}

export const DEFAULT_WIDTHS = [320, 480, 640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const DEFAULT_QUALITIES = [75];
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

let globalConfig: ImagesConfig = {};
/** Set the config `<Image>` components and `imageAttrs` use by default (call once at app start; safe on server and client). */
export function configureImages(c: ImagesConfig): void { globalConfig = c; }
export const getImagesConfig = (): ImagesConfig => globalConfig;
export const defineImages = (c: ImagesConfig): ImagesConfig => c;

const widthsOf = (c: ImagesConfig) => [...(c.widths ?? DEFAULT_WIDTHS)].sort((a, b) => a - b);
const qualitiesOf = (c: ImagesConfig) => c.qualities ?? DEFAULT_QUALITIES;

/** Smallest whitelisted width >= `w` (or the largest one). */
export function snapWidth(w: number, c: ImagesConfig = globalConfig): number {
  const ws = widthsOf(c);
  return ws.find((x) => x >= w) ?? ws[ws.length - 1];
}

export interface ImageUrlOptions { width: number; quality?: number }

/** URL of one transformed variant of `src` for the configured backend (`width` must be whitelisted; snap with {@link snapWidth} first). */
export function imageUrl(src: string, o: ImageUrlOptions, c: ImagesConfig = globalConfig): string {
  const backend = c.backend ?? "binding";
  if (backend === "none") return src;
  const q = o.quality ?? qualitiesOf(c)[0];
  if (backend === "cdn-cgi") {
    const rest = /^[a-z][a-z0-9+.-]*:/i.test(src) ? src : src.replace(/^\/+/, "");
    return `/cdn-cgi/image/width=${o.width},quality=${q},format=auto/${rest}`;
  }
  return `${c.route ?? "/_img"}?src=${encodeURIComponent(src)}&w=${o.width}&q=${q}`;
}

export interface ImageProps {
  src: string;
  alt?: string;
  /** Intrinsic (or rendered, for fixed-size images) dimensions. Required unless `fill`. */
  width?: number;
  height?: number;
  /** Responsive `sizes`; when present `srcset` uses width descriptors, otherwise 1x/2x density descriptors. */
  sizes?: string;
  /** LCP image: `loading=eager` + `fetchpriority=high`. */
  priority?: boolean;
  quality?: number;
  /** Fill the positioned parent (`position:absolute; inset:0; width/height:100%`). */
  fill?: boolean;
  /** Tiny base64 (or any) data URL shown as a blurred background until the image loads (LQIP). */
  blurDataURL?: string;
  /** Skip the optimizer (SVG, already-optimised, animated GIF). */
  unoptimized?: boolean;
  /** Override the global config for this image. */
  config?: ImagesConfig;
}

/** Plain attribute object (lower-case, HTML names) all adapters spread onto `<img>`. `style` is a kebab-case CSS property map. */
export interface ImageAttrs {
  src: string;
  srcset?: string;
  sizes?: string;
  alt: string;
  width?: number;
  height?: number;
  loading: "eager" | "lazy";
  decoding: "async" | "sync";
  fetchpriority?: "high";
  style?: Record<string, string>;
}

export const cssText = (st: Record<string, string>) => Object.entries(st).map(([k, v]) => `${k}:${v}`).join(";");

const isSvg = (s: string) => /\.svg(?:[?#]|$)/i.test(s) || s.startsWith("data:");

export function imageAttrs(p: ImageProps): ImageAttrs {
  const c = p.config ?? globalConfig;
  if (!p.fill && (!p.width || !p.height)) throw new Error(`cf-lite <Image src="${p.src}">: width and height are required (prevents layout shift); use \`fill\` for unsized images`);
  const opt = !p.unoptimized && (c.backend ?? "binding") !== "none" && !isSvg(p.src);
  const ws = widthsOf(c);
  const variant = (w: number) => imageUrl(p.src, { width: snapWidth(w, c), quality: p.quality }, c);
  let src = p.src, srcset: string | undefined;
  if (opt) {
    if (p.sizes) {
      srcset = ws.map((w) => `${variant(w)} ${w}w`).join(", ");
      src = variant(ws.find((w) => w >= 640) ?? ws[ws.length - 1]);
    } else {
      const w1 = snapWidth(p.width ?? ws[ws.length - 1], c), w2 = snapWidth((p.width ?? ws[ws.length - 1]) * 2, c);
      srcset = w1 === w2 ? undefined : `${variant(w1)} 1x, ${variant(w2)} 2x`;
      src = variant(w1);
    }
  }
  const styles: Record<string, string> = {};
  if (p.fill) Object.assign(styles, { position: "absolute", inset: "0", width: "100%", height: "100%" });
  if (p.blurDataURL) Object.assign(styles, { "background-size": "cover", "background-image": `url("${p.blurDataURL.replace(/["\\()\s]/g, (m) => encodeURIComponent(m))}")` });
  const a: ImageAttrs = {
    src, alt: p.alt ?? "", loading: p.priority ? "eager" : "lazy", decoding: p.priority ? "sync" : "async",
  };
  if (srcset) a.srcset = srcset;
  if (p.sizes) a.sizes = p.sizes;
  if (!p.fill) { a.width = p.width; a.height = p.height; }
  if (p.priority) a.fetchpriority = "high";
  if (Object.keys(styles).length) a.style = styles;
  return a;
}

/** Render the attributes as an HTML `<img>` string (htmx/plain-HTML sites, tests). */
export function imgTag(p: ImageProps): string {
  const a = imageAttrs(p);
  const e = (s: string) => s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
  return "<img " + Object.entries(a).map(([k, v]) => `${k}="${e(k === "style" ? cssText(v as Record<string, string>) : String(v))}"`).join(" ") + ">";
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Binding backend: GET /_img
// ---------------------------------------------------------------------------------------------------------------------------------

interface ImagesBinding {
  input(s: ReadableStream<Uint8Array>): {
    transform(o: Record<string, unknown>): { output(o: { format: string; quality?: number }): Promise<{ response(): Response }> };
  };
}
export interface ImagesEnv { IMAGES?: ImagesBinding; ASSETS?: { fetch(r: Request | string): Promise<Response> }; [k: string]: unknown }

const MIME: Record<ImageFormat, string> = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg", png: "image/png" };
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\..*|10\..*|192\.168\..*|169\.254\..*|172\.(1[6-9]|2\d|3[01])\..*|\[.*\])$/i;

export function hostAllowed(host: string, allow: string[] | undefined): boolean {
  const h = host.toLowerCase().replace(/\.+$/, ""); // `localhost.` / `169.254.169.254.` are the same host
  if (PRIVATE_HOST.test(h) || /^\d+(\.\d+){3}$/.test(h)) return false; // never IP literals/internal names, even if listed
  return (allow ?? []).some((a) => { a = a.toLowerCase(); return a.startsWith("*.") ? h.endsWith(a.slice(1)) && h.length > a.length - 1 : h === a; });
}

/** Output format from `Accept` (restricted to `formats`); `fallback` is the source's own type. */
export function negotiateFormat(accept: string | null, formats: ImageFormat[] | undefined, fallback: ImageFormat): ImageFormat {
  const ok = formats ?? ["avif", "webp", "jpeg", "png"];
  const a = accept ?? "";
  if (ok.includes("avif") && /image\/avif/i.test(a)) return "avif";
  if (ok.includes("webp") && /image\/webp/i.test(a)) return "webp";
  return ok.includes(fallback) ? fallback : ok.includes("jpeg") ? "jpeg" : ok[0];
}

type Source = { ok: true; res: Response; immutable: boolean; key: string } | { ok: false; status: number; error: string };

async function fetchSource(src: string, req: Request, env: ImagesEnv, c: ImagesConfig): Promise<Source> {
  const bad = (status: number, error: string): Source => ({ ok: false, status, error });
  if (!src || src.length > 2048) return bad(400, "bad src");
  if (src.startsWith("r2:")) {
    const m = /^r2:([A-Za-z_][A-Za-z0-9_]*)\/(.+)$/.exec(src);
    if (!m || m[2].split("/").some((s) => s === ".." || s === ".")) return bad(400, "bad src");
    if (!(c.r2 ?? []).includes(m[1])) return bad(403, "r2 binding not allowed");
    const bucket = env[m[1]] as { get(k: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size: number } | null> } | undefined;
    const obj = await bucket?.get(m[2]);
    if (!obj) return bad(404, "not found");
    return { ok: true, res: new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-length": String(obj.size) } }), immutable: false, key: src };
  }
  if (src.startsWith("/")) {
    if (c.allowLocal === false) return bad(403, "local sources disabled");
    if (src.startsWith("//") || src.includes("\\") || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(src) || /[\u0000-\u001f]/.test(src)) return bad(400, "bad src");
    const path = src.split(/[?#]/)[0];
    if (path === (c.route ?? "/_img") || path.startsWith("/cdn-cgi/")) return bad(400, "bad src");
    if (!env.ASSETS) return bad(501, "ASSETS binding missing");
    const res = await env.ASSETS.fetch(new Request(new URL(path, req.url), { headers: { accept: "image/*" } }));
    if (!res.ok) return bad(res.status === 404 ? 404 : 502, "not found");
    return { ok: true, res, immutable: path.startsWith("/assets/"), key: path };
  }
  let u: URL;
  try { u = new URL(src); } catch { return bad(400, "bad src"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return bad(400, "only plain https sources");
  if (!hostAllowed(u.hostname, c.allowHosts)) return bad(403, "host not allowed");
  let res: Response;
  try { res = await fetch(u, { redirect: "manual", headers: { accept: "image/*" }, signal: AbortSignal.timeout(8000) }); } catch { return bad(502, "upstream unreachable"); }
  if (!res.ok) return bad(res.status === 404 ? 404 : 502, "upstream error"); // includes 3xx: redirects are never followed (SSRF)
  return { ok: true, res, immutable: false, key: u.toString() };
}

const typeOf = (ct: string | null): ImageFormat | "other" | null => {
  const t = (ct ?? "").split(";")[0].trim().toLowerCase();
  if (t === "image/jpeg" || t === "image/jpg") return "jpeg";
  if (t === "image/png") return "png";
  if (t === "image/webp") return "webp";
  if (t === "image/avif") return "avif";
  if (t === "image/gif") return "other";
  return null; // not an image (or svg: never transformed, never reflected)
};

export interface ImagesHandlerOptions extends ImagesConfig { /** Cache to use instead of `caches.default` (tests). */ cache?: Cache }

/**
 * Hono handler for the binding backend. Mount it on the configured route:
 *   `app.get("/_img", imagesHandler({ allowHosts: ["cdn.example.com"], r2: ["MEDIA"] }))`
 * (or use the `images()` convention: `cfLite({ conventions: [images()] })`, which also adds the Worker-first glob).
 */
export const imagesHandler = (o: ImagesHandlerOptions = {}) => async (c: Context<{ Bindings: any }>): Promise<Response> => {
  const cfg: ImagesConfig = { ...globalConfig, ...o };
  const url = new URL(c.req.url);
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return fail(405, "method not allowed");
  const src = url.searchParams.get("src") ?? "";
  const wRaw = url.searchParams.get("w") ?? "";
  const w = /^\d{1,5}$/.test(wRaw) ? Number(wRaw) : NaN;
  if (!widthsOf(cfg).includes(w)) return fail(400, "width not allowed");
  const qRaw = url.searchParams.get("q");
  const q = qRaw === null ? qualitiesOf(cfg)[0] : /^\d{1,3}$/.test(qRaw) ? Number(qRaw) : NaN;
  if (!qualitiesOf(cfg).includes(q)) return fail(400, "quality not allowed");

  const env = (c.env ?? {}) as ImagesEnv;
  const cache = o.cache ?? (globalThis as { caches?: { default?: Cache } }).caches?.default;
  // The Accept-derived format is part of the cache key (Vary: Accept semantics without relying on Cache API Vary support).
  const fmtFromAccept = negotiateFormat(c.req.header("accept") ?? null, cfg.formats, "jpeg");
  const cacheKey = new Request(`${url.origin}${cfg.route ?? "/_img"}?src=${encodeURIComponent(src)}&w=${w}&q=${q}&f=${fmtFromAccept}`);
  const hit = c.req.method === "GET" ? await cache?.match(cacheKey) : undefined;
  if (hit) { const r = new Response(hit.body, hit); r.headers.set("x-cf-lite-image", "HIT"); return r; }

  const s = await fetchSource(src, c.req.raw, env, cfg);
  if (!s.ok) return fail(s.status, s.error);
  const srcType = typeOf(s.res.headers.get("content-type"));
  if (!srcType) return fail(415, "source is not a transformable image");
  const len = Number(s.res.headers.get("content-length") ?? 0);
  if (len > (cfg.maxBytes ?? DEFAULT_MAX_BYTES)) return fail(413, "source too large");
  const format = negotiateFormat(c.req.header("accept") ?? null, cfg.formats, srcType === "other" ? "jpeg" : srcType);

  const cc = cfg.cacheControl ?? (s.immutable ? "public, max-age=31536000, immutable" : "public, max-age=86400, stale-while-revalidate=604800");
  let out: Response;
  if (!env.IMAGES) {
    if (cfg.onMissingBinding !== "passthrough") return fail(501, "IMAGES binding not configured");
    out = new Response(s.res.body, { headers: { "content-type": s.res.headers.get("content-type")!, "x-cf-lite-image": "PASSTHROUGH" } });
    out.headers.set("cache-control", "no-store");
    return out;
  }
  try {
    const r = await env.IMAGES.input(s.res.body!).transform({ width: w, fit: "scale-down" }).output({ format: MIME[format], quality: q });
    const rr = r.response();
    out = new Response(rr.body, { status: 200, headers: { "content-type": MIME[format], "cache-control": cc, vary: "Accept", "x-content-type-options": "nosniff", "x-cf-lite-image": "MISS" } });
  } catch { return fail(502, "transform failed"); }
  if (cache && c.req.method === "GET") {
    const copy = out.clone();
    const put = cache.put(cacheKey, copy);
    try { c.executionCtx.waitUntil(put); } catch { await put; }
  }
  return out;
};

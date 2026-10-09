/**
 * OPTIONAL module. Dynamic Open Graph images. A route file `app/routes/**\/_og.tsx` (default export: `(ctx) => element`) is served at
 * `<its directory URL>/opengraph-image.png` by `ogHandler()`. The handler evaluates your JSX to a plain element tree (no wasm in this Worker),
 * posts it to the **OG Worker** (`packages/cf-lite/og-worker`: satori + resvg-wasm) over the `OG` service binding and caches the PNG in the
 * Cache API (and R2 when configured). The main Worker's size is unchanged when this module is not imported. Docs: docs/metadata.md.
 */
import type { Context } from "hono";

export interface OgElement { type: string; props: Record<string, unknown> }
export type OgNode = OgElement | string | number | null | undefined | false | OgNode[];
/** Element factory for framework-free templates: `h("div", { style: { display: "flex" } }, "Hello")`. React/Preact (element-shaped) JSX also works. */
export function h(type: string | ((p: any) => OgNode), props: Record<string, unknown> | null, ...children: OgNode[]): OgElement {
  const p = { ...props, children: children.length <= 1 ? children[0] : children };
  return typeof type === "function" ? (type(p) as OgElement) : { type, props: p };
}

const isEl = (n: unknown): n is { type: unknown; props: Record<string, unknown> } => typeof n === "object" && n !== null && "type" in n && "props" in n;

/**
 * Element -> JSON-safe tree satori accepts: function components are called, fragments (symbol/"Fragment" types) are flattened, `null`/`false` dropped.
 * React 19 elements (`{ $$typeof, type, props }`) are supported because only `type` and `props` are read.
 */
export function serializeOg(node: unknown): unknown {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) {
    const kids = node.flatMap((n) => { const s = serializeOg(n); return s === null ? [] : Array.isArray(s) ? s : [s]; });
    return kids.length === 0 ? null : kids.length === 1 ? kids[0] : kids;
  }
  if (!isEl(node)) return null;
  const { type, props } = node;
  if (typeof type === "function") return serializeOg((type as (p: unknown) => unknown)(props));
  if (typeof type === "symbol") return serializeOg(props.children);
  const { children, ...rest } = props;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (typeof v !== "function" && v !== undefined && k !== "key" && k !== "ref") out[k] = v;
  const kids = serializeOg(children);
  if (kids !== null) out.children = kids;
  return { type: type as string, props: out };
}

export interface OgFont { name: string; /** URL or path on this site (fetched by the OG Worker; a same-origin `/fonts/x.ttf` is resolved against the request origin). */ url: string; weight?: number; style?: "normal" | "italic" }
export interface OgOptions {
  /** Output size. Default 1200x630. */
  width?: number;
  height?: number;
  /** TTF/OTF/WOFF (not WOFF2) fonts used by the template - satori needs at least one. */
  fonts: OgFont[];
  /** Service binding to the OG Worker. Default "OG". */
  binding?: string;
  /** Cache-Control of the PNG. Default: `immutable` for one year when the request carries `?v=`, else a day + SWR. */
  cacheControl?: string;
  /** Also keep the PNG in this R2 binding (key `og/<hash>.png`), so a cold colo/cache eviction does not re-render. */
  r2?: string;
}

export interface OgContext { params: Record<string, string>; url: URL; c: Context }
export type OgRender = (ctx: OgContext) => unknown | Promise<unknown>;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hono handler: render `template` through the OG Worker, cached. `x-cf-lite-og: HIT | MISS | R2`, `x-cf-lite-og-hash` = content hash of the input. */
export function ogHandler(template: OgRender, o: OgOptions) {
  const width = o.width ?? 1200, height = o.height ?? 630;
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const cache = typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
    const key = new Request(url.origin + url.pathname + url.search, { method: "GET" });
    const hit = await cache?.match(key);
    if (hit) { const r = new Response(hit.body, hit); r.headers.set("x-cf-lite-og", "HIT"); return r; }

    const tree = serializeOg(await template({ params: c.req.param() as Record<string, string>, url, c }));
    if (tree === null) return c.text("og template rendered nothing", 500);
    const fonts = o.fonts.map((f) => ({ ...f, url: new URL(f.url, url.origin).href }));
    const payload = JSON.stringify({ tree, width, height, fonts });
    const hash = await sha256(payload);
    const cc = o.cacheControl ?? (url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800");
    const respond = (png: BodyInit, how: string) => new Response(png, { headers: { "content-type": "image/png", "cache-control": cc, "x-cf-lite-og": how, "x-cf-lite-og-hash": hash } });
    const store = (png: ArrayBuffer) => { if (cache) c.executionCtx?.waitUntil(cache.put(key, respond(png.slice(0), "STORED"))); };

    const r2 = o.r2 ? ((c.env as Record<string, R2Bucket | undefined>)[o.r2]) : undefined;
    if (r2) {
      const obj = await r2.get(`og/${hash}.png`);
      if (obj) { const png = await obj.arrayBuffer(); store(png); return respond(png, "R2"); }
    }
    const svc = (c.env as Record<string, Fetcher | undefined>)[o.binding ?? "OG"];
    if (!svc) return c.text(`og: service binding ${o.binding ?? "OG"} is missing - deploy packages/cf-lite/og-worker and bind it`, 501);
    const res = await svc.fetch("https://og.internal/render", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    if (!res.ok) return c.text(`og: renderer failed (${res.status}): ${(await res.text()).slice(0, 300)}`, 502);
    const png = await res.arrayBuffer();
    if (r2) c.executionCtx?.waitUntil(r2.put(`og/${hash}.png`, png.slice(0), { httpMetadata: { contentType: "image/png" } }));
    store(png);
    return respond(png, "MISS");
  };
}

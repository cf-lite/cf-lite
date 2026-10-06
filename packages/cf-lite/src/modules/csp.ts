/**
 * Security headers + Content-Security-Policy (`cf-lite/modules/csp`). No node APIs: the pure helpers are also used by the build step
 * (`../vite-security.ts`, which writes the static policy into `_headers`) and the Worker middleware `security()` (per-request nonce).
 *
 *  - static pages (no Worker runs): CSP carries the sha256 of every inline `<script>`/`<style>` found in the built HTML, written to `_headers`.
 *  - SSR pages (Worker-first): `security()` mints a nonce per request, `ssr()` stamps it on the shell's inline scripts/styles and the
 *    response gets a policy with `'nonce-…'`. No `'unsafe-inline'` for scripts in either case.
 *  - `style-src-attr 'unsafe-inline'` stays in the `strict` preset: `style="…"` attributes (React `style={{}}`) cannot carry a nonce and
 *    cannot execute script; set `styleAttr: false` to forbid them too.
 */
import type { MiddlewareHandler } from "hono";

export type CspDirectives = Record<string, string[] | string | false>;

export interface SecurityOptions {
  /** "strict" (default): same-origin only, no inline script/style. "relaxed": also https images/fonts/connect and inline style elements. */
  preset?: "strict" | "relaxed";
  /** Merged over the preset per directive (`false` removes it). Values are source lists, e.g. `{ "img-src": ["'self'", "https://cdn.example"] }`. */
  csp?: CspDirectives | false;
  /** Send `Content-Security-Policy-Report-Only` instead (roll a policy out safely). */
  reportOnly?: boolean;
  /** Adds `report-uri` (and `Reporting-Endpoints` is left to you). */
  reportUri?: string;
  /** Allow `style="…"` attributes (default true; see file header). */
  styleAttr?: boolean;
  /** `Strict-Transport-Security`. Off by default: only enable once every subdomain is HTTPS. */
  hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  /** Extra/overriding response headers (`false` removes one). */
  headers?: Record<string, string | false>;
  /** Apply in `vite dev` too (default false: Vite's HMR/preamble scripts are inline). */
  dev?: boolean;
}

const SELF = "'self'";

const PRESETS: Record<"strict" | "relaxed", Record<string, string[]>> = {
  strict: {
    "default-src": [SELF],
    "script-src": [SELF],
    "style-src": [SELF],
    "img-src": [SELF, "data:"],
    "font-src": [SELF],
    "connect-src": [SELF],
    "media-src": [SELF],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": [SELF],
    "frame-ancestors": ["'none'"],
  },
  relaxed: {
    "default-src": [SELF],
    "script-src": [SELF],
    "style-src": [SELF, "'unsafe-inline'"],
    "img-src": [SELF, "data:", "https:"],
    "font-src": [SELF, "data:", "https:"],
    "connect-src": [SELF, "https:"],
    "media-src": [SELF, "https:"],
    "object-src": ["'none'"],
    "base-uri": [SELF],
    "form-action": [SELF],
    "frame-ancestors": [SELF],
  },
};

/** Source values a build/request adds to `script-src` / `style-src` (hashes or a nonce). */
export interface Dynamic { scriptSrc?: string[]; styleSrc?: string[] }

const list = (v: string[] | string): string[] => (Array.isArray(v) ? v : v.split(/\s+/).filter(Boolean));

/** Resolve the directive table (preset + overrides + dynamic sources) into a policy string. */
export function buildCsp(o: SecurityOptions = {}, dyn: Dynamic = {}): string {
  const table: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(PRESETS[o.preset ?? "strict"])) table[k] = [...v];
  if (o.csp) for (const [k, v] of Object.entries(o.csp)) { if (v === false) delete table[k]; else table[k] = list(v); }
  // Hashes/nonces only matter when 'unsafe-inline' is absent (it would be ignored) - add them regardless, harmless and explicit.
  const add = (name: string, extra?: string[]) => {
    if (!extra?.length) return;
    const base = table[name] ?? table["default-src"] ?? [SELF];
    table[name] = [...new Set([...base, ...extra])];
  };
  add("script-src", dyn.scriptSrc);
  add("style-src", dyn.styleSrc);
  if (o.styleAttr !== false && !table["style-src-attr"]) table["style-src-attr"] = ["'unsafe-inline'"];
  if (o.reportUri) table["report-uri"] = [o.reportUri];
  return Object.entries(table).map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k)).join("; ");
}

/** The non-CSP headers of the preset. */
export function baseHeaders(o: SecurityOptions = {}): Record<string, string> {
  const h: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (o.hsts) {
    const x = o.hsts === true ? {} : o.hsts;
    h["Strict-Transport-Security"] = `max-age=${x.maxAge ?? 31536000}${x.includeSubDomains ? "; includeSubDomains" : ""}${x.preload ? "; preload" : ""}`;
  }
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    const existing = Object.keys(h).find((e) => e.toLowerCase() === k.toLowerCase());
    if (existing) delete h[existing];
    if (v !== false) h[k] = v;
  }
  return h;
}

export const cspHeaderName = (o: SecurityOptions = {}) => (o.reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy");

/** sha256 CSP source (`'sha256-…'`) of a script/style body. */
export async function cspHash(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = ""; for (const b of d) s += String.fromCharCode(b);
  return `'sha256-${btoa(s)}'`;
}

const JS_TYPES = /^(|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);

/** Bodies of inline (no `src`) executable scripts and of `<style>` elements in an HTML document. */
export function inlineBlocks(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [], styles: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const a = m[1] ?? "";
    if (attr(a, "src")) continue;
    const t = attr(a, "type"); const type = t ? (t[1] ?? t[2] ?? t[3] ?? "") : "";
    if (!JS_TYPES.test(type.trim()) || !m[2]) continue; // JSON-LD / importmap-like data blocks are not executed
    scripts.push(m[2]);
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) if (m[1]) styles.push(m[1]);
  return { scripts, styles };
}

/** Hash sources for every inline script/style across the given HTML documents (deduplicated, sorted: stable output). */
export async function hashesFor(docs: string[]): Promise<Required<Dynamic>> {
  const s = new Set<string>(), t = new Set<string>();
  for (const d of docs) {
    const b = inlineBlocks(d);
    for (const x of b.scripts) s.add(await cspHash(x));
    for (const x of b.styles) t.add(await cspHash(x));
  }
  return { scriptSrc: [...s].sort(), styleSrc: [...t].sort() };
}

/** `_headers` text for the built static site: base headers + one CSP with the hashes of all inline blocks across `docs`. */
export async function staticHeaders(docs: string[], o: SecurityOptions = {}): Promise<string> {
  const h = baseHeaders(o);
  if (o.csp !== false) h[cspHeaderName(o)] = buildCsp(o, await hashesFor(docs));
  return `/*\n${Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`;
}

/** Fresh per-request nonce (128 bits, base64). */
export function makeNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Stamp `nonce` on every `<script>` / `<style>` opening tag in `html` that has none. Attribute text is left alone. */
export function addNonce(html: string, nonce: string): string {
  return html.replace(/<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (m, tag: string, attrs: string) => (/(?:^|\s)nonce\s*=/i.test(attrs) ? m : `<${tag} nonce="${nonce}"${attrs}>`));
}

declare module "hono" { interface ContextVariableMap { cspNonce?: string } }

/**
 * Hono middleware for Worker-served responses: security headers on everything, a nonce-based CSP on HTML that does not already
 * carry one (static-first responses from the assets layer keep their build-time hash policy). `ssr()` reads `c.get("cspNonce")`.
 *
 *   // server/middleware.ts
 *   import { security } from "cf-lite/modules/csp";
 *   export default security({ preset: "strict" });
 */
export function security(o: SecurityOptions = {}): MiddlewareHandler {
  const base = baseHeaders(o);
  const name = cspHeaderName(o);
  const dev = !!(import.meta as any).env?.DEV;
  return async (c, next) => {
    if (dev && !o.dev) return next();
    const nonce = o.csp === false ? undefined : makeNonce();
    if (nonce) c.set("cspNonce", nonce);
    await next();
    let res = c.res;
    const isHtml = (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
    const needCsp = !!nonce && isHtml && !res.headers.has(name) && !res.headers.has("content-security-policy");
    const missing = Object.entries(base).filter(([k]) => !res.headers.has(k));
    if (!needCsp && !missing.length) return;
    try { for (const [k, v] of missing) res.headers.set(k, v); if (needCsp) res.headers.set(name, buildCsp(o, { scriptSrc: [`'nonce-${nonce}'`], styleSrc: [`'nonce-${nonce}'`] })); }
    catch { // immutable headers (a Response straight from fetch/ASSETS): rebuild
      res = new Response(res.body, res);
      for (const [k, v] of missing) res.headers.set(k, v);
      if (needCsp) res.headers.set(name, buildCsp(o, { scriptSrc: [`'nonce-${nonce}'`], styleSrc: [`'nonce-${nonce}'`] }));
      c.res = res;
    }
  };
}

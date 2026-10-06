/**
 * OPTIONAL module (only bundled if imported). Draft mode: a CMS-agnostic preview primitive (docs/draft-mode.md).
 *
 *   // server/middleware.ts (after security() / session())
 *   export default [security(), draft({ frameAncestors: ["https://cms.example.com"] })];
 *   // server/routes: app.route("/api/draft", draftRoutes({ verifyToken: (t) => cms.checkPreviewToken(t) }))
 *   // loader:        export const loader = async ({ c }) => getPost(slug, { drafts: isDraft(c) });
 *
 * A preview request carries the sealed `__cfl_preview` cookie (AES-GCM via the session module's `sealData`, `aad` = cookie name, so it
 * cannot be forged or replayed as a session). `draft()` verifies it once per request and sets `c.get("draft")`; `isDraft(c)` reads it.
 * Draft responses are `private, no-store` + `noindex`, and `cache()` / `isr()` bypass on the mere *presence* of the cookie (no crypto,
 * fail toward bypass), so a draft is never stored and a stored copy is never served to a previewer.
 *
 * Env: DRAFT_SECRET  comma-separated secrets, each >= 32 chars. First = signs cookies; every entry is accepted by the enable endpoint
 * (rotation). Missing/short = the enable endpoint fails closed (503); `draft()` simply never sees a valid cookie.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { parseSecrets, safeEqual, sealData, unsealData } from "./session.js";

export const DRAFT_COOKIE = "__cfl_preview";
const MAX_AGE_DEFAULT = 3600, MAX_AGE_CAP = 24 * 3600;

export interface DraftState { /** unix seconds the cookie expires */ exp: number; /** unix seconds issued */ iat: number; /** free-form CMS context (document id, locale, ...) */ ctx?: Record<string, string> }
declare module "hono" { interface ContextVariableMap { draft?: DraftState } }

export interface DraftOptions {
  /** Secrets (default: `DRAFT_SECRET` env). Tests may pass them directly. */
  secrets?: string | string[];
  /** Cookie lifetime in seconds (default 3600, capped at 24 h). Enforced inside the sealed value, not only by the browser. */
  maxAge?: number;
  /** Origins allowed to iframe a *draft* response (`https://cms.example.com`). Replaces `frame-ancestors` in the CSP and drops `X-Frame-Options` for drafts only. Also switches the cookie to `SameSite=None` on https (needed for a cross-site iframe). */
  frameAncestors?: string[] | ((c: Context) => string[] | Promise<string[]>);
  /** Env var names read (comma/space separated origins) at request time and merged into `frameAncestors`. Default `["DRAFT_FRAME_ANCESTORS", "CMS_ORIGINS"]`; `[]` disables. Invalid entries are ignored (fail toward not relaxing). */
  frameAncestorsEnv?: string[];
  /** The CMS-issued `token` is the credential: `enable` needs no `secret` (the secret then only seals the cookie). Requires `verifyToken`. */
  tokenOnly?: boolean;
  /** Extra check on the CMS-provided `token` query param (e.g. verify a short-lived signed preview token). Return false/throw to refuse. */
  verifyToken?: (token: string | null, c: Context) => boolean | Promise<boolean>;
  /** Make `token` mandatory (default: only when `verifyToken` is set). */
  requireToken?: boolean;
  /** Paths the enable endpoint may redirect to (default: any same-origin path). Prefix match. */
  allowPaths?: string[];
  /** Route patterns (`/blog/:slug`, `/docs/*?`) of prerendered pages. A matching `path` is redirected to `/__preview<path>` (a Worker-first route that renders the page on demand). Generated from `cfLite({ draft })`. */
  previewPatterns?: string[];
  /** Copy these query params from the enable request into `DraftState.ctx` (default none). */
  ctxParams?: string[];
}

const dsecrets = (c: Context, o: DraftOptions): string[] | null => {
  try { return parseSecrets(o.secrets ?? (c.env as { DRAFT_SECRET?: string } | undefined)?.DRAFT_SECRET); } catch { return null; }
};
const ttl = (o: DraftOptions) => Math.min(MAX_AGE_CAP, Math.max(1, Math.floor(o.maxAge ?? MAX_AGE_DEFAULT)));
const nowS = () => Math.floor(Date.now() / 1000);

function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
/** True when `draft()` verified the request's `__cfl_preview` cookie. Always false without the middleware. */
export const isDraft = (c: Context): boolean => !!c.get("draft");
/** The verified draft state (expiry, CMS context) or undefined. */
export const draftState = (c: Context): DraftState | undefined => c.get("draft");

const FA_ORIGIN = /^(https?:\/\/[A-Za-z0-9*.-]+(:\d+)?|'self')$/;
function checkAncestors(list: string[] | undefined | ((c: Context) => unknown)): string[] {
  const out = typeof list === "function" ? [] : list ?? [];
  for (const o of out) if (!FA_ORIGIN.test(o) || o === "*" || o.startsWith("*") || /^https?:\/\/\*$/.test(o)) throw new Error(`cf-lite draft: bad frameAncestors entry ${JSON.stringify(o)} (use https://host[:port] or 'self'; no bare wildcards)`);
  return out;
}

const isOrigin = (o: string) => FA_ORIGIN.test(o) && o !== "*" && !o.startsWith("*") && !/^https?:\/\/\*$/.test(o);
/** Static + function + env (`DRAFT_FRAME_ANCESTORS`, `CMS_ORIGINS`) ancestors for this request. Static/function entries throw if bad; env entries are filtered. */
async function ancestorsOf(c: Context, o: DraftOptions, fixed: string[]): Promise<string[]> {
  let fromFn: string[] = [];
  if (typeof o.frameAncestors === "function") { try { fromFn = checkAncestors(await o.frameAncestors(c)); } catch { /* bad/throwing resolver: do not relax */ } }
  const env = (c.env ?? {}) as Record<string, unknown>;
  const fromEnv = (o.frameAncestorsEnv ?? ["DRAFT_FRAME_ANCESTORS", "CMS_ORIGINS"]).flatMap((k) => (typeof env[k] === "string" ? (env[k] as string).split(/[\s,]+/).filter(isOrigin) : []));
  return [...new Set([...fixed, ...fromFn, ...fromEnv])];
}

/** Replace/append `frame-ancestors` in a CSP header value. Pure; exported for tests. */
export function withFrameAncestors(csp: string, origins: string[]): string {
  const dir = `frame-ancestors 'self' ${origins.join(" ")}`.trim();
  const parts = csp.split(";").map((s) => s.trim()).filter(Boolean);
  const i = parts.findIndex((p) => /^frame-ancestors(\s|$)/i.test(p));
  if (i >= 0) parts[i] = dir; else parts.push(dir);
  return parts.join("; ");
}

/** Same-origin relative path only: starts with one `/`, no `//`, `/\`, control chars. Anything else -> `/`. */
export function safeRedirectPath(p: string | null | undefined, allow?: string[]): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\") || /[\u0000-\u001f\u007f\\]/.test(p)) return "/";
  if (allow?.length && !allow.some((a) => p === a || p.startsWith(a.endsWith("/") ? a : a + "/") || p.startsWith(a + "?"))) return "/";
  return p;
}

export const PREVIEW_PREFIX = "/__preview";
const patRe = (p: string) => new RegExp("^" + p.split("/").map((seg) => (seg === "*" || seg === "*?" ? ".*" : seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/").replace(/\/\.\*$/, "(?:/.*)?") + "/?$");
/** Redirect target for the enable endpoint: prerendered pages go through `/__preview`. Pure; exported for tests. */
export function previewTarget(path: string, patterns: string[] | undefined): string {
  if (!patterns?.length || path === PREVIEW_PREFIX || path.startsWith(PREVIEW_PREFIX + "/")) return path;
  const pathname = path.split(/[?#]/)[0];
  return patterns.some((p) => patRe(p).test(pathname)) ? PREVIEW_PREFIX + path : path;
}

/** Wrap a generated preview handler: only a verified draft may reach it (`draft()` must be installed); everyone else gets the normal 404. */
export const previewOnly = <H extends (c: Context) => Response | Promise<Response>>(h: H) => (c: Context): Response | Promise<Response> => (isDraft(c) ? h(c) : c.notFound());

const secure = (req: Request) => new URL(req.url).protocol === "https:";
function setCookie(req: Request, embedding: boolean, value: string, maxAge: number): string {
  const embed = embedding && secure(req);
  return `${DRAFT_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${embed ? "None" : "Lax"}${secure(req) ? "; Secure" : ""}`;
}

function mutable(c: Context): Response {
  try { c.res.headers.set("x-cfl-probe", "1"); c.res.headers.delete("x-cfl-probe"); return c.res; }
  catch { c.res = new Response(c.res.body, c.res); return c.res; }
}

/** Middleware: verifies the cookie, sets `c.get("draft")`, and hardens draft responses. Non-draft requests pass through untouched. */
export function draft(o: DraftOptions = {}): MiddlewareHandler {
  const fixed = checkAncestors(o.frameAncestors);
  return async (c, next) => {
    const raw = cookieOf(c.req.raw, DRAFT_COOKIE);
    const secrets = raw ? dsecrets(c, o) : null;
    const st = raw && secrets ? await unsealData<DraftState>(raw, secrets, DRAFT_COOKIE) : null;
    const valid = !!st && typeof st.exp === "number" && st.exp > nowS();
    if (valid) c.set("draft", st!);
    await next();
    if (!raw) return;
    // A cookie that is present but invalid/expired still gets no-store (a shared cache must not hold what was rendered for it),
    // but only a valid one can see draft content (isDraft was false while rendering).
    const res = mutable(c);
    res.headers.set("cache-control", "private, no-store");
    res.headers.append("vary", "Cookie");
    if (valid) {
      res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      res.headers.set("x-cf-lite-draft", "1");
      const ancestors = await ancestorsOf(c, o, fixed);
      if (ancestors.length) {
        for (const h of ["content-security-policy", "content-security-policy-report-only"]) {
          const v = res.headers.get(h);
          if (v) res.headers.set(h, withFrameAncestors(v, ancestors));
        }
        if (!res.headers.has("content-security-policy")) res.headers.set("content-security-policy", `frame-ancestors 'self' ${ancestors.join(" ")}`);
        res.headers.delete("x-frame-options");
      }
    }
  };
}

const noStore = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

/**
 * Enable/disable endpoints. Mount anywhere: `app.route("/api/draft", draftRoutes(opts))` -> `GET /api/draft/enable`, `GET|POST /api/draft/disable`.
 *
 *   enable?secret=<DRAFT_SECRET>&path=/blog/x[&token=<cms token>]   (or `Authorization: Bearer <secret>`)
 *     -> 307 to `path` (same-origin only) + `Set-Cookie: __cfl_preview`
 *   disable[?path=/]  -> 307 + cookie cleared (needs no secret: it only ever reduces access)
 */
/**
 * Mint the draft cookie for the current request: the single place that seals the state, picks `SameSite`, sanitises `path` and adds
 * the no-store headers. `draftRoutes` calls it after checking the secret/token; a custom route may call it after verifying a
 * CMS-issued credential itself (`secrets` must be configured or it answers 503).
 */
export async function enableDraft(c: Context, o: DraftOptions = {}, init: { path?: string | null; ctx?: Record<string, string>; maxAge?: number } = {}): Promise<Response> {
  const secrets = dsecrets(c, o);
  if (!secrets) return c.json({ error: "draft mode is not configured (DRAFT_SECRET)" }, 503, noStore);
  const t = init.maxAge ? ttl({ maxAge: init.maxAge }) : ttl(o), now = nowS();
  const ctx: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.ctx ?? {})) ctx[k] = String(v).slice(0, 256);
  const state: DraftState = { iat: now, exp: now + t, ...(Object.keys(ctx).length ? { ctx } : {}) };
  const sealed = await sealData(state, secrets, DRAFT_COOKIE);
  const embedding = (await ancestorsOf(c, o, checkAncestors(o.frameAncestors))).length > 0;
  return new Response(null, { status: 307, headers: { location: previewTarget(safeRedirectPath(init.path, o.allowPaths), o.previewPatterns), "set-cookie": setCookie(c.req.raw, embedding, sealed, t), ...noStore } });
}

export function draftRoutes(o: DraftOptions = {}): Hono {
  checkAncestors(o.frameAncestors);
  if (o.tokenOnly && !o.verifyToken) throw new Error("cf-lite draft: tokenOnly needs verifyToken");
  const app = new Hono();
  app.on(["GET", "HEAD"], "/enable", async (c) => {
    const secrets = dsecrets(c, o);
    if (!secrets) return c.json({ error: "draft mode is not configured (DRAFT_SECRET)" }, 503, noStore);
    if (!o.tokenOnly) {
      const given = c.req.query("secret") ?? /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
      let ok = false;
      for (const s of secrets) ok = safeEqual(given, s) || ok; // no early exit
      if (!ok) return c.json({ error: "unauthorized" }, 401, noStore);
    }
    const token = c.req.query("token") ?? null;
    if (o.verifyToken || o.requireToken) {
      let tok = !((o.requireToken || o.tokenOnly) && !token);
      if (tok && o.verifyToken) { try { tok = !!(await o.verifyToken(token, c)); } catch { tok = false; } }
      if (!tok) return c.json({ error: "unauthorized" }, 401, noStore);
    }
    const ctx: Record<string, string> = {};
    for (const k of o.ctxParams ?? []) { const v = c.req.query(k); if (v !== undefined) ctx[k] = v; }
    return enableDraft(c, o, { path: c.req.query("path"), ctx });
  });
  app.on(["GET", "POST"], "/disable", (c) =>
    new Response(null, { status: 307, headers: { location: safeRedirectPath(c.req.query("path"), o.allowPaths), "set-cookie": setCookie(c.req.raw, false, "", 0), ...noStore } }));
  return app;
}

/**
 * CSRF protection for state-changing requests (`cf-lite/modules/csrf`). Used by server actions and usable as Hono middleware.
 *
 * Fetch-metadata first, `Origin` second, no token state:
 *  - `Sec-Fetch-Site: same-origin | none` -> ok; `cross-site | same-site` -> reject (same-site = a sibling subdomain, not us).
 *  - otherwise (older clients, non-browser) `Origin` must equal the request origin or be listed in `allowedOrigins`.
 *  - neither header -> reject (browsers always send `Origin` on a cross-origin POST); `allowMissingOrigin` opts non-browser callers in.
 * Safe methods (GET/HEAD/OPTIONS) are never checked. Pair with `SameSite=Lax` cookies (the `cf-lite/modules/session` default).
 */
import type { Context, MiddlewareHandler } from "hono";

export interface CsrfOptions {
  /** Extra origins allowed to POST cross-origin (an embeddable form, a partner site): exact `https://host` strings. */
  allowedOrigins?: string[];
  /** Accept requests carrying neither `Origin` nor `Sec-Fetch-Site` (curl, server-to-server). Default false. */
  allowMissingOrigin?: boolean;
  /** Request content types a form-style mutation may use. Default: urlencoded + multipart (what a `<form>` can send without CORS preflight that matters). */
  contentTypes?: string[];
}

export const FORM_CONTENT_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export type CsrfVerdict = { ok: true } | { ok: false; status: 403 | 415; reason: string };

/** Pure check on a Request; returns the reason it is refused (for logs/tests) instead of a Response. */
export function csrfVerdict(req: Request, o: CsrfOptions = {}): CsrfVerdict {
  if (SAFE.has(req.method)) return { ok: true };
  const url = new URL(req.url);
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const allowed = o.allowedOrigins ?? [];
  if (site) {
    if (site !== "same-origin" && site !== "none") {
      if (!(origin && allowed.includes(origin))) return { ok: false, status: 403, reason: `Sec-Fetch-Site: ${site}` };
    }
  } else if (origin) {
    if (origin !== url.origin && !allowed.includes(origin)) return { ok: false, status: 403, reason: `Origin ${origin}` };
  } else if (!o.allowMissingOrigin) return { ok: false, status: 403, reason: "no Origin / Sec-Fetch-Site" };
  // `Origin: null` (sandboxed iframe, redirect chains) is neither our origin nor allowed -> already rejected above when present.
  const cts = o.contentTypes ?? FORM_CONTENT_TYPES;
  if (cts.length) {
    const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!cts.includes(ct)) return { ok: false, status: 415, reason: `content-type ${ct || "(none)"}` };
  }
  return { ok: true };
}

/** Response for a refused request (plain text; the reason is logged, never sent). */
export function csrfResponse(v: Extract<CsrfVerdict, { ok: false }>): Response {
  return new Response(v.status === 415 ? "Unsupported Media Type" : "Cross-site request blocked", { status: v.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Hono middleware: `app.use("*", csrf())`. */
export function csrf(o: CsrfOptions = {}): MiddlewareHandler {
  return async (c: Context, next) => {
    const v = csrfVerdict(c.req.raw, o);
    if (!v.ok) { console.warn(`[cf-lite] csrf blocked ${c.req.method} ${new URL(c.req.url).pathname}: ${v.reason}`); return csrfResponse(v); }
    await next();
  };
}

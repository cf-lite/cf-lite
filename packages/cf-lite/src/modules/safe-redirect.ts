/**
 * Open-redirect guards (`cf-lite/modules/safe-redirect`, dependency-free). Use on ANY user-influenced redirect target
 * (`?returnTo=`, `?next=`, a form field) before `redirect()` / `Response.redirect()` / `ssoLoginUrl()`.
 *
 *  - `safeReturnTo(v)`: same-site relative path only (what login flows want).
 *  - `safeRedirectUrl(v, { base, allowedOrigins })`: a relative path, OR an absolute URL whose origin is in an explicit allow-list.
 *
 * Both return `fallback` for anything else: `//host`, `/\host`, `\\host`, `javascript:`/`data:` schemes, control characters
 * (browsers strip tab/CR/LF from URLs, so `/\t/evil.com` would become `//evil.com`), credentials in the URL, over-long values.
 */
const MAX_LEN = 2048;
const CONTROL = /[\u0000-\u001f\u007f\\]/;

/** Only same-site relative paths survive; anything else (absolute, `//host`, `/\host`, control chars) becomes `fallback`. */
export function safeReturnTo(v: string | null | undefined, fallback = "/"): string {
  if (!v || v.length > MAX_LEN || v[0] !== "/" || v[1] === "/" || v[1] === "\\" || CONTROL.test(v)) return fallback;
  try { const u = new URL(v, "https://x.invalid"); if (u.origin !== "https://x.invalid") return fallback; } catch { return fallback; }
  return v;
}

export interface SafeRedirectOptions {
  /** Origins (exact `https://host[:port]`) an absolute target may point to. Default none = relative paths only. */
  allowedOrigins?: string[];
  /** Returned when the target is refused. Default "/". */
  fallback?: string;
}

/** Relative path (as `safeReturnTo`) or an absolute http(s) URL whose origin is listed in `allowedOrigins`; otherwise `fallback`. */
export function safeRedirectUrl(v: string | null | undefined, o: SafeRedirectOptions = {}): string {
  const fallback = o.fallback ?? "/";
  if (!v || v.length > MAX_LEN || CONTROL.test(v)) return fallback;
  if (v[0] === "/") return safeReturnTo(v, fallback);
  if (!/^https?:\/\//i.test(v)) return fallback;
  try {
    const u = new URL(v);
    if (u.username || u.password) return fallback;
    const allow = (o.allowedOrigins ?? []).map((a) => { try { return new URL(a).origin; } catch { return ""; } }).filter(Boolean);
    return allow.includes(u.origin) ? u.toString() : fallback;
  } catch { return fallback; }
}

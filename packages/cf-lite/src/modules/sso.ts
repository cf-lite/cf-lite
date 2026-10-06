/**
 * OPTIONAL module (off by default — only bundled if you import it).
 * Verifies an Ed25519 (EdDSA) JWT carried in a cookie, WebCrypto only, no deps. Verify-only: it never issues tokens.
 * Nothing is hard-coded: issuer, audience, cookie name and login origin all come from env (or per-call options).
 *
 * Env (all strings, e.g. wrangler `vars`):
 *   SSO_PUBLIC_KEYS     required. Either a JWKS `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"k1","x":"<base64url>"}]}`
 *                       or a plain map `{"<kid>":"<base64 raw 32-byte Ed25519 public key>"}`.
 *   SSO_ISSUER          required. Expected `iss` claim, e.g. "auth.example.com".
 *   SSO_AUDIENCE        required. Expected `aud` claim (string, or an array that contains it). Unset/empty = config error:
 *                       requireSso answers 500, verifySsoToken returns {ok:false, config:true}; never "unchecked".
 *   SSO_COOKIE_NAME     optional, default "sso".
 *   SSO_AUTH_ORIGIN     optional, only for ssoLoginUrl(): e.g. "https://auth.example.com" (serves /login and /refresh).
 *   SSO_RETURN_ORIGINS  optional, "https://a.example,https://b.example": ssoLoginUrl() refuses any return URL that is not a relative path or on this list (open-redirect guard).
 *   SSO_ALLOWED_LOGINS  optional, "a,b": only these `sub` values pass.
 *   SSO_REFRESH_AFTER_S optional, seconds after `iat` when a valid token counts as stale (default 604800 = 7 days).
 */
import type { MiddlewareHandler } from "hono";
import { safeRedirectUrl } from "./safe-redirect.js";

const DEFAULT_COOKIE = "sso";
const DEFAULT_REFRESH_AFTER_S = 7 * 24 * 3600;

export interface SsoEnv {
  SSO_PUBLIC_KEYS?: string; SSO_ISSUER?: string; SSO_AUDIENCE?: string; SSO_COOKIE_NAME?: string;
  SSO_AUTH_ORIGIN?: string; SSO_RETURN_ORIGINS?: string; SSO_ALLOWED_LOGINS?: string; SSO_REFRESH_AFTER_S?: string;
}
export interface SsoClaims { sub: string; iat: number; nbf?: number; exp: number; iss: string; aud?: string | string[]; sid?: string }
/** `config: true` = the deployment is misconfigured (not a bad token); gates should answer 500, not 401/redirect. */
export type SsoResult = { ok: true; claims: SsoClaims; stale: boolean } | { ok: false; reason: string; config?: true };

const dec = new TextDecoder();
const unb64u = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url"); // atob() would silently accept whitespace / `+` `/` / padding variants
  return unb64uRaw(s);
};
const unb64uRaw = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const keyCache = new Map<string, Promise<CryptoKey>>();
const b64uToB64 = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");
/** Accepts a JWKS ({keys:[{kty:"OKP",crv:"Ed25519",kid,x}]}) or a {kid: base64-public-key} map; returns kid -> base64 raw key. */
function parseKeys(raw: string | undefined): Record<string, string> | null {
  try {
    const j = JSON.parse(raw ?? "");
    if (j && Array.isArray(j.keys)) {
      const out: Record<string, string> = {};
      for (const k of j.keys) if (k && k.kty === "OKP" && k.crv === "Ed25519" && typeof k.kid === "string" && typeof k.x === "string") out[k.kid] = b64uToB64(k.x);
      return out;
    }
    return j && typeof j === "object" ? j : null;
  } catch { return null; }
}
const importPub = (b64: string) => {
  let p = keyCache.get(b64);
  if (!p) { p = crypto.subtle.importKey("raw", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]); keyCache.set(b64, p); }
  return p;
};

export const ssoCookieName = (env: SsoEnv) => env.SSO_COOKIE_NAME || DEFAULT_COOKIE;

/** First missing required setting, or null. Checked on every verify (so the first request fails loudly) and by `cf-lite doctor` (CFL013). */
export function ssoConfigError(env: SsoEnv): string | null {
  if (!parseKeys(env.SSO_PUBLIC_KEYS)) return "SSO_PUBLIC_KEYS not configured";
  if (!env.SSO_ISSUER) return "SSO_ISSUER not configured";
  if (!env.SSO_AUDIENCE) return "SSO_AUDIENCE not configured";
  return null;
}

export function cookieValue(req: Request, name = DEFAULT_COOKIE): string | undefined {
  for (const p of (req.headers.get("cookie") ?? "").split(";")) {
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim();
  }
}

export async function verifySsoToken(token: string | undefined, env: SsoEnv, nowS = Math.floor(Date.now() / 1000)): Promise<SsoResult> {
  const bad = ssoConfigError(env);
  if (bad) return { ok: false, reason: bad, config: true };
  if (!token) return { ok: false, reason: "no token" };
  const keys = parseKeys(env.SSO_PUBLIC_KEYS)!;
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  try {
    const header = JSON.parse(dec.decode(unb64u(parts[0])));
    if (header.alg !== "EdDSA" || header.typ !== "JWT" || typeof header.kid !== "string") return { ok: false, reason: "bad header" };
    const pub = Object.prototype.hasOwnProperty.call(keys, header.kid) ? keys[header.kid] : undefined;
    if (!pub) return { ok: false, reason: "unknown kid" };
    const good = await crypto.subtle.verify("Ed25519", await importPub(pub), unb64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!good) return { ok: false, reason: "bad signature" };
    const c = JSON.parse(dec.decode(unb64u(parts[1]))) as SsoClaims;
    if (typeof c.sub !== "string" || !c.sub || typeof c.exp !== "number" || typeof c.iat !== "number") return { ok: false, reason: "bad claims" };
    const aud = typeof c.aud === "string" ? [c.aud] : Array.isArray(c.aud) ? c.aud : [];
    if (c.iss !== env.SSO_ISSUER || !aud.includes(env.SSO_AUDIENCE!)) return { ok: false, reason: "wrong iss/aud" };
    if (c.exp <= nowS) return { ok: false, reason: "expired" };
    if (c.exp <= c.iat) return { ok: false, reason: "exp not after iat" };
    if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > nowS + 60)) return { ok: false, reason: "not yet valid" };
    if (c.iat > nowS + 60) return { ok: false, reason: "iat in future" };
    const allow = (env.SSO_ALLOWED_LOGINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(c.sub.toLowerCase())) return { ok: false, reason: "sub not allowed" };
    return { ok: true, claims: c, stale: nowS - c.iat > (Number(env.SSO_REFRESH_AFTER_S) || DEFAULT_REFRESH_AFTER_S) };
  } catch { return { ok: false, reason: "malformed" }; }
}

/** Hono middleware: 401 JSON for API callers; sets c.var.sso = claims. Mount it per-route, never globally by default. */
export const requireSso = (): MiddlewareHandler<{ Bindings: SsoEnv; Variables: { sso: SsoClaims } }> => async (c, next) => {
  const r = await verifySsoToken(cookieValue(c.req.raw, ssoCookieName(c.env)), c.env);
  if (!r.ok) return r.config ? c.json({ error: "sso misconfigured", reason: r.reason }, 500) : c.json({ error: "unauthorized", reason: r.reason }, 401);
  c.set("sso", r.claims);
  await next();
};

/** Read + verify the `sso` cookie of a request (for apps that build their own gate, e.g. browser redirects instead of 401 JSON). */
export const readSso = (req: Request, env: SsoEnv) => verifySsoToken(cookieValue(req, ssoCookieName(env)), env);

/** Where to send a browser without a (valid) session. Needs `SSO_AUTH_ORIGIN` in env. `refresh` = stale-but-valid (`SsoResult.stale`): re-issue silently via /refresh. */
export function ssoLoginUrl(returnUrl: string, env: Pick<SsoEnv, "SSO_AUTH_ORIGIN" | "SSO_RETURN_ORIGINS">, refresh = false, allowedOrigins?: string[]): string {
  if (!env.SSO_AUTH_ORIGIN) throw new Error("SSO_AUTH_ORIGIN not configured");
  // open-redirect guard, secure by default: the return URL must be a same-site relative path, or an absolute URL on the allow-list (4th arg or SSO_RETURN_ORIGINS="https://a.example,https://b.example"); no list = relative paths only
  const allow = allowedOrigins ?? (env.SSO_RETURN_ORIGINS ? env.SSO_RETURN_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : []);
  if (safeRedirectUrl(returnUrl, { allowedOrigins: allow, fallback: "" }) === "") throw new Error("ssoLoginUrl: returnUrl is not a relative path or an allowed origin (set SSO_RETURN_ORIGINS to allow absolute return URLs)");
  return `${env.SSO_AUTH_ORIGIN.replace(/\/+$/, "")}/${refresh ? "refresh" : "login"}?return=${encodeURIComponent(returnUrl)}`;
}

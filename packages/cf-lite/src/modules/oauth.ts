/**
 * OPTIONAL module. OAuth 2.0 authorization-code + PKCE (S256) and OIDC login on `fetch` + WebCrypto. No deps.
 * Presets: `github`, `google`, `oidc(issuerUrl)` (discovery). Register the OAuth app yourself (client id/secret = Worker secrets).
 *
 *   const gh = github({ clientId: env.GH_ID, clientSecret: env.GH_SECRET, redirectUri: "https://app.example/auth/callback" });
 *   // GET /auth/login
 *   const { url, cookie } = await startLogin(gh, { secrets: env.SESSION_SECRETS, returnTo: "/dashboard" });
 *   return new Response(null, { status: 302, headers: { location: url, "set-cookie": cookie } });
 *   // GET /auth/callback
 *   const r = await finishLogin(gh, req, { secrets: env.SESSION_SECRETS });   // verifies state + PKCE + (OIDC) id_token
 *   await getSession(c).login(userId)                                         // you map r.profile -> user (see d1Accounts)
 *
 * The transient state (state, PKCE verifier, nonce, returnTo) travels in a short-lived sealed `__Host-oauth` cookie, so
 * no server-side storage is needed. id_token signatures: RS256/ES256 only (alg pinned, `none`/HS* rejected), iss/aud/exp/nonce checked.
 */
import { safeReturnTo } from "./safe-redirect.js";
import { b64u, randomId, readCookie, safeEqual, sealData, unb64u, unsealData } from "./session.js";

export interface OAuthProvider {
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
  /** OIDC: enables id_token validation. */
  issuer?: string;
  jwksUri?: string;
  scopes: string[];
  /** How the client authenticates at the token endpoint. Default "post". */
  clientAuth?: "post" | "basic";
  extraAuthParams?: Record<string, string>;
  /** Map the raw userinfo/id_token claims to a profile. */
  profile(raw: Record<string, unknown>): OAuthProfile;
}
export interface OAuthClient { provider: OAuthProvider; clientId: string; clientSecret: string; redirectUri: string; scopes?: string[]; fetch?: typeof fetch }
export interface OAuthProfile { id: string; email?: string; emailVerified?: boolean; name?: string; picture?: string; raw: Record<string, unknown> }
export interface OAuthTokens { access_token: string; token_type?: string; id_token?: string; refresh_token?: string; expires_in?: number; scope?: string }

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

type Creds = { clientId: string; clientSecret: string; redirectUri: string; scopes?: string[]; fetch?: typeof fetch };
export const github = (c: Creds): OAuthClient => ({
  ...c, provider: {
    name: "github", authorizeUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user", scopes: ["read:user", "user:email"],
    // GitHub's /user email is whatever the user made public; verified status needs /user/emails (see githubPrimaryEmail).
    profile: (r) => ({ id: String(r.id), email: str(r.email), emailVerified: false, name: str(r.name) ?? str(r.login), picture: str(r.avatar_url), raw: r }),
  },
});
/** GitHub: fetch the user's primary *verified* email (needs scope user:email). Use it to set emailVerified yourself. */
export async function githubPrimaryEmail(accessToken: string, f: typeof fetch = fetch): Promise<string | undefined> {
  const r = await f("https://api.github.com/user/emails", { headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "cf-lite" } });
  if (!r.ok) return undefined;
  const list = (await r.json()) as { email: string; primary: boolean; verified: boolean }[];
  return list.find((e) => e.primary && e.verified)?.email;
}
const oidcProfile = (r: Record<string, unknown>): OAuthProfile => ({ id: String(r.sub), email: str(r.email), emailVerified: r.email_verified === true, name: str(r.name), picture: str(r.picture), raw: r });
export const google = (c: Creds): OAuthClient => ({
  ...c, provider: {
    name: "google", authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo", issuer: "https://accounts.google.com", jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
    scopes: ["openid", "email", "profile"], profile: oidcProfile,
  },
});
/** Generic OIDC via discovery (`<issuer>/.well-known/openid-configuration`). The discovered `issuer` must equal the URL you passed. */
export async function oidc(issuerUrl: string, c: Creds & { name?: string }): Promise<OAuthClient> {
  const f = c.fetch ?? fetch;
  const res = await f(issuerUrl.replace(/\/+$/, "") + "/.well-known/openid-configuration");
  if (!res.ok) throw new Error(`oidc discovery failed: ${res.status}`);
  const d = (await res.json()) as Record<string, string>;
  if (d.issuer !== issuerUrl.replace(/\/+$/, "") && d.issuer !== issuerUrl) throw new Error("oidc discovery: issuer mismatch");
  return { ...c, provider: { name: c.name ?? "oidc", authorizeUrl: d.authorization_endpoint, tokenUrl: d.token_endpoint, userinfoUrl: d.userinfo_endpoint, issuer: d.issuer, jwksUri: d.jwks_uri, scopes: ["openid", "email", "profile"], profile: oidcProfile } };
}

// ---------------------------------------------------------------- redirect safety
export { safeReturnTo };

// ---------------------------------------------------------------- PKCE + start
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomId(32);
  return { verifier, challenge: b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))) };
}
const stateCookieName = (p: string, secure: boolean) => (secure ? "__Host-" : "") + `oauth-${p}`;
interface Txn { s: string; v: string; n: string; r: string; p: string; e: number }
const TXN_TTL = 600;

export interface StartOptions { secrets: string | string[]; returnTo?: string; secure?: boolean; now?: () => number; extraParams?: Record<string, string> }
/** Build the provider redirect URL and the `Set-Cookie` value carrying the sealed transaction. */
export async function startLogin(cl: OAuthClient, o: StartOptions): Promise<{ url: string; cookie: string }> {
  const secure = o.secure ?? cl.redirectUri.startsWith("https:");
  const now = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
  const { verifier, challenge } = await pkce();
  const txn: Txn = { s: randomId(24), v: verifier, n: randomId(24), r: safeReturnTo(o.returnTo), p: cl.provider.name, e: now + TXN_TTL };
  const u = new URL(cl.provider.authorizeUrl);
  const scopes = cl.scopes ?? cl.provider.scopes;
  const q: Record<string, string> = { response_type: "code", client_id: cl.clientId, redirect_uri: cl.redirectUri, scope: scopes.join(" "), state: txn.s, code_challenge: challenge, code_challenge_method: "S256", ...cl.provider.extraAuthParams, ...o.extraParams };
  if (cl.provider.issuer && scopes.includes("openid")) q.nonce = txn.n;
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const name = stateCookieName(cl.provider.name, secure);
  const sealed = await sealData(txn, o.secrets, name);
  return { url: u.toString(), cookie: `${name}=${sealed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TXN_TTL}${secure ? "; Secure" : ""}` };
}

// ---------------------------------------------------------------- id_token
const ALGS: Record<string, { imp: RsaHashedImportParams | EcKeyImportParams; ver: AlgorithmIdentifier | EcdsaParams }> = {
  RS256: { imp: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, ver: { name: "RSASSA-PKCS1-v1_5" } },
  ES256: { imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" } },
};
/** Verify an OIDC id_token against the provider JWKS. Returns the claims or throws. */
export async function verifyIdToken(token: string, cl: OAuthClient, nonce: string, now = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
  const { provider } = cl;
  if (!provider.issuer || !provider.jwksUri) throw new Error("provider is not OIDC");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("id_token: malformed");
  const json = (s: string) => JSON.parse(new TextDecoder().decode(unb64u(s)));
  const h = json(parts[0]), c = json(parts[1]) as Record<string, unknown>;
  const alg = ALGS[h.alg as string];
  if (!alg || !Object.prototype.hasOwnProperty.call(ALGS, h.alg)) throw new Error("id_token: unsupported alg");
  const jwks = (await (await (cl.fetch ?? fetch)(provider.jwksUri)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const cands = jwks.keys.filter((k) => (h.kid ? k.kid === h.kid : true) && (h.alg === "RS256" ? k.kty === "RSA" : k.kty === "EC" && k.crv === "P-256"));
  if (!cands.length) throw new Error("id_token: no matching key");
  let ok = false;
  for (const jwk of cands) {
    const key = await crypto.subtle.importKey("jwk", jwk, alg.imp, false, ["verify"]);
    if (await crypto.subtle.verify(alg.ver, key, unb64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]))) { ok = true; break; }
  }
  if (!ok) throw new Error("id_token: bad signature");
  if (c.iss !== provider.issuer) throw new Error("id_token: wrong issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cl.clientId) || (aud.length > 1 && c.azp !== cl.clientId)) throw new Error("id_token: wrong audience");
  if (typeof c.exp !== "number" || c.exp <= now - 30) throw new Error("id_token: expired");
  if (typeof c.iat === "number" && c.iat > now + 60) throw new Error("id_token: iat in future");
  if (typeof c.nonce !== "string" || !safeEqual(c.nonce, nonce)) throw new Error("id_token: nonce mismatch");
  if (typeof c.sub !== "string" || !c.sub) throw new Error("id_token: no sub");
  return c;
}

// ---------------------------------------------------------------- finish
export class OAuthError extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }
export interface FinishOptions { secrets: string | string[]; secure?: boolean; now?: () => number }
export interface FinishResult { profile: OAuthProfile; tokens: OAuthTokens; returnTo: string; /** Set-Cookie value that clears the transaction cookie. */ clearCookie: string }

export async function finishLogin(cl: OAuthClient, req: Request, o: FinishOptions): Promise<FinishResult> {
  const f = cl.fetch ?? fetch;
  const url = new URL(req.url);
  const secure = o.secure ?? cl.redirectUri.startsWith("https:");
  const name = stateCookieName(cl.provider.name, secure);
  const clearCookie = `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
  const now = (o.now ?? (() => Math.floor(Date.now() / 1000)))();
  const err = url.searchParams.get("error");
  if (err) throw new OAuthError("provider_error", `provider returned ${err.slice(0, 64)}`);
  const txn = await unsealData<Txn>(readCookie(req, name), o.secrets, name);
  if (!txn || txn.p !== cl.provider.name || txn.e <= now) throw new OAuthError("bad_transaction", "missing or expired login transaction");
  const state = url.searchParams.get("state"), code = url.searchParams.get("code");
  if (!state || !safeEqual(state, txn.s)) throw new OAuthError("bad_state");
  if (!code) throw new OAuthError("no_code");

  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: cl.redirectUri, code_verifier: txn.v });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "cf-lite" };
  if (cl.provider.clientAuth === "basic") headers.authorization = "Basic " + btoa(`${encodeURIComponent(cl.clientId)}:${encodeURIComponent(cl.clientSecret)}`);
  else { body.set("client_id", cl.clientId); body.set("client_secret", cl.clientSecret); }
  const tr = await f(cl.provider.tokenUrl, { method: "POST", headers, body });
  const tokens = (await tr.json().catch(() => ({}))) as OAuthTokens & { error?: string };
  if (!tr.ok || tokens.error || typeof tokens.access_token !== "string") throw new OAuthError("token_exchange_failed", tokens.error ? `token endpoint: ${String(tokens.error).slice(0, 64)}` : `token endpoint ${tr.status}`);

  let raw: Record<string, unknown> | undefined;
  if (cl.provider.issuer && tokens.id_token) {
    try { raw = await verifyIdToken(tokens.id_token, cl, txn.n, now); } catch (e) { throw new OAuthError("bad_id_token", (e as Error).message); }
  } else if (cl.provider.issuer && !tokens.id_token && (cl.scopes ?? cl.provider.scopes).includes("openid")) {
    throw new OAuthError("bad_id_token", "provider returned no id_token");
  }
  if (!raw) {
    if (!cl.provider.userinfoUrl) throw new OAuthError("no_profile");
    const ur = await f(cl.provider.userinfoUrl, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json", "user-agent": "cf-lite" } });
    if (!ur.ok) throw new OAuthError("userinfo_failed", `userinfo ${ur.status}`);
    raw = (await ur.json()) as Record<string, unknown>;
  }
  const profile = cl.provider.profile(raw);
  if (!profile.id || profile.id === "undefined") throw new OAuthError("no_profile", "provider returned no stable id");
  return { profile, tokens, returnTo: safeReturnTo(txn.r), clearCookie };
}

// ---------------------------------------------------------------- account linking (D1)
/** D1 DDL: see `templates/auth/migrations/0001_auth.sql` (users + accounts). */
export interface AccountStore { findOrCreate(provider: string, p: OAuthProfile, opts?: { linkByVerifiedEmail?: boolean }): Promise<{ userId: string; created: boolean }> }
/**
 * Maps (provider, provider account id) -> local user. Never links by email unless `linkByVerifiedEmail` AND the provider
 * asserts `emailVerified` (otherwise an attacker could take over an account by registering its email at a lax IdP).
 */
export function d1Accounts(db: D1Database): AccountStore {
  return {
    async findOrCreate(provider, p, opts = {}) {
      const acc = await db.prepare("SELECT user_id FROM accounts WHERE provider = ?1 AND provider_account_id = ?2").bind(provider, p.id).first<{ user_id: string }>();
      if (acc) return { userId: acc.user_id, created: false };
      let userId: string | undefined, created = false;
      if (opts.linkByVerifiedEmail && p.email && p.emailVerified) {
        userId = (await db.prepare("SELECT id FROM users WHERE email = ?1 COLLATE NOCASE").bind(p.email).first<{ id: string }>())?.id;
      }
      if (!userId) {
        userId = crypto.randomUUID(); created = true;
        await db.prepare("INSERT INTO users (id, email, email_verified, name, image, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(userId, p.email ?? null, p.emailVerified ? 1 : 0, p.name ?? null, p.picture ?? null, Math.floor(Date.now() / 1000)).run();
      }
      await db.prepare("INSERT INTO accounts (provider, provider_account_id, user_id, created_at) VALUES (?1, ?2, ?3, ?4)").bind(provider, p.id, userId, Math.floor(Date.now() / 1000)).run();
      return { userId, created };
    },
  };
}

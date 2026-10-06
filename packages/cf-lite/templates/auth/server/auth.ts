// Added by `cf-lite add auth`. Shared auth config: edit freely, it's yours.
import { github, google, oidc, type OAuthClient } from "cf-lite/modules/oauth";
import { d1Store, type SessionOptions } from "cf-lite/modules/session";

export interface AuthEnv {
  /** Comma-separated secrets, >= 32 chars each (first seals, rest = old keys). `wrangler secret put SESSION_SECRETS`; dev: .dev.vars */
  SESSION_SECRETS?: string;
  AUTH_DB?: D1Database;
  /** "github" (default) | "google" | "oidc" */
  AUTH_PROVIDER?: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  /** Public origin used to build the redirect URI, e.g. https://app.example.com (defaults to the request origin). */
  AUTH_ORIGIN?: string;
  /** Only for AUTH_PROVIDER=oidc */
  OIDC_ISSUER?: string;
  /** Turnstile (add-auth default): widget site key + secret (`wrangler secret put TURNSTILE_SECRET`). Dev: Cloudflare's always-pass test keys. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Local e2e only: siteverify endpoint override. Unset in production. */
  TURNSTILE_VERIFY_URL?: string;
  /** Test deployments only; see cf-lite/modules/e2e-login. */
  E2E_LOGIN_SECRET?: string;
}

/**
 * Sessions: D1-backed by default (migrations/0001_auth.sql already creates `sessions`): logout and `revokeUser()` really
 * revoke. A sealed-cookie session cannot be revoked server-side (a stolen copy survives logout until it expires), so use
 * it only for apps that accept that: drop the `store` line.
 */
export const sessionOptions = (env: AuthEnv): SessionOptions => ({
  store: d1Store(env.AUTH_DB!),
  ttl: 7 * 86400,
});
export { d1Store };

export async function oauthClient(env: AuthEnv, origin: string): Promise<OAuthClient> {
  const c = { clientId: env.OAUTH_CLIENT_ID ?? "", clientSecret: env.OAUTH_CLIENT_SECRET ?? "", redirectUri: `${env.AUTH_ORIGIN ?? origin}/api/auth/callback` };
  if (!c.clientId || !c.clientSecret) throw new Error("OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET not configured");
  switch (env.AUTH_PROVIDER ?? "github") {
    case "google": return google(c);
    case "oidc": if (!env.OIDC_ISSUER) throw new Error("OIDC_ISSUER not configured"); return oidc(env.OIDC_ISSUER, c);
    default: return github(c);
  }
}

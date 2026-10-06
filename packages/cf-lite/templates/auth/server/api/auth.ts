// Added by `cf-lite add auth`. Mounted at /api/auth/*:  GET|POST login, GET callback, POST logout, GET me.
// Rate limiting + Turnstile are on by default; re-scaffold with `--no-ratelimit` / `--no-turnstile` to leave them out.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { d1Accounts, finishLogin, OAuthError, safeReturnTo, startLogin } from "cf-lite/modules/oauth";
import { csrf, getSession, session } from "cf-lite/modules/session";
import { e2eSessionIssuer } from "cf-lite/modules/session";
import { e2eLogin } from "cf-lite/modules/e2e-login";
// @cfl:ratelimit
import { rateLimit } from "cf-lite/modules/ratelimit";
// @cfl:end
// @cfl:turnstile
import { turnstile, turnstileWidget } from "cf-lite/modules/turnstile";
// @cfl:end
import { oauthClient, sessionOptions, type AuthEnv } from "../auth";

// @cfl:ratelimit
// Per client IP. Uses the Workers `ratelimit` binding RATE_LIMITER when you add one (wrangler `ratelimits`), else a per-isolate
// memory limiter (dampens abuse, not exact). For exact/global limits swap in doLimiter(env.LIMITER_DO, ...) (docs/auth.md).
// failOpen:false = if the limiter itself breaks, auth routes refuse rather than run unprotected.
const loginLimit = rateLimit({ binding: "RATE_LIMITER", scope: "auth-login", limit: 10, period: 60, failOpen: false });
const callbackLimit = rateLimit({ binding: "RATE_LIMITER", scope: "auth-callback", limit: 20, period: 60, failOpen: false });
const logoutLimit = rateLimit({ binding: "RATE_LIMITER", scope: "auth-logout", limit: 30, period: 60, failOpen: false });
// @cfl:no-ratelimit
const loginLimit: MiddlewareHandler = (_c, next) => next();
const callbackLimit = loginLimit, logoutLimit = loginLimit;
// @cfl:end

// @cfl:turnstile
// TURNSTILE_VERIFY_URL is for local e2e only (points siteverify at a mock); leave it unset in production.
const verifyHuman: MiddlewareHandler = (c, next) => turnstile({ expectedAction: "login", endpoint: (c.env as AuthEnv).TURNSTILE_VERIFY_URL })(c as never, next);
// @cfl:end

const startOAuth = async (c: Context<any>, returnTo: string | undefined) => {
  const cl = await oauthClient(c.env, new URL(c.req.url).origin);
  const { url, cookie } = await startLogin(cl, { secrets: c.env.SESSION_SECRETS ?? "", returnTo: safeReturnTo(returnTo) });
  return new Response(null, { status: 302, headers: { location: url, "set-cookie": cookie, "cache-control": "no-store" } });
};

export default new Hono<{ Bindings: Env & AuthEnv }>()
  .use("*", session((c) => sessionOptions(c.env)))
  .get("/me", (c) => { const s = getSession(c); return c.json({ user: s.userId ?? null, csrf: s.csrfToken() }, 200, { "cache-control": "private, no-store" }); })
  // @cfl:turnstile
  // Login starts from a form POST that carries a Turnstile token (verified server-side, fails closed: 503 without TURNSTILE_SECRET).
  // The GET page is the form + widget; link to /api/auth/login?returnTo=/x from your own UI.
  .get("/login", loginLimit, (c) => {
    if (!c.env.TURNSTILE_SITE_KEY) return c.text("TURNSTILE_SITE_KEY not configured", 503);
    const rt = safeReturnTo(c.req.query("returnTo"));
    const esc = (s: string) => s.replace(/[&<>"']/g, (m) => `&#${m.charCodeAt(0)};`);
    return c.html(`<!doctype html><meta charset="utf-8"><title>Sign in</title><main><h1>Sign in</h1><form method="post" action="/api/auth/login"><input type="hidden" name="returnTo" value="${esc(rt)}">${turnstileWidget(c.env.TURNSTILE_SITE_KEY, { action: "login" })}<button type="submit">Continue</button></form></main>`, 200, { "cache-control": "private, no-store" });
  })
  .post("/login", loginLimit, csrf(), verifyHuman, async (c) => startOAuth(c, String((await c.req.formData()).get("returnTo") ?? "")))
  // @cfl:no-turnstile
  .get("/login", loginLimit, (c) => startOAuth(c, c.req.query("returnTo")))
  // @cfl:end
  .get("/callback", callbackLimit, async (c) => {
    const cl = await oauthClient(c.env, new URL(c.req.url).origin);
    try {
      const r = await finishLogin(cl, c.req.raw, { secrets: c.env.SESSION_SECRETS ?? "" });
      if (!c.env.AUTH_DB) throw new Error("AUTH_DB binding missing (apply migrations/0001_auth.sql)");
      const { userId } = await d1Accounts(c.env.AUTH_DB).findOrCreate(cl.provider.name, r.profile);
      await getSession(c).login(userId); // rotates the session id (fixation-safe)
      c.header("set-cookie", r.clearCookie, { append: true });
      return c.redirect(r.returnTo, 302);
    } catch (e) {
      if (e instanceof OAuthError) return c.json({ error: e.code }, 400); // never echo provider text
      throw e;
    }
  })
  .post("/logout", logoutLimit, csrf(), async (c) => { await getSession(c).destroy(); return c.json({ ok: true }); })
  // Test-login bypass: a 404 unless the E2E_LOGIN_SECRET secret is set (never set it in production).
  .route("/__e2e", e2eLogin({ issue: e2eSessionIssuer() }));

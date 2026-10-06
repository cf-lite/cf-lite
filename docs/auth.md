# Auth: sessions, OAuth/OIDC, Turnstile

Opt-in modules (import nothing = 0 bytes in your Worker): `cf-lite/modules/session`, `cf-lite/modules/oauth`, `cf-lite/modules/turnstile`.
Quick start: `cf-lite add auth` (copies `server/auth.ts`, `server/api/auth.ts`, `migrations/0001_auth.sql`, `.dev.vars.example`, adds the `AUTH_DB` D1 binding).
`cf-lite/modules/sso` (verify-only org SSO cookie) is unchanged: SSO is *identity from elsewhere*, `session` is *our own* login state. They can coexist
(use `readSso` for the org gate, `session` for app state); do not treat one as the other.

### Scaffold defaults: rate limit + Turnstile

`cf-lite add auth` wires both in (opt out with `--no-ratelimit` and/or `--no-turnstile`; flags apply when the files are first written, existing files are never overwritten):

* **Rate limit** (`modules/ratelimit`, per client IP, `failOpen: false`): `login` 10/min, `callback` 20/min, `logout` 30/min, answering `429` + `Retry-After`. It uses the Workers `ratelimit` binding `RATE_LIMITER` if you add one (wrangler `ratelimits`), otherwise a per-isolate memory limiter, which dampens abuse but is **not exact or global**; swap in `doLimiter(env.LIMITER_DO, ...)` for exact limits ([security.md](security.md)). Behind no `cf-connecting-ip` (off Cloudflare) the key falls back to a spoofable header or one shared bucket.
* **Turnstile on login**: `GET /api/auth/login` renders a form + widget; `POST /api/auth/login` (same-origin `csrf()` + verified `cf-turnstile-response`, `expectedAction: "login"`) starts the OAuth redirect. Fails closed (503 without `TURNSTILE_SECRET`). `.dev.vars.example` ships Cloudflare's always-pass test keys; production needs real keys (site key as a var, secret via `wrangler secret put`). Link to `/api/auth/login?returnTo=/x` from your UI as before. `TURNSTILE_VERIFY_URL` exists only so the e2e can point siteverify at a mock: leave it unset.
* Tests: `test/add-auth.test.ts` (flag matrix), `scripts/auth-e2e.mjs` (scaffold e2e: token missing/rejected/foreign origin refused, siteverify gets the configured secret, 429 + `Retry-After` on the login route).

## Sessions

```ts
app.use("*", session());                          // SESSION_SECRETS in env
const s = getSession(c);
await s.login("user-1", { role: "admin" });       // ROTATES id/cookie (fixation-safe)
s.set("cart", [...]); s.csrfToken(); await s.destroy();
```

| Store | Where state lives | Revoke | Use when |
|---|---|---|---|
| sealed (library default; **not** the `add auth` scaffold, which uses `d1Store`) | cookie, AES-256-GCM (<= ~3.8 KB) | only global via `validAfter` | simple apps, no binding needed |
| `kvStore(kv)` | KV, keyed by SHA-256(id) | `revokeUser` (index keys); other locations see it after KV propagation (~60 s, *verify*) | read-heavy |
| `d1Store(db)` | D1 `sessions` table | `revokeUser`, listable for admin UIs; `sweepSessions` from a cron | admin/listing, strong consistency on primary |
| `doStore(ns)` + `SessionDO` | one Durable Object per session | instant, strict; no by-user index | strictest consistency |

**Logout and sealed sessions:** a sealed cookie is stateless, so `destroy()` only expires the browser's copy; a stolen copy keeps working until `ttl`/`absoluteTtl` (sec10 review: [security-review-sec10.md](security-review-sec10.md)). If logout must contain a compromise you need a store; the `add auth` scaffold therefore ships `d1Store`.

Details: `SESSION_SECRETS` = comma-separated, each >= 32 chars; the **first seals, all unseal** -> rotate by prepending a new secret, drop the old one after
`ttl` (sliding refresh re-seals old cookies under the new key). Missing/short secrets throw (fail closed, 500). Cookie: `__Host-session` on https
(Secure, Path=/, no Domain) / `session` on http dev; `HttpOnly; SameSite=Lax`. Lifetimes: `ttl` (idle/sliding, 7 d), `absoluteTtl` (30 d), `updateAge` (300 s: no
Set-Cookie on every read). Sealed format `1.<kid>.<iv>.<ct>`: random 96-bit IV per seal, cookie name bound as AAD, versioned, no algorithm agility.

CSRF: `csrf()` middleware (Origin / `Sec-Fetch-Site` check on unsafe methods; a request with neither header is rejected) and `csrf({ requireToken: true })` with
`session.csrfToken()` (header `x-csrf-token` or form field `_csrf`). WP-ACTIONS will wire this into `actions`; until then mount it on your Hono routes.
Guards: `requireSession()`. Test login: `e2eLogin({ issue: e2eSessionIssuer() })` (404 unless `E2E_LOGIN_SECRET` is set; never set it in production).

## OAuth / OIDC (authorization code + PKCE S256)

```ts
const cl = github({ clientId, clientSecret, redirectUri });      // or google(...), await oidc("https://issuer", {...})
const { url, cookie } = await startLogin(cl, { secrets, returnTo: "/dash" });   // 302 to url, Set-Cookie: cookie
const r = await finishLogin(cl, req, { secrets });               // state + PKCE + (OIDC) id_token verified
const { userId } = await d1Accounts(db).findOrCreate(cl.provider.name, r.profile);
await getSession(c).login(userId);
```
State, verifier, nonce and `returnTo` ride in a 10-minute sealed `__Host-oauth-<provider>` cookie (no server storage). id_tokens: RS256/ES256 only, `alg` pinned
(none/HS* rejected), `iss`, `aud` (+`azp`), `exp`, `nonce` checked. `returnTo` is reduced to a same-site path by `safeReturnTo`. `OAuthError.code` is safe to show; provider text is never echoed.
`d1Accounts` never links accounts by email unless `linkByVerifiedEmail` **and** the IdP asserts `email_verified` (GitHub's `/user` email is unverified: use `githubPrimaryEmail`).
**Needs you:** registering the OAuth app with GitHub/Google (client id/secret as Worker secrets, redirect URI `<origin>/api/auth/callback`). cf-lite does not create accounts or credentials.

## Turnstile

`app.post("/signup", turnstile(), handler)`; `TURNSTILE_SECRET` secret, widget via `turnstileWidget(siteKey)`. **Fails closed**: missing secret (503), token, network error, non-JSON or `success !== true` all reject;
optional `expectedAction` / `expectedHostname`. Dev keys: `TURNSTILE_TEST` (always pass / always fail). Real keys come from the Cloudflare dashboard.

## Not in this release

Magic link / email OTP (depends on the current Cloudflare email-sending product and plan, *verify*), WebAuthn/passkeys (1.1), per-adapter Turnstile components (the HTML helper works in any adapter).
Tests: `packages/cf-lite/test/{session,oauth,turnstile,add-auth}.test.ts`, workerd e2e `scripts/auth-e2e.mjs` (scaffold -> `add auth` -> real OIDC flow against a local mock IdP).

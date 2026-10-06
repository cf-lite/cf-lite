# Security headers, CSP and rate limiting

Two opt-in pieces, both zero bytes unless imported/configured.

## Security headers + CSP (`security`)

```ts
// vite.config.ts
cfLite({ renderer: react(), security: { preset: "strict" } })

// server/middleware.ts  (SSR pages + /api: the paths that reach the Worker)
import { security } from "cf-lite/modules/csp";
export const config = { matcher: ["/ssr", "/api/:path*"] };   // optional; static pages are covered by _headers
export default security({ preset: "strict" });
```

How each kind of page is covered — **no `'unsafe-inline'` for scripts anywhere**:

| Page | Who serves it | Policy source |
|---|---|---|
| static / prerendered (assets layer, no Worker runs) | Workers static assets | `_headers` written at build: CSP with the `sha256-…` of every inline `<script>`/`<style>` found in the built HTML (hydration data script, etc.) plus the base headers |
| SSR (Worker-first) | `ssr()` | `security()` mints a 128-bit nonce per request, `ssr()` stamps it on the shell's inline scripts/styles (`c.get("cspNonce")`), the response gets `script-src 'self' 'nonce-…'` |
| API / other Worker responses | Worker | base headers only (no CSP on JSON) |

Static responses from the assets layer keep their hash policy; `security()` never overwrites a CSP that is already present.

Base headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geolocation/payment/usb off),
`Cross-Origin-Opener-Policy: same-origin`, optional `Strict-Transport-Security` (`hsts: true | { maxAge, includeSubDomains, preload }` — **off by default**, only enable once every subdomain is HTTPS; `preload` is a long-lived commitment, your call).

Options (`SecurityOptions`): `preset: "strict" | "relaxed"`, `csp` (per-directive override, `false` removes), `reportOnly` (roll out safely), `reportUri`, `styleAttr`, `hsts`, `headers`, `dev`.

* `strict` = same-origin only. `relaxed` also allows `https:` images/fonts/connect and inline `<style>` elements.
* `style-src-attr 'unsafe-inline'` is kept (React `style={{}}` attributes cannot carry a nonce and cannot run script); `styleAttr: false` forbids them too.
* In `vite dev` the middleware is skipped (Vite's HMR/preamble scripts are inline) unless `dev: true`; verify CSP on `vite preview`/built output.
* `head.script` entries and other build-time inline scripts are picked up automatically by the hash pass; scripts you add at runtime need a nonce (Worker) or an external file.
* Third-party origins: add them to the directive, e.g. `csp: { "script-src": ["'self'", "https://challenges.cloudflare.com"], "frame-src": ["https://challenges.cloudflare.com"] }` (Turnstile).
* Needs the owner / dashboard: WAF custom rules and Bot Fight Mode are the recommended outer layer; they are dashboard settings, not something cf-lite configures.

Tested: `test/security.test.ts` (policy building, hashing, nonce, middleware), `scripts/security-e2e.mjs` (workerd: static hash policy matches the real inline scripts, SSR nonce differs per request, API has no CSP), `e2e/security.spec.ts` (Chromium: no CSP violation on hydration/interaction, injected inline script is blocked).

## Rate limiting (`cf-lite/modules/ratelimit`)

```ts
import { rateLimit, doLimiter, rateLimited } from "cf-lite/modules/ratelimit";

app.use("/api/*", rateLimit({ binding: "RATE_LIMITER", key: "ip", period: 60 }));          // approximate, per location
app.post("/login", rateLimit({ limiter: (c) => doLimiter(c.env.LIMITER_DO, { limit: 5, period: 300 }), key: "ip", failOpen: false }), login);

export const actions = { send: rateLimited({ key: "ip", limit: 3, period: 60 }, async (form, c) => { … }) };
```

| Limiter | Consistency | Use for |
|---|---|---|
| `bindingLimiter(env.RATE_LIMITER)` (Workers `ratelimit` binding; limit/period in wrangler config, period 10 s or 60 s) | per-location, eventually consistent, **approximate** | general abuse dampening |
| `doLimiter(env.LIMITER_DO, { limit, period })` (`RateLimiterDO`, SQLite-backed, fixed window, alarm cleanup) | exact, global per key | login / OTP / password reset |
| `memoryLimiter` (per isolate) | per isolate | dev/tests and the fallback when no binding is configured |

* Over the limit: `429`, `Retry-After` (seconds), `Cache-Control: no-store`.
* Key: `"ip"` (`CF-Connecting-IP`), `"session"` (user id, falls back to IP), or a function. Counters are scoped by pathname unless you set `scope`.
* Limiter errors fail **open** by default (availability); use `failOpen: false` on auth paths.
* DO setup: `export { RateLimiterDO } from "cf-lite/modules/ratelimit"` from the Worker entry, `durable_objects.bindings` + a `new_sqlite_classes` migration (see `examples/site-security/wrangler.jsonc`).
* Rejected attempts count in the DO (a flood cannot reset its own window). The Workers binding requires the `ratelimit` binding in wrangler config (*verify* current GA status/period options on your account; the code falls back to memory if the binding is absent).

## Open-redirect guards (`cf-lite/modules/safe-redirect`)

Never pass a user-influenced URL (`?returnTo=`, `?next=`, a form field) straight to `redirect()` / `Response.redirect()`.

* `safeReturnTo(v, fallback = "/")`: same-site relative path only. Refuses `//host`, `/\host`, `\\host`, `javascript:`/`data:`, control characters (browsers strip tab/CR/LF from URLs, so `/<TAB>/evil.com` becomes `//evil.com`) and values over 2 KiB. The OAuth flow uses it for `returnTo` (also re-exported from `cf-lite/modules/oauth`).
* `safeRedirectUrl(v, { allowedOrigins, fallback })`: a relative path, or an absolute URL whose origin (exact scheme+host+port, no credentials) is in the allow-list.
* `ssoLoginUrl(returnUrl, env, refresh?, allowedOrigins?)`: secure by default - the return URL must be a same-site path (as `safeReturnTo`); an absolute URL is accepted only when its origin is in `allowedOrigins` or `SSO_RETURN_ORIGINS="https://a.example,https://b.example"`. Anything else (absolute with no list, `//host`, `/\host`, control characters) throws instead of being forwarded to the auth origin. **Behaviour change**: before, with no list configured, absolute URLs were forwarded as-is.
* Route-config redirects/rewrites (`_redirects` generator): destinations are validated at build time; a captured splat can never turn a path target into another origin (`//`, `/\`).

## Security review notes (runtime)

Executable corpus: `packages/cf-lite/test/sec-runtime.test.ts`; status per checklist item in [security-review.md](security-review.md).

* **CSRF** (`modules/csrf`): unsafe methods (POST/PUT/PATCH/DELETE) need same-origin fetch metadata or an exact `Origin`; `X-HTTP-Method-Override` and `_method` are never honoured; urlencoded/multipart only unless configured (415 otherwise).
* **SSO JWT** (`modules/sso`): `alg` must be exactly `EdDSA`, `typ` `JWT`, `kid` an own key of the configured set (no prototype keys); `iss` and `aud` are required and exact (missing config = 500, never "unchecked"); `exp` strict, `nbf`/`iat` tolerate 60 s; every segment must be strict base64url (no whitespace/padding/`+` `/` variants).
* **Image loader SSRF** (`modules/images`): host allow-list, https only, no credentials/port, redirects never followed; private/loopback/link-local/`.local`/`.internal`/`.localhost` names and every IPv4/IPv6 literal are refused even when listed; a trailing dot does not bypass (`localhost.`).
* **Shared cache** (`modules/cache`): the key is the normalised URL (host + port included) + only the headers listed in `vary`; `X-Forwarded-*`, `X-Original-URL`, `Forwarded` are neither trusted nor keyed. A response with `Vary: Cookie|Authorization|*`, `Set-Cookie`, `private` or `no-store` is never stored. Requests with an auth cookie/`Authorization`, a draft cookie or a fresh `__cfl_upd` neither read nor write the cache. **A custom session `cookieName` is not recognised as auth: list it in `cache.authCookies`.**

# Threat model — the request path

Status: first version, written with WP-SECURITY (2026-09-30). Reviewed by: pending (see `security-review.md`).

## Who can reach what

```
Internet ──► Cloudflare edge (WAF / Bot Fight / DDoS: dashboard, the owner's domain)
               │
               ▼
   Workers static assets layer  ── path matches a file and is NOT in run_worker_first ──► file served, NO Worker code runs
               │                                                                          (headers come from `_headers` only)
               ▼ (run_worker_first globs: /api/*, SSR routes, server/routes, middleware matchers)
            Worker (Hono app)
              ├─ middleware (security(), sessions, csrf, cache)
              ├─ API / SSR / actions
              └─ bindings: D1, KV, R2, DO, Queues, Workflows, Images, AI  (never reachable except through the Worker)
```

Consequences:
* **Anything in the assets layer is public and unauthenticated by construction.** Gated content must be Worker-first (the `gated` example) — a middleware matcher alone does not cover an asset path that is not Worker-first.
* Security headers for static pages exist only if written to `_headers` at build (the `security` option does this). Worker middleware cannot add headers to responses it never sees.
* Bindings have no network surface of their own; the Worker is the only authority.

## Assets and attackers

| Asset | Attacker | Main threats | Mitigation (where) |
|---|---|---|---|
| Session / user identity | remote web attacker | XSS token theft, CSRF, fixation, cookie tampering | sealed `__Host-` cookies (`modules/session`), CSP no-inline-script (`modules/csp`), same-origin-only action POSTs (`modules/csrf`) |
| Action / API side effects | cross-site page, script kiddie | CSRF, content-type confusion, brute force, flooding | `csrf()` (`Sec-Fetch-Site` + `Origin`, form content types), `rateLimit()` / `doLimiter()` |
| Rendered pages | injected content | stored/reflected XSS, head/JSON-LD injection | escaped head injection, `<` escaped in data scripts, CSP hashes/nonces |
| Edge cache | unauthenticated client | cache poisoning / deception | key normalization, private responses never stored, draft/auth bypass (`modules/cache`) |
| Origin allow-lists | attacker-controlled URL | SSRF, open redirect | `hostAllowed` for images, `safeReturnTo` |
| Secrets | insider / log reader | leak via logs/errors | no env values logged, secrets only via wrangler secrets / `.dev.vars` (gitignored) |
| Availability | flood | per-request CPU burn | rate limiting (approximate per-colo + exact DO), edge WAF rules (dashboard) |

## Out of scope / residual

* DDoS and bot management beyond the Worker: Cloudflare dashboard features (document, do not automate).
* CSP `style-src-attr 'unsafe-inline'`: style attributes can exfiltrate via CSS only in narrow cases and cannot execute script; removable with `styleAttr: false`.
* Nonce CSP on SSR depends on the page not being edge-cached with the nonce baked in: a cached SSR response would replay a stale nonce (`modules/cache` / ISR now **bypass** when a per-request nonce is present — `x-cf-lite-cache-why: csp-nonce`, added in the RC audit, see `rc-status.md`; nonce-stripping so such pages become cacheable is a post-1.0 option).

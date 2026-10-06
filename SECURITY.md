# Security policy

cf-lite is build-time tooling (a Vite plugin, a CLI and a few optional Worker helper modules such as `cf-lite/modules/sso`
and `cf-lite/modules/e2e-login`). It has no runtime service of its own.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately by e-mail to **dngtiennguyen600@gmail.com**.
When the repository goes public, GitHub private vulnerability reporting
(["Report a vulnerability"](../../security/advisories/new)) will be enabled and is then the preferred channel; the e-mail address stays valid.

Include:

* the affected package and version (`cf-lite`, `@cf-lite/*`, `create-cf-lite`) and, if relevant, the Worker runtime and bundler;
* a minimal reproduction (a repository, a snippet or exact commands), using synthetic data only: no real credentials, no customer data;
* the impact you see and how you reached it (what an attacker needs, what they gain);
* whether and when you plan to disclose, so a fix can be coordinated with you.

Response targets (a maintainer working in good faith, not a promise or an SLA): acknowledgement within 5 working days, a first assessment
(confirmed, not reproducible, out of scope) within 14 days, and for confirmed issues a fix or mitigation in a patch release with a
CHANGELOG entry, aiming for within 90 days. We credit reporters who want credit.

## Supported versions

Pre-1.0: only the latest published `0.x` release (the current `latest` on npm, see [docs/published.md](docs/published.md)) receives fixes.

## Scope notes

* `cf-lite/modules/e2e-login` is a **test-only** login bypass. It is inert (plain 404) unless the Worker secret
  `E2E_LOGIN_SECRET` is set; only set that secret on preview/test deployments. The secret is compared in constant time.
* `cf-lite/modules/sso` is an **optional, verify-only** module: it checks an Ed25519 (EdDSA) JWT cookie against the public keys
  (JWKS or kid map) and the issuer/audience you configure through env (`SSO_PUBLIC_KEYS`, `SSO_ISSUER`, `SSO_AUDIENCE`, ...).
  Nothing is hard-coded and it never issues tokens; a missing issuer or key set fails closed. See `docs/field-notes.md`.
* Never commit `.dev.vars` or API tokens (this repo's `.gitignore` excludes `.dev.vars`; keep yours likewise).

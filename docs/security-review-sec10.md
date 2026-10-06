# sec10 review: auth / CSRF / session / SSO (pre-1.0 gate)

Date 2026-10-03. Reviewer: GPT, cross-vendor, independent of the Claude-written code; triage and fixes by the author side.
Scope: `src/modules/{session,csrf,sso,safe-redirect,oauth,e2e-login}.ts`, `templates/auth/**` (route, config, migration), `src/add-auth.ts`, `docs/auth.md`, including the PR #59 `ssoLoginUrl` open-redirect fix.

## Findings

| # | Sev | Where | Finding | Verdict | Resolution |
|---|---|---|---|---|---|
| 1 | Medium | `templates/auth/server/auth.ts` (sessionOptions), `session.ts` commit/destroy | The `add auth` scaffold defaulted to sealed-cookie sessions: `POST /logout` only expires the browser's copy, a stolen cookie keeps working until `ttl`/`absoluteTtl` (7 d idle / 30 d). | **Real** (confirmed: new test `sealed sessions are NOT revocable`; the library behaviour is documented, the scaffold default was the problem) | Scaffold now ships `store: d1Store(env.AUTH_DB!)` (`sessions` table already in `0001_auth.sql`, `AUTH_DB` always added by `add auth`). Tests: `add-auth.test.ts` (scaffold uses d1Store), `session.test.ts` (sealed non-revocable vs store revocable, existing). `scripts/auth-e2e.mjs` passes on the D1 store. `docs/auth.md` explains the trade-off. |

Areas the reviewer examined and found sound: CSRF (Origin / Sec-Fetch-Site, missing both = reject), session fixation (login rotates), `__Host-` cookies and duplicate-cookie parsing, `safeReturnTo` / `safeRedirectUrl` / `ssoLoginUrl` (#59: `//host`, `/\host`, control chars, credentials, non-http(s), non-allow-listed origins all refused), OAuth state/PKCE S256/nonce/iss/aud/azp/exp/alg pinning, account linking (provider subject, email linking only when verified), EdDSA SSO JWT checks, constant-time compares, `/__e2e/login` inert without `E2E_LOGIN_SECRET`.

## Author-side observations (not reported by the reviewer; accepted, not fixed)

| Obs | Verdict | Why |
|---|---|---|
| Stateful store `put` on a sliding refresh can re-create a record revoked mid-request (load -> `revokeUser` -> commit). | Low, accepted | Window is one request per `updateAge` (300 s); the next request after the race still needs the cookie; a strict fix needs update-only upserts per store. Use `doStore` for strict consistency. |
| `e2eLogin` has no minimum secret length; any `user` string can be issued. | Accepted | Operator-chosen secret on test deployments only (documented, 404 without it); a length floor would break the existing demo config. |
| OIDC discovery endpoints are not required to be `https:`; JWKS is fetched on every id_token. | Low, accepted | Issuer URL is operator config, not user input; the JWKS fetch only happens on a login callback behind the rate limiter. |
| `ssoLoginUrl` checks the normalised URL but encodes the raw `returnUrl`. | Accepted | Raw strings with control chars/credentials/backslashes are already refused, so the raw and normalised forms resolve to the same origin. |

Verdict: no remaining blocker for the sec10 gate.

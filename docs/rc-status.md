# Release-candidate status (production-readiness audit of `main`)

> **History plus plan, not a current status.** This page is the 1.0-candidate gate audit of 2026-09-30 with 2026-10-01/02 updates. Where it disagrees with [DECISIONS.md](DECISIONS.md), the decision wins: the train is 0.4.x with no rc naming ([D-001](DECISIONS.md#d-001-release-train-is-04x-no-10-yet)), no soak date is fixed ([D-002](DECISIONS.md#d-002-no-10-is-scheduled-the-pre-10-soak-review-date-is-not-fixed)), cf-lite is open source (MIT) ([D-005](DECISIONS.md#d-005-cf-lite-is-described-as-open-source-mit-version-0x)) and seven packages are on npm at 0.4.0 ([published.md](published.md), [D-006](DECISIONS.md#d-006-seven-packages-are-published-to-npm-at-040-the-owner-authorises-every-publish-bump-and-tag)). Rows below that say "unpublished" describe the audit date. What is proven today is in the code, the tests and `bun run test`, not in this table.

Audit date 2026-09-30, base `0637b71`, branch `chore/rc-audit`. At audit time nothing was published: public-release items (npm publish, provenance, org 2FA, signed tags,
versioned public docs, LTS, SECURITY.md contact) were out of scope and listed as *n/a (unpublished)*. Gates are the checklist in
[roadmap-1.0.md §2](roadmap-1.0.md). Status: **green** = met and evidenced, **partial** = part met, **open** = not met, **n/a** = unpublished at audit time.

## 1. Gate table

| Gate | Status | Evidence | Gap |
|---|---|---|---|
| **2.1** public-API/semver policy written | green | `docs/stability.md` (tiers, breaking-change rule); `docs/upgrading.md` | policy only; not enforced by tooling |
| 2.1 support matrix tested | partial (decided 2026-10-02) | PR/push CI pins Node **24** (`.github/workflows/ci.yml`); weekly scheduled ubuntu job on Node **22** (cron, never on PR/push); **no macOS** (decision (b) below); Vite 8 / plugin 1.x / wrangler 4.144 exercised by the e2e runs below | Node 20 is not tested anywhere (the task brief listed 20/24 "as now", but CI has only 24); macOS deliberately untested |
| 2.1 compat-date policy | green | `cf-lite doctor` CFL004 (`docs/doctor.md`, `test/dx.test.ts`) | - |
| 2.1 changesets / provenance / signed tags / LTS | n/a (unpublished) | - | - |
| **2.2** Actions CSRF | green (fixed 1 bug) | `test/actions.test.ts` (`csrfVerdict` corpus), `scripts/actions-e2e.mjs`; §3 findings | body cap was bypassable (F1, fixed) |
| 2.2 Sessions (AES-GCM, rotation, `__Host-`, constant time) | partial | `src/modules/session.ts` reviewed: random 96-bit IV per seal, versioned format, AAD = cookie name, HKDF per secret, store keyed by SHA-256(id), login rotates, fixation-safe (client-chosen id ignored), `safeEqual` | judgment calls J1-J3; the owner's human pass pending |
| 2.2 SSO/JWT | partial | alg pinned to EdDSA, `kid` own-property lookup, iss checked, exp/iat(+60s) checked (`test/oauth.test.ts`) | `SSO_AUDIENCE` required + fail-closed (500 / doctor CFL013), `nbf` + `exp>iat` checked - J4 done 2026-10-01 |
| 2.2 Open redirect | partial | `test/oauth.test.ts` `safeReturnTo` corpus | `_redirects` generator user-target check not reviewed |
| 2.2 SSRF | partial | `test/images.test.ts` `hostAllowed` | OG/AI remote fetch allow-list not audited |
| 2.2 Cache poisoning / deception | green (fixed 2 bugs) | `test/cache.test.ts`, `test/isr.test.ts`, new cases F3/F4 | Host/`x-forwarded-*` trust: key uses `req.url` only (no header trust), no test asserting it |
| 2.2 XSS / CSP nonce | partial | `test/security.test.ts`, `scripts/security-e2e.mjs`, `e2e/security.spec.ts` | `dangerouslySetInnerHTML` audit of built-ins not done |
| 2.2 Middleware gating | green (fixed 1 bug) | `test/middleware.test.ts`, `scripts/middleware-e2e.mjs`; F2 | - |
| 2.2 Supply chain | partial | `npm audit --omit=dev`: 2 moderate (`fflate` 0.7.x, ZIP64 infinite loop, transitive, not reachable from request path); CI actions pinned by tag not SHA | pin Actions by SHA; decide on `fflate` |
| 2.2 Secrets / e2e-login inert | green | `test/session.test.ts` (inert without `E2E_LOGIN_SECRET`) | no-logging audit: grep of `console.*` in `src/modules` found no env value logging, not a proof |
| 2.2 Rate-limit/Turnstile on scaffolded auth | green (2026-10-02) | `cf-lite add auth` wires both by default, opt out `--no-ratelimit` / `--no-turnstile`; `packages/cf-lite/test/add-auth.test.ts` (flag matrix), `scripts/auth-e2e.mjs` scaffold e2e (Turnstile token missing / rejected / foreign origin refused, siteverify gets the configured secret, 429 + `Retry-After`); all three flag combinations typecheck (`tsc --noEmit` on a scaffold); [auth.md](auth.md) | default limiter is per-isolate memory (not exact) unless `RATE_LIMITER` / `doLimiter` is configured; J5 stays (IP key off Cloudflare); real Turnstile keys are the owner/dashboard |
| 2.2 Threat model + SECURITY.md dry run | partial | `docs/threat-model.md`; `SECURITY.md` | dry run not exercised |
| 2.2 Independent review | partial | see §3 - the GPT reviewer was unavailable, so the first cross-vendor pass used NVIDIA Nemotron + author-side line review | human pass by the owner on auth/CSRF/session; the GPT review was re-run later (pass 2) |
| **2.3** Worker size budgets enforced in CI | green | `bench/module-sizes.json` (base + 39 modules + 19 examples, gzip); `scripts/size-budget.mjs` CI step, fails at baseline*1.05+256 B; tree-shake test `packages/cf-lite/test/size-budget.test.ts` (unused module = 0 bytes); `docs/performance-budgets.md` | baselines are the current sizes, not absolute targets
| 2.3 CPU p50 / cold start / build time budgets | green locally (2026-10-02); live mode untested | `scripts/perf-budget.mjs` + `bench/budgets.json` (6 reference examples: build time, cold start, request p50, Worker gzip; baseline committed); `npm run perf:check`; red proof: a tightened budget exits 1; `packages/cf-lite/test/perf-budget.test.ts`; cron line in [performance-budgets.md](performance-budgets.md); deliberately **not** in GitHub CI | local p50 is a loopback round trip, not Worker CPU time; `--live [--cpu]` (temporary Workers, deleted with API-404 proof) is implemented but never run against a real account (needs the scratch account) |
| **2.4** guide page + example per capability | partial | 37 docs pages, 19 example apps under `examples/`, `docs/getting-started.md`, `migration-from-nextjs.md`, `recipes.md` | no TSDoc-generated API reference; no `docs/adr/`; no per-page "Cloudflare limits" audit |
| 2.4 docs CI | green | `npm run docs:check` (links/anchors) + `npm run docs:snippets` passed (`/tmp` logs in §4) | docs site not versioned (unpublished: n/a), no search |
| **2.5** upgrade guide | partial | `docs/upgrading.md` (0.2 -> 0.4 + unreleased) | no 0.x->1.0 codemod rehearsal CI job |
| **2.6** unit tests | partial | `npx vitest run --coverage`: 807 tests pass; coverage 85.25 % stmts / 80.07 % branches / 80.91 % funcs / 88.99 % lines (was 73.4 / 68.5 / 71.9 / 76.5), ratchet thresholds 85/80/80/88 in `vitest.config.ts` + CI; WP-COVERAGE tests listed in CHANGELOG | branches/functions still ~5 pts under 85; `cli.ts`, `prerender.ts`, `vite.ts`, `@cf-lite/testing`, `@cf-lite/playwright` covered only by e2e (`docs/performance-budgets.md`) |
| 2.6 workerd e2e | green | `npm run test:e2e` (20 scripts), results §4 | one environmental flake (§4) |
| 2.6 dev e2e / browser e2e | partial (2026-10-02) | `npm run test:dev`; `npm run test:browser` (chromium, CI); `npm run test:browser:all` (`PW_BROWSERS`): firefox 155 passes the whole suite (131 = 66 chromium + 65 firefox); axe gate on the docs site `e2e/docs-a11y.spec.ts` (light + dark, fixed 1 violation) | **webkit green (2026-10-02)**: `PW_BROWSERS=chromium,firefox,webkit` 196 tests, 196 pass after two fixes (`cms-head` was missing from `scripts/build-sites.mjs`; the images srcset test assumed DPR 1 and Desktop Safari is DPR 2); CI stays chromium-only by design |
| 2.6 matrix (Node x OS), Cloudflare-side nightly, fresh-clone deploy smoke | open | - | needs scratch CF account (owner) |
| **2.7** 3 apps x 30 days | open (apps chosen 2026-10-02) | [field-notes.md](field-notes.md) summarises 3 ports; soak apps: decision (a) below | needs production time (no review date: the owner decides, [D-002](DECISIONS.md#d-002-no-10-is-scheduled-the-pre-10-soak-review-date-is-not-fixed)) |
| **2.8** error pages | partial | `modules/error.ts`: 500 with digest, `application/problem+json` for API; `_error`/`_not-found` conventions (`conventions/pages.ts`) | built-in 404 is plain text (`server.ts:90`); no built-in themeable 403/429/503 pages |
| **2.9** accessibility | partial (2026-10-02) | router announcer + focus + scroll (`docs/a11y.md`), `@cf-lite/playwright` `a11y()` fixture; docs site axe-gated (light + dark); per-adapter test in `e2e/site.spec.ts` for react/preact/vue/svelte/solid (announcer, focus on `<main>`, scroll reset, link / keyboard / Back, axe after swap); found + fixed: announcer was `aria-live=assertive`, docs say polite | manual screen-reader pass OBSERVED-BY-HUMAN 2026-10-06 (no recording): owner reported the pass as OK; no per-step notes; reader and browser not recorded; repeat with notes before 1.0 |

## 1b. What still blocked the release-candidate gate (2026-10-02; the rc naming was dropped, D-001) and what the owner must provide

| Blocker | Why an agent cannot close it | Owner provides |
|---|---|---|
| **2.6** scratch Cloudflare account: Cloudflare-side nightly, fresh-clone deploy smoke, `perf-budget --live` first real run | needs real deploys; the no-credential rule forbids using a production account | a **scratch** CF account (not production) + an API token scoped to Workers (+ D1/KV/R2 if the smoke should cover them), delivered into the environment as `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`; say whether the nightly may run from a scheduled job on the maintainer's machine |
| ~~**2.6** webkit in the local browser matrix~~ | done 2026-10-02 (deps installed, suite green) | - |
| ~~**2.6** Node x OS matrix~~ | decided (b) below | - |
| **2.7** 3 apps x 30 days soak (no end date fixed, D-002) | wall-clock production time | apps chosen (decision (a) below); field-notes at the end |
| **2.2** human pass on auth / CSRF / session; re-run the GPT review | judgment calls J1-J9 are product decisions | read §3 and decide J1, J3, J5, J6, J9 |
| ~~**2.9** manual screen-reader pass~~ | done, OBSERVED-BY-HUMAN 2026-10-06 (no recording): owner reported the pass as OK; no per-step notes; reader and browser not recorded; repeat with notes before 1.0 | - |
| **2.9** manual keyboard pass, repeat screen-reader pass with notes | needs a human with NVDA / VoiceOver | 30 minutes on the docs site and one adapter app |

## 2. Independent review

**Pass 2 (2026-10-01, reviewer available again): cross-vendor review (author Claude, reviewer GPT), one call per module, files path-referenced, "concrete exploitable issues only".**

| Module | Files | Result |
|---|---|---|
| session + oauth/OIDC PKCE | `modules/session.ts`, `oauth.ts` | 1 claim, rejected (R1) |
| actions CSRF | `modules/csrf.ts`, `actions.ts` | NONE |
| middleware gate + `run_worker_first` | `conventions/middleware.ts`, `vite.ts`, `scan.ts` | 1 finding, **confirmed -> F5** |
| draft | `modules/draft.ts`, `conventions/draft.ts` | NONE |
| webhook | `modules/webhook.ts`, `webhook-optimizely.ts` | NONE |
| cache / ISR purge | `modules/cache.ts`, `isr.ts`, `kv-cache.ts` | NONE |
| headers/CSP + sso (main only) | `modules/csp.ts`, `headers-default.ts`, `vite-security.ts`, `sso.ts` | 1 claim = J4, not a new finding (R2) |

Rejected claims (reproduced against the code before rejecting):

* **R1** "a retained previous `SESSION_SECRETS` key can mint sessions with an `iat` after `validAfter`". True but not a vulnerability of the module: whoever holds a sealing key can forge anything sealed with it; that is key compromise, whose remedy is removing the key from `SESSION_SECRETS` (documented rotation flow), not a per-key cutoff. Retired keys exist only to unseal in-flight cookies. No code change; same family as J2/J3.
* **R2** "`aud` not enforced when `SSO_AUDIENCE` unset" (reviewer ran it, reproduces). Already tracked as **J4**: a deliberate, breaking product decision; the fail-closed change is in flight on `feat/sso-aud` and was out of scope (main only). Still open until that branch lands.

Earlier pass 1 (the GPT reviewer was unavailable): NVIDIA NIM `nemotron-3-super-120b-a12b` over three code groups plus author-side line review; it found F1 (verified independently); everything else it raised was checked and dismissed.

## 3. Findings

### Confirmed bugs (fixed here, tests first)

| # | Where | Bug | Fix + test |
|---|---|---|---|
| F1 | `modules/actions.ts` `handleAction` | `maxBodyBytes` only compared the `Content-Length` header: a chunked body (no header), a non-numeric header, or an understated header bypassed the cap and `req.formData()` buffered the whole body (memory DoS, bypasses the documented 413) | count bytes on the stream (`cappedFormData`), 413 past the cap; `test/actions.test.ts` "body cap also holds without a usable Content-Length" + within-cap chunked body still parses |
| F2 | `conventions/middleware.ts` generated guard | guard regexes were tested against raw `c.req.path`, but the SSR router (`match.ts`) drops empty segments and percent-decodes: `/admin/` (matcher `/admin`), `//admin`, `/%61dmin` reached the route **without** the middleware (auth gate bypass for literal/`:param` matchers) | guard now normalises the path (router-equivalent: drop empty segments, decode each, keep `%2F`) before matching; `test/middleware.test.ts` "gate path normalisation" |
| F3 | `modules/cache.ts`, `modules/isr.ts` | a route cached together with `security()` stored HTML with nonce N1; hits were served under a new policy with nonce N2, so every inline script/style was blocked (broken page, and a stale nonce replayed) - the "open item" in `security-review.md` | bypass (`x-cf-lite-cache-why: csp-nonce`) when `c.get("cspNonce")` is set; tests in `test/cache.test.ts`, `test/isr.test.ts` |
| F4 | `modules/cache.ts`, `modules/isr.ts` `authed()` | default auth-cookie list was only the SSO cookie: a page personalised through the session module (`session` / `__Host-session`) was cached at the edge and served to other visitors unless the app knew to add `authCookies` | `session` and `__Host-session` are always auth cookies; tests in both files; documented in `docs/caching.md`, `docs/isr.md` |

| F5 | `vite.ts` `staticNegations` | with a root catch-all page (`run_worker_first: ["/*"]`) the static-asset negations were computed ignoring the middleware gate: `public/admin/` produced `!/admin/*` (and a prerendered `/admin/report` produced `!/admin/report`), and Cloudflare gives a negation precedence over the gate's positive `/admin/*`, so `GET /admin/secret.txt` was served from assets **without the middleware** (auth bypass of gated static files) | negations overlapping any Worker-first glob from conventions (middleware matcher, `/__preview`) are dropped; `test/draft.test.ts` "static negations never expose gated paths" (failed before the fix) |

### Judgment calls (not changed)

* **J1** `session()` does `c.res.headers.append("set-cookie")` with no try/catch; `security()` rebuilds immutable responses, `session()` does not (a handler returning a raw `fetch()`/assets response would throw). Suggest the same fallback.
* **J2** Sealed-cookie sessions cannot be revoked individually (documented; `validAfter` is the tool). Fine for "sealed" mode, keep the docs loud.
* **J3** Cookie `kid` = first 8 base64url chars of SHA-256(secret): safe only while secrets are random (length >= 32 is enforced, entropy is not). Could use an HMAC-derived kid.
* **J4 (DONE 2026-10-01, see CHANGELOG)** was: `verifySsoToken` treats `SSO_AUDIENCE` as optional; roadmap §2.2 says required/fail-closed. Also no `nbf`, no `exp > iat` sanity check. Product decision (breaking for existing users).
* **J5** `ratelimit` keys on `cf-connecting-ip`, then `x-forwarded-for`, then the literal `"unknown"` (one shared bucket). On workers.dev/custom domains the first always exists; off-Cloudflare the fallbacks are spoofable/shared.
* **J6** `session.ts` ships its own `csrf()`/`checkOrigin()` alongside `modules/csrf.ts` with different precedence (Origin first vs Sec-Fetch-Site first). Both safe today; two implementations will drift.
* **J7** CSRF accepts `Sec-Fetch-Site: none` on unsafe methods (user-initiated navigation cannot be a cross-site POST, so OK), but relies on browsers: server-to-server callers need `allowMissingOrigin`.
* **J8** Cache tag purge propagation is bounded by KV `cacheTtl: 30` + 3 s memo (documented in `docs/caching.md`); `cachePurge` has no rate limit (token-gated).
* **J9** `security()` does not emit `X-Frame-Options` (CSP `frame-ancestors` only) and HSTS is opt-in.

## 4. Test runs

Host: a Linux VM, Node 24.20, workerd 1.20260815.1, wrangler 4.144.0. Every suite ran at least twice; "final" = on the code in this PR.

| Suite | Run 1 | Run 2 | Final |
|---|---|---|---|
| `docs:check` + `docs:snippets` + `typecheck` + `vitest run` | 654/654 pass (pre-audit base) | typecheck caught F2's untyped generated guard (`TS7006` in example apps) - fixed | 662/662 pass (46 files), typecheck 0 errors; 2026-10-01 re-audit (F5): 905/905 pass (67 files), typecheck 0 errors |
| `npm run test:e2e` (20 scripts) | 19/20 - `isr-route-e2e` failed `bind(): Address already in use`; passed on immediate re-run | 20/20 | 20/20 |
| `npm run test:dev` (vite dev e2e) | pass | - | pass |
| `npm run test:browser` (Playwright chromium) | - | - | 47/47, twice (35.6 s / 35.3 s); 2026-10-02 (docs axe + per-adapter announcer added): 66/66 chromium, 131/131 chromium + firefox (`PW_BROWSERS=chromium,firefox`, 1.9 min) |
| 2026-10-02 `rc1gaps`: `vitest run --coverage`, `typecheck`, `docs:check`, `docs:snippets`, `size-budget`, `test:e2e` (26 scripts), `test:dev`, `perf-budget` | - | - | 1026/1026 pass (77 files), typecheck 0 errors, docs ok, size ok, e2e exit 0, dev exit 0, perf ok |

Flakes:
* `isr-route-e2e` port collision on run 1 (workerd `Address already in use`): environmental (other processes share the host's local ports), not reproduced in 3 later runs. Worth making the script pick a free port.
* `security-e2e` fails if re-run within ~60 s of a previous run: the Durable Object limiter state (2 / 60 s per key) persists under `.wrangler`, so the next run starts over quota (`a #0 429 !== 200`). Test-state leak, not a product bug; passes after 60 s. A per-run key suffix would fix it.

Red-before-green evidence: F1/F3/F4 unit tests and the F2 unit + e2e case (`scripts/security-e2e.mjs`, `/ssr/`, `//ssr`, `/%73sr` keep the matcher guard) failed on `0637b71` code (F2 e2e verified by restoring the old `middleware.ts`) and pass now.

2026-10-01: RSC experimental (`render = "rsc"`) merged at 4d40323 (#38); not used by prod apps.

## 1c. Decisions recorded on 2026-10-02

**(a) 2.7 soak apps** (already deployed, real traffic; each runs the candidate build for 30 days; no end date is fixed, D-002):

1. A gated head app from a sibling product (shared-key gated: 401 without the key is the live signal).
2. The cf-lite docs site (`site/`) (public, 200).
3. The cf-lite demo example (`examples/demo`) (public, 200). Alternate if it needs swapping: a second gated demo head.

**(b) CI matrix:** no macOS (about 10x Actions minutes per run; Free plan = 2000 min/month). Node 24 stays on PR/push. Node 22 runs only as a weekly
scheduled ubuntu job (`schedule` cron in `.github/workflows/ci.yml`, never on PR/push). The docs-only skip and draft-PR skip are unchanged.

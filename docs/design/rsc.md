# ADR: opt-in React Server Components (`render = "rsc"`)

Status: **accepted, experimental** (the owner approved 2026-10-01). Phase P1 (this ADR + build foundation) landed on `feat/rsc`; later phases
implement the rest of the API below. Evidence base: the spike (`spike/rsc` branch, `docs/design/rsc-spike.md` there: feasibility,
measurements, risks). Decisions marked **[P1 decision]** were taken unattended and are the first thing to revisit if wrong.

## 1. Context and goals

cf-lite is a small Hono-on-Workers framework: static / SPA / SSR routes by file convention, UI adapters (`@cf-lite/react`, ...).
RSC adds async server components, Suspense streaming across the server/client boundary and zero client JS for server-only subtrees.

Goals: (1) per-route opt-in, (2) apps that do not use it stay **byte-identical** in output and size, (3) a security posture we can
defend (pinned, advisory-tracked, no Flight request decoding in v1), (4) follow the ecosystem (vinext) rather than fork it.
Non-goals: a Next.js App Router clone; being the first to support every RSC feature.

## 2. Public API (experimental)

```tsx
// app/routes/dashboard.tsx
import { Suspense } from "react";
import { Counter } from "../islands/counter";      // "use client" island

export const render = "rsc";                        // the opt-in. Detected statically (scan.ts), like "ssr".
export const head = { title: "Dashboard" };         // same `head` export as other routes (see Head)
export default async function Page({ params, url }: { params: Record<string, string>; url: string }) {
  const rows = await db(params.id);                 // async server component: await in render
  return <main><Rows rows={rows} /><Counter /><Suspense fallback={<p>loading</p>}><Slow /></Suspense></main>;
}
```

* **Route option.** `export const render = "rsc"` joins `"spa" | "static" | "ssr"`. Without it nothing in this ADR is active.
  RSC routes are Worker-first (like `ssr`), GET only, and are **never in the client route table** (server code must not reach the browser bundle).
  Navigation to an RSC route is a full document load unless the page is hydrated and the link is rsc-to-rsc: P3 soft navigation (section 11).
* **Server vs client components.** Everything is a server component by default (runs only in the `rsc` environment, `react-server`
  condition, can be `async`, can use `React.cache`, cannot use state/effects/browser APIs or `@cf-lite/react/client`).
  A module whose first statement is `"use client"` is a client component: it is replaced by a client reference on the server and
  rendered in `ssr` + hydrated in the browser. Props crossing the boundary must be Flight-serializable.
* **`"use server"` (P1/P2: rejected; P3: form-based only, section 11).** The P1 text follows for history: it was rejected at build time (`rscNoActions`) with a message pointing to
  cf-lite's own actions (`docs/actions.md`). Reason: server actions are the only place Flight *requests* are decoded, which is exactly
  the surface of CVE-2025-55182 and its DoS follow-ups (section 7). Without them the only Flight data the server handles is its own output.
* **Layouts** **[P1 decision]**: existing `_layout.tsx` files are client-style (hooks, `Link`) and are *not* applied to RSC routes.
  An RSC route may be wrapped by `_layout.rsc.tsx` files (same directory nesting rules as `_layout.tsx`), which must be server-safe
  (or `"use client"`). They compose around the page inside the root document. Implemented in phase P2; until then RSC pages render un-layouted.
* **Metadata / head** **[P1 decision]**: reuse the existing `head` export (object, or function of `{ params, url }`, may be async) and
  the `seo()` helper; the rsc entry resolves it and renders it into the document `<head>` of the root `<html>` it owns.
  React 19 native `<title>/<meta>/<link>` hoisting inside server components also works and wins on conflict. Phase P2.
* **Streaming.** Suspense boundaries stream: shell flushes first, the rest arrives as Flight chunks inlined in the HTML
  (`rsc-html-stream`), the browser hydrates from the inline payload with no second fetch. `GET <route>?__rsc` returns the raw Flight stream
  (`text/x-component`), used by tests and a future soft-nav.
* **`notFound()` / `redirect()` / errors** **[P1 decision]**: `import { notFound, redirect } from "cf-lite/rsc"` throw sentinels.
  Before the first byte is flushed (the shell) they map to a real `404` / `3xx` response. After streaming started the status line is
  already sent, so `redirect()` degrades to a client `<meta http-equiv="refresh">` + noscript link and `notFound()` renders the route's
  `_not-found` boundary; both are documented as streaming caveats. Uncaught errors in the shell: `500` with the `_error.rsc.tsx`
  boundary (or the framework default); errors inside Suspense are contained by the nearest error boundary client component.
  Messages are never leaked in production (digest only, like React's own production behaviour). Phases P2-P3.

## 3. Environment layout (proven in the spike, kept)

* The **Worker is the `ssr` Vite environment** (Hono app, middleware, `ssr()` helper, UI adapters: all unchanged and all using `react-dom/server`).
  `rsc` is a **child environment** of that Worker (`cloudflare({ viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] } })`) and the Worker
  reaches it with `import.meta.viteRsc.loadModule("rsc", "index")`. `client` gets the generated `rsc-browser.tsx` as entry `index`.
* The inverse (Worker = `rsc`) was rejected: the whole app, including every existing `render="ssr"` page, would run under the
  `react-server` condition where `react-dom/server` does not exist.
* Constraints learned (each has a code comment where it bites): child `outDir` must be nested (`dist/ssr/rsc`) or wrangler cannot upload
  it; plugin-rsc hardcodes the client entry key `index`, so the SPA HTML input key is renamed `spa` (output path unchanged);
  `import.meta.viteRsc.*` must be written as literal call sites (no aliasing); `nodejs_compat` is recommended for third-party server components.
* Everything is generated into `.cf-lite/` (`rsc-entry.tsx`, `rsc-browser.tsx`, `app.ts` rows) **only when a route opts in**, and
  `@vitejs/plugin-rsc` is imported lazily only then. `cf-lite/modules/rsc` is imported by generated code only then.

## 4. Scope

| In (experimental v1, phases P1-P3) | Out (explicitly) |
|---|---|
| `render="rsc"` pages, params/url props, GET | Flight request decoding (`decodeReply`/`decodeAction`) |
| `"use client"` islands, async server components, Suspense streaming, `React.cache` | Programmatic server functions / bound actions (P3 adds form-based actions, section 11) |
| Layouts via `_layout.rsc.tsx`, `head`, `notFound`/`redirect`/error boundaries | Static prerender of RSC routes (`render` stays `"rsc"` = dynamic) |
| Works under `cf-lite dev` and workerd, one opt-in example, tests, size gate | Strict nonce-CSP on RSC routes (inline Flight scripts carry no nonce; `doctor` to warn), `isr`/`draft`/`i18n` interplay (documented unsupported until tested) |
| Pinned deps + advisory policy | Templates in `create-cf-lite`, other UI adapters (React only) |

Cost, from the spike (relative, local workerd): +~36 KB gzip Worker (+45% on a small app), +~8 KB client for the extra entry (only loaded on RSC pages),
~+7 ms/request warm, but first byte moves from "after slowest data" to "after the shell". Measured here: `examples/site-rsc` Worker 114,616 B gzip
(`bench/module-sizes.json`) vs the same app without an RSC route ~79 KB.

## 5. Opt-out guarantee (the hard rule) and how it is enforced

Apps/routes without `render = "rsc"` are byte-identical to `main`:
* Every code path is gated by `rscOn = pages.some(p => p.render === "rsc")` / `rsc.length` / the lazy import.
* Evidence (P1): the `dist/` tree of `site`, `site-routes`, `site-i18n` built with this branch has the same sha256 as built with `origin/main`'s
  `packages/cf-lite/src` (see `rsc-progress.md`); `npm run size:check` passes for all 22 existing examples with unchanged baselines; 900+ existing tests pass.
* `packages/cf-lite/test/rsc.test.ts` asserts no `rsc` text appears in generated files of a non-opt-in app; `rsc-pins.test.ts` asserts cf-lite's own
  dependencies never include RSC packages or the Optimizely SDK. Optimizely examples live only in the separate CMS starter repository.

## 6. Upgrade policy: "follow vinext"

* We do not chase `@vitejs/plugin-rsc` (0.x, README: "expect API changes") or React's bundler-facing `react-server-dom-*` APIs (not semver
  within 19.x). vinext is the reference consumer that exercises the same plugin on Workers, so **we track the ranges vinext publishes**
  (vinext 1.0.0 peers: `@vitejs/plugin-rsc ^0.5.34`, `react`/`react-dom`/`react-server-dom-webpack ^19.2.6`, `vite ^8`) and move only when a vinext release moves.
* **Exact pins**, no carets: `@vitejs/plugin-rsc 0.5.35`, `react` = `react-dom` = `react-server-dom-webpack 19.3.0`, `rsc-html-stream 0.0.8`
  in `examples/site-rsc/package.json` and as *optional* peers of `cf-lite` (so non-RSC users see no new requirement). plugin-rsc 0.5.35 vendors
  `react-server-dom` 19.3.0, so react / react-dom / react-server-dom-webpack stay on one version.
* **Bump procedure**: (1) new vinext release or advisory; (2) bump all pins together; (3) `npm run build && npx vitest run && node scripts/rsc-e2e.mjs && npm run size:check`;
  (4) update `rsc-pins.test.ts` floors and section 7 here; (5) one PR per bump. `rsc-pins.test.ts` fails if pins become ranges, diverge, leave vinext's ranges or fall below the patched floor.
* **Security fast-path**: a new advisory for any pinned package overrides "follow vinext": bump immediately to the patched version, even ahead of vinext.
  Re-run the advisory query in section 7 before every release containing RSC changes.

## 7. Security baseline (checked 2026-10-01)

Query: GitHub Advisory Database (`gh api /advisories?ecosystem=npm&affects=<pkg>`) for `react-server-dom-webpack` and `@vitejs/plugin-rsc`, plus the React blog.
All `react-server-dom-*` advisories affect the 19.0 / 19.1 / 19.2 lines; **the latest published fix is 19.2.8 (2026-07-21, CVE-2026-44907); the
advisory ranges do not include 19.3.x** (19.3.0 published 2026-09-09, after every listed fix).

| Advisory | Severity | Class | Patched (19.0 / 19.1 / 19.2 lines) |
|---|---|---|---|
| CVE-2025-55182 "React2Shell" (GHSA-fv66-9v8q-g76r), 2025-12-03 | critical | unauthenticated RCE via Flight payload deserialization (server function endpoints) | 19.0.1 / 19.1.2 / 19.2.1 |
| CVE-2025-55184 (GHSA-2m3v-v2m8-q956), 2025-12-11 | high | DoS (infinite loop) | 19.0.2 / 19.1.3 / 19.2.2 |
| CVE-2025-55183 (GHSA-925w-6v3x-g4j4), 2025-12-11 | medium | server function source exposure | 19.0.2 / 19.1.3 / 19.2.2 |
| CVE-2025-67779 (GHSA-7gmr-mq3h-m5h9), 2025-12-12 | high | DoS (incomplete fix of 55184) | 19.0.3 / 19.1.4 / 19.2.3 |
| CVE-2026-23864 (GHSA-83fc-fqcc-2hmg), 2026-01-29 | high | DoS / OOM | 19.0.4 / 19.1.5 / 19.2.4 |
| CVE-2026-23869 (GHSA-479c-33wc-g2pg), 2026-04-10 | high | DoS | 19.0.5 / 19.1.6 / 19.2.5 |
| CVE-2026-23870 (GHSA-rv78-f8rc-xrxh), 2026-05-11 | high | DoS | 19.0.6 / 19.1.7 / 19.2.6 |
| CVE-2026-44907 (GHSA-wx67-qw84-cm4g), 2026-07-24 | high | DoS in Server Functions | 19.0.8 / 19.1.9 / **19.2.8** |

`@vitejs/plugin-rsc` advisories: GHSA-fmh4-wr37-44fp (RCE, <=0.5.2 -> 0.5.3), GHSA-j76j-5p5g-9wfr / CVE-2025-67489 (RCE via unsafe dynamic import in dev, <=0.5.5 -> 0.5.6),
GHSA-cpqf-f22c-r95x + GHSA-c6m7-q6pr-c64r (DoS, source exposure, -> 0.5.7), CVE-2025-68155 / GHSA-g239-q96q-x4qm (arbitrary file read via `__vite_rsc_findSourceMapURL`, -> 0.5.8),
GHSA-v457-wxvj-p9w9 (DoS, -> 0.5.23), GHSA-w94c-4vhp-22gx (DoS, <=0.5.25 -> 0.5.26). **Highest patched: 0.5.26; we pin 0.5.35.**

Consequences:
* Pins (19.3.0 / 0.5.35) are above every patched version. **Important**: vinext's floor `^19.2.6` alone is *not* safe (19.2.6/19.2.7 < 19.2.8, CVE-2026-44907);
  our floor is **19.2.8 on the 19.2 line, or any 19.3+**, enforced by `rsc-pins.test.ts`. Users with their own react must meet it.
* v1 has no `"use server"` and no endpoint that decodes Flight requests (RSC routes are GET-only and serialize only their own output), so the RCE/DoS-in-Server-Functions
  class is not reachable even on an unpatched version; patching stays mandatory because Flight *client* decoding of the inline payload and any future actions share the code.
* `?__rsc` exposes the same data as the HTML, nothing more; it is a distinct cache key from the HTML (query string).
* Residual risk we accept for "experimental": plugin 0.x churn. Mitigation: pins + e2e on every bump (section 6).

Sources: [React blog: Critical Security Vulnerability (2025-12-03)](https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components),
[React blog: DoS and Source Code Exposure (2025-12-11, updated through 2026-01-26)](https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components),
[GHSA-fv66-9v8q-g76r](https://github.com/advisories/GHSA-fv66-9v8q-g76r), [GHSA-wx67-qw84-cm4g](https://github.com/advisories/GHSA-wx67-qw84-cm4g),
[GHSA-rv78-f8rc-xrxh](https://github.com/advisories/GHSA-rv78-f8rc-xrxh), [GHSA-479c-33wc-g2pg](https://github.com/advisories/GHSA-479c-33wc-g2pg),
[GHSA-83fc-fqcc-2hmg](https://github.com/advisories/GHSA-83fc-fqcc-2hmg), [GHSA-w94c-4vhp-22gx](https://github.com/advisories/GHSA-w94c-4vhp-22gx),
[GHSA-j76j-5p5g-9wfr](https://github.com/advisories/GHSA-j76j-5p5g-9wfr), [GHSA-g239-q96q-x4qm](https://github.com/advisories/GHSA-g239-q96q-x4qm).
The spike doc cited CVE-2025-55182 "from memory"; it is now verified above. The 2026-04..07 rows were found only via the GitHub Advisory Database (no react.dev post fetched for them).

## 8. Alternatives considered

* Adopt vinext / Next.js: larger surface, not Worker-first cf-lite conventions; vinext is the upstream we *follow*, not embed.
* RSC for all routes: breaks the byte-identical guarantee and the Worker = `ssr` layout.
* Own Flight implementation: unmaintainable and a security liability.
* Wait for plugin-rsc 1.0: acceptable but loses learning; the opt-in structure makes the experiment cheap to remove (delete `modules/rsc.ts`, the `rsc` branches in `pages.ts`/`vite.ts`/`scan.ts`).

## 9. Phases

P1 (done): ADR, port, pins, example, tests, size gate, security baseline.
P2 (done, 2026-10-01): data, caching, streaming - see section 10. P3 (done, 2026-10-01): client side - see section 11. P4 (open): `doctor` checks (deps present+pinned, `nodejs_compat`, CSP warning),
docs page, `cf-lite add rsc`, CI wiring, dev-mode (`cf-lite dev`) e2e, hardening (CSP nonce for inline Flight scripts).

## 10. As implemented in P2

* **Request context.** `import { getRequest, getEnv } from "cf-lite/rsc"` (AsyncLocalStorage, needs `nodejs_compat`): `{ env, ctx, req, params, url, data }` from any async server
  component or `React.cache` function. The page module may export `loader({ env, ctx, req, params, url })` (runs before rendering, result is the `data` prop and the `head`/`cache` ctx `data`).
* **Conventions** (`*.rsc.tsx`, never routes): `_layout.rsc.tsx` (nested, outer -> inner, props `{children, params, url, data}`), `_error.rsc.tsx` (nearest; MUST be `"use client"` to be used
  as the in-page boundary, props `{digest}`), `_not-found.rsc.tsx` (nearest; server component, rendered server-side). Client-style `_layout.tsx`/`_error.tsx` are not applied to rsc routes.
* **Head.** `head` (object|fn of `{params, data, url}`) of layouts + page, merged by the existing `headFor`, rendered into `<head>` (+ `htmlAttrs` on `<html>`). Script `strategy: "idle"` is approximated by `async`.
* **Status handling.** Pre-flush (shell) `notFound()`/`redirect()`/errors become real 404 / 3xx / 500 (Fizz rejects while the shell is incomplete; signals travel as Flight error digests
  `CFL_NOT_FOUND` / `CFL_REDIRECT;<status>;<url>`); the 404/500 body is the nearest boundary inside the layouts (or a plain default). Loader signals short-circuit before anything renders.
  Post-flush (inside Suspense): status stays 200; the generated `rsc-boundary.tsx` ("use client") degrades redirect -> `location.replace` (+ meta refresh/noscript, http(s) only) and
  not-found -> the not-found boundary. Error messages never reach the client (digest = request id).
* **Cache / ISR / tags.** `export const cache` and `export const isr` work on rsc routes: `rscRoute({ cache, isr })` reads them once from the rsc env (`config(path)`) and wraps the handler with the
  unchanged `cacheRoute` / `isrRoute` (isr inside cache). The HTML contains the Flight payload inline, so HTML + payload are one entry; `?__rsc` is a second key with the same `path:<pathname>` tag
  and the same policy, so a tag or path purge invalidates both (e2e-proven). stale-while-revalidate and stale-if-error are the existing modules' (`swr`; ISR `maxStale`). Auth-cookie / draft / csp-nonce bypass applies as for ssr.
* Server actions were out of scope in P2; P3 adds form-based ones (section 11). The ssr-style `actions` export on an rsc page is still a scan error (the rsc export is `serverActions`).

## 11. As implemented in P3 (client side)

**Hydration / islands.** The whole document is the Flight root (`hydrateRoot(document)`), but server components ship no code: the browser only loads chunks of the `"use client"`
modules the payload references. plugin-rsc already splits each client module into its own lazy chunk, so a route loads only its islands (e2e: `/rsc` loads `counter` and not `toggle`,
`/rsc-other` the reverse, `/rsc-data` neither). **Pure server pages**: `export const hydrate = false` on an rsc page -> no bootstrap script, no inline Flight payload, no client boundary
(and so no client reference at all): zero JS requests (e2e asserts none). `"use client"` components on such a page are SSR-only (inert); links on it are normal full loads; POST forms still work (no-JS path).

**Soft navigation** (`modules/rsc-client.ts`, started by the generated `rsc-browser.tsx`, which also bakes in the list of rsc route patterns). A delegated click handler intercepts same-origin
left-clicks on links whose pathname matches an rsc route (no modifier keys, `target`, `download`, `rel=external`, `data-no-soft`; same-page `#hash` left to the browser), fetches `<url>?__rsc`
(`Accept: text/x-component`) and swaps the new root inside `startTransition` (old page stays until the new payload is parseable). History is `pushState`; `popstate` re-fetches. Everything else is a
full-page load: SPA/SSR/static targets, other origins, a payload fetch that fails/isn't `text/x-component`/is redirected out of rsc routes (hard `location.assign` fallback). Because the
Worker already serves 404/redirect/error as the same payload shape, those soft-navigate too (a `redirect()` is followed by `fetch`; the final URL is pushed). **Prefetch**: hover/focus/touch (65 ms
debounce) for every rsc link, plus `data-prefetch="viewport"` links via IntersectionObserver; skipped under `saveData`; entries live 30 s, max 24, consumed once. **Scroll**: `scrollRestoration = "manual"`, position kept in `history.state`
and restored on back/forward; push navigations go to the `#hash` target or the top. A non-hydrated (`hydrate = false`) page has no router: its links are full loads.

**Server actions (form-based, minimal).** Only `<form action={fn}>` where `fn` is exported from a `"use server"` file. cf-lite never calls `decodeReply`/`decodeAction`: the Worker (`modules/rsc-action.ts`)
reads a size-bounded body as `FormData`, extracts exactly one `$ACTION_ID_<id>` field itself and refuses everything else, so the Flight-request decoding that the CVE class (section 7) lives in stays unreachable.
Checks, cheap first (each failure is a plain-text status and a `console.warn`, never an echo of input): (1) `POST` only; (2) origin/CSRF: `Sec-Fetch-Site` then `Origin`, neither = 403 (`modules/csrf.ts`); (3) content type form
urlencoded/multipart only (else 415: a Flight reply `text/x-component` or JSON is refused); (4) body limit 1 MiB (route may export `actionMaxBytes`), by `Content-Length` and while streaming (413; also > 200 fields);
(5) id shape (`file#name` charset/length, forbidden names `__proto__`/`constructor`/...), exactly one id, no `$ACTION_REF_*`/`$ACTION_KEY` (bound args need `decodeReply`) -> 400; (6) **allowlist**:
build-time - `"use server"` is accepted only under `app/actions/**` or `*.actions.ts` (`rscActions` in `vite.ts`, anything else is a build error); per route - the id must be in the route's (or its layouts')
`export const serverActions = [fn, ...]` (ids are app-global, so without this a route's guard/limits could be bypassed by posting to another route) -> 400; (7) **rate-limit / authz hook** `export const actionGuard = ({ req, env, ctx, params, id }) => boolean | Response | void`
(`false` = 429 with `retry-after`, a `Response` is returned as is; build it from `memoryLimiter`/`bindingLimiter` of `modules/ratelimit.ts`; global limits remain ordinary Hono middleware); (8) the plugin registry must resolve the id to a registered
server reference with exactly that id (checked on `$$typeof`/`$$id`) else 400. The action runs inside the request context (`getRequest()`), may `redirect()`/`notFound()`, and its return value is ignored.
Result: no-JS = `303` back to the same URL (PRG); with the client router (`Accept: text/x-component`) = the freshly rendered page payload applied in place (island state preserved) or `x-cf-lite-redirect: <url>` for `redirect()`;
thrown errors = 500 with the route's error boundary and a digest only (message never leaks). Programmatic calls (`onClick={() => fn(x)}`, non-FormData args) throw on the client: not supported. POST is never cached; use tag purges (section 10) in the action.
Hostile-input coverage: `rsc-action.test.ts` (unit) and the workerd e2e (cross-origin, no origin, forged/malformed/multiple/bound ids, unregistered ids, wrong route, oversized by length and streamed, JSON/Flight bodies, broken multipart, rate-limit hook, error leak, redirect/notFound).

Caveats: `actionGuard`/limits are per route (a layout-hosted action is guarded by whichever page posts it); an action that throws after partially mutating data is the app's problem (no transactions); CSP nonce for inline Flight scripts: done in P4 (section 12).

## 12. As implemented in P4 (hardening, measurement, docs, Opti proof)

* **CSP nonce.** `rsc.ts` passes `c.get("cspNonce")` (set by `security()`) to `renderToReadableStream({ nonce })` (bootstrap script) and `injectRSCPayload(s2, { nonce })` (every inline Flight chunk). `cache`/`isr` already bypass when a nonce is set, so a stored page can never replay a stale nonce.
  e2e (`/rsc-csp` under `security({ preset: "strict" })`, real Chromium): every `<script>` carries the nonce, a different nonce per request, hydration works with the CSP enforced and zero violations.
* **Doctor.** `CFL014` (no `nodejs_compat`/`nodejs_als` for `getRequest()`), `CFL015` (RSC pins missing / ranged / mismatched / below the patched floor), `CFL016` (strict `script-src` in `_headers` with no `security()` to stamp nonces). Only evaluated for apps that have a `render = "rsc"` page; `rsc-doctor.test.ts`.
* **Docs.** User guide `docs/rsc.md` (opt-in, features, limits, security notes), linked from `docs/README.md`.
* **Measurements** `bench/RESULTS-rsc.md` (local workerd, vs `render="ssr"` and vinext): Worker 133 KB gzip vs vinext 287 KB; client JS 78.6 KB vs vinext 135 KB (`hydrate = false`: 0); CPU proxy 7.2-8.4 ms vs vinext 14.8 ms (ssr 4.4-6.2); with slow data TTFB 37 ms vs ssr 176+ ms.
  The ~10-15 ms later first byte vs vinext with pending slow data was bisected to the local launcher, not rsc (a plain streaming Hono route shows the same jump; vinext runs under `@cloudflare/vite-plugin` 2.0.0-beta). Numbers re-run without the example's per-request `console.log`.
* **Opti proof** (in the separate CMS starter repository): the SDK's own `@optimizely/cms-sdk/react/server` `OptimizelyComponent` (public npm 3.0.2, unmodified) renders published and preview/edit content from a mock CMS on this branch; 65 glue lines vs 199 for the `./core` loader path (not an apples-to-apples feature set, see its README).
* **Review.** Independent cross-vendor review of the branch diff: results and dispositions in `rsc-progress.md`.

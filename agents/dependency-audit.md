---
version: 0.4.0
scope: agents
evidence: unverified
verifiedOn: 2026-10-06
owner: maintainer
---

# Brief: audit dependencies before a release or publish

## 1. Purpose
Know, before any version is prepared or published, which known advisories exist in the dependency tree, and decide per advisory: fix, override, or accept with the owner's written reason. Not your job: upgrading a major version of a tool, publishing, or accepting an advisory on the owner's behalf.

## 2. Trigger
Before every release sweep or publish ([release-publish](release-publish.md)); after changing `package.json` or `bun.lock`; when the owner asks; when a consumer reports an advisory in a published package.

## 3. Inputs
| Input | Where it comes from | If missing |
|---|---|---|
| Network access to the advisory source | `bun audit` | report "not run"; never write "clean" |
| The list of published packages | [`docs/published.md`](../docs/published.md), `private` field in `packages/*/package.json` | stop |

## 4. Steps
Work in a fresh worktree from `origin/main`.

1. `bun install --frozen-lockfile`
2. Run the audit and keep the output for the PR:
   ```bash
   bun audit
   ```
   Expected: a list of advisories, each with its dependency path (`workspace:<pkg> > ... > <vulnerable>`), or none.
3. Classify by where the path starts:
   | Path starts at | Class | Effect |
   |---|---|---|
   | a published package's `dependencies` (`cf-lite`, `@cf-lite/<ui>`, `create-cf-lite`) | production | **critical/high blocks a release or publish** ([D-007](../docs/DECISIONS.md#d-007-a-critical-or-high-advisory-in-a-production-dependency-blocks-a-release-or-publish)) until fixed or accepted by the owner in writing |
   | a published package's `peerDependencies` | consumer-side | document the advisory and any override in the adapter or CLI docs; cannot be forced from here (see the former Solid case, [D-008](../docs/DECISIONS.md#d-008-solid-js-1x-pins-a-vulnerable-seroval-the-override-is-carried-by-the-consumer-app) for the pattern) |
   | `devDependencies`, a private package (`@cf-lite/testing`, `@cf-lite/playwright`), `examples/*`, `site/` | dev-only | does not block; report in the PR, fix when cheap |
4. Fix within ranges first: `bun audit fix` shows the proposal; apply it only when the lockfile diff touches nothing outside the advisory's path. Crossing a major version (`bun audit fix --latest`) is the owner's decision.
5. An override (for example the former `seroval` override of `@cf-lite/solid`, [D-008](../docs/DECISIONS.md#d-008-solid-js-1x-pins-a-vulnerable-seroval-the-override-is-carried-by-the-consumer-app)) carries a doc entry with the advisory id and the removal condition.
6. After any change: `bun run build && bun run typecheck && bun run test && bun run docs:check`.
7. Record the result, dated, in the PR body (not in a doc as a number): advisories found, classification, what you fixed, what stays and why. A standing "accepted" item gets a [decision entry](../docs/DECISIONS.md) with a `lastChecked` date so it is re-read.

## 5. Outputs
`package.json` / `bun.lock` only when a fix needs them; docs for an override or accepted item. PR title `deps: <advisory fix or audit note>`. PR body: audit output (package, severity, path), classification, accepted items with reasons.

## 6. Evidence rules
"No advisories" is claimed only with the command output of the day. An advisory is called dev-only only when its path shows it starts at a dev dependency or a private package.

## 7. Stop and ask (owner)
A major-version upgrade of a tool; an advisory in a production dependency with no fix; accepting any advisory; adding a dependency; anything about publishing; an override that would change what consumers install.

## 8. Forbidden
Silencing the audit (ignoring ids, deleting the lockfile to "reset"), upgrading unrelated packages in the same PR, copying advisory counts into docs, weakening the gate.

## 9. Hand-off
Final message: branch and PR, audit output summary, classification table, fixed versus accepted, what the owner must decide.

## 10. Where truth lives
| Question | Source |
|---|---|
| What is installed | `bun.lock` |
| Which advisories exist today | `bun audit` (run it) |
| Which packages are published | [`docs/published.md`](../docs/published.md) |
| The blocking rule | [D-007](../docs/DECISIONS.md#d-007-a-critical-or-high-advisory-in-a-production-dependency-blocks-a-release-or-publish) |

## 11. Definition of done
- [ ] `bun audit` output of the day in the PR
- [ ] every advisory classified; production critical/high fixed or accepted by the owner, in writing
- [ ] `bun run test`, `bun run typecheck`, `bun run docs:check` (paste)

## 12. History
| Date | Change | By (role) | Why |
|---|---|---|---|
| 2026-10-06 | First version. `bun audit` run that day: findings of severity high exist under `cf-lite > @cloudflare/vite-plugin > miniflare` (`undici`, `sharp`), a path that starts at a published package's `dependencies`, so by the rule above a **new release or publish is blocked until fixed or accepted by the owner**; other highs are under private packages, `examples/*` or dev tooling (`source-map-js`, `fflate`). Nothing was changed or upgraded in this pass; the existing 0.4.0 packages are already published. Re-run before the next publish, the list will have changed | doc agent | the audit gate was undocumented here; owner decision on the gate |
| 2026-10-06 | Measured what a consumer gets: `npm audit --omit=dev` in a clean directory after `npm i <pkg>@latest` for each of the seven published packages. Result: 0 advisories for `cf-lite`, `create-cf-lite`, `@cf-lite/preact|react|svelte|vue`; `@cf-lite/solid` shows `seroval` (critical, via the `solid-js` peer, see [D-008](../docs/DECISIONS.md#d-008-solid-js-1x-pins-a-vulnerable-seroval-the-override-is-carried-by-the-consumer-app)). The earlier `bun audit` finding under `cf-lite > @cloudflare/vite-plugin > miniflare` is a stale lockfile pin (`miniflare@5.20260815` via dev trees), not what an install resolves: `@cloudflare/vite-plugin` 1.62.2 (the floor of the `cf-lite` range) already depends on `miniflare` 5.20260926.1 (`undici` 7.29.1, `sharp` 0.35.4). No range change, no publish needed. Lockfile refresh of dev-only paths via `bun audit fix` | release agent | the gate had been read from the monorepo lockfile, which includes dev and example trees |

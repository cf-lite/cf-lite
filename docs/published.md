# Published packages

Published to npm, dist-tag `latest`, public access, no provenance (no OIDC available where it was published): all seven packages at `0.4.2` (`cf-lite`, `create-cf-lite`, `@cf-lite/preact|react|solid|svelte|vue` at the time), published 2026-10-06 from this repository at commit `ea6ef1a` (tag `v0.4.2`). Registry check 2026-10-06 (`npm view <package>@0.4.2 version repository.url`): every package reports version `0.4.2` and `repository.url` `git+https://github.com/cf-lite/cf-lite.git`; `dist-tags.latest` is `0.4.2` for all seven.

`create-cf-lite@0.4.0` had a bug: scaffolding via `npx create-cf-lite my-app` failed with ENOENT (the copy filter matched the `node_modules` segment of the install path). `0.4.1` and `0.4.2` fix it ([D-006](DECISIONS.md#d-006-seven-packages-are-published-to-npm-at-040-the-owner-authorises-every-publish-bump-and-tag)).

Dependency audit of what a consumer installs (2026-10-06, `npm audit --omit=dev` after a clean install of each 0.4.2 tarball, before publishing): no advisory for `cf-lite`, `create-cf-lite`, `@cf-lite/preact|react|svelte|vue`; `@cf-lite/solid` showed the `seroval` advisory (override carried by the app).


| Package | Install |
|---|---|
| `cf-lite` | `npm i cf-lite` |
| `@cf-lite/preact` | `npm i @cf-lite/preact` |
| `@cf-lite/react` | `npm i @cf-lite/react` |
| `@cf-lite/svelte` | `npm i @cf-lite/svelte` |
| `@cf-lite/vue` | `npm i @cf-lite/vue` |
| `create-cf-lite` | `npm create cf-lite@latest <my-app>` |

**History:** `0.4.0` (`cf-lite` and the five adapters) and `0.4.1` (`create-cf-lite` only) were published from the previous private repository, so their registry metadata point at it; `0.4.2` replaces both and removes `cfl init opti` ([changelog](../CHANGELOG.md)). Consumer check on the registry copy (empty npm cache, 2026-10-06): `npx create-cf-lite@0.4.2 app --ui react` and `--ui solid` scaffold, install and `bun run build` succeeded.

Not published: `@cf-lite/playwright`, `@cf-lite/testing`.

`@cf-lite/solid@0.4.2` stays on the registry but is no longer developed here: the package was removed from this repository after 0.4.2 ([D-027](DECISIONS.md)). The table above lists the packages that are still maintained.

## Tags

| Tag | Commit | Packages |
|---|---|---|
| `v0.4.2` | `ea6ef1a` | all seven packages at 0.4.2 (this repository) |
| `v0.4.0` | `83d6908` | previous repository only: `cf-lite` and the five `@cf-lite/*` adapters at 0.4.0 |
| `create-cf-lite-v0.4.1` | `4f6d34a` | previous repository only: `create-cf-lite` 0.4.1 |

Annotated tags, created 2026-10-06 (`v0.4.2`: tagger "cf-lite maintainers", no GitHub Release object) ([D-019](DECISIONS.md#d-019-tags-v040-and-create-cf-lite-v041-are-created-by-an-agent-license-files-are-required-only-for-public-repositories)). This repository started from a single clean commit (D-023), so the two older tags exist only in the previous repository; `v0.4.2` is the only tag here. If the history is ever rewritten, re-create `v0.4.2` on the new commit.

State as of the registry check on 2026-10-06; re-check with `npm view <package> version` before relying on it.

Packages are released from `main` with `npm publish --access public` using a short-lived token supplied at publish time (never committed). Replace `<my-app>` with your project name.

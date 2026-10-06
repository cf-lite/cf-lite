# Published packages

Published to npm, dist-tag `latest`, public access, no provenance: `cf-lite` and the five `@cf-lite/*` adapters at `0.4.0`, `create-cf-lite` at `0.4.1` (registry check 2026-10-06, `npm view <package> version`).

`create-cf-lite@0.4.0` had a bug: scaffolding via `npx create-cf-lite my-app` failed with ENOENT (the copy filter matched the `node_modules` segment of the install path). `0.4.1` fixes it ([D-006](DECISIONS.md#d-006-seven-packages-are-published-to-npm-at-040-the-owner-authorises-every-publish-bump-and-tag)).

Dependency audit of what a consumer installs (2026-10-06, `npm audit --omit=dev` after a clean install of each package): no advisory for `cf-lite`, `create-cf-lite`, `@cf-lite/preact|react|svelte|vue`; `@cf-lite/solid` shows the `seroval` advisory described in [adapters.md](adapters.md) (override carried by the app).


| Package | Install |
|---|---|
| `cf-lite` | `npm i cf-lite` |
| `@cf-lite/preact` | `npm i @cf-lite/preact` |
| `@cf-lite/react` | `npm i @cf-lite/react` |
| `@cf-lite/solid` | `npm i @cf-lite/solid` |
| `@cf-lite/svelte` | `npm i @cf-lite/svelte` |
| `@cf-lite/vue` | `npm i @cf-lite/vue` |
| `create-cf-lite` | `npm create cf-lite@latest <my-app>` |

**Prepared, not yet published:** `0.4.2` of all seven packages (the `version` fields in this repository, the first release published from it) is in the tree (metadata `repository`, `bugs` and `homepage` point at `https://github.com/cf-lite/cf-lite`; no code change otherwise, apart from the removal listed in the changelog). It is published right after the repository becomes public; until then the registry shows the versions above, whose metadata point at the previous (private) repository.

Not published: `@cf-lite/playwright`, `@cf-lite/testing`.

`@cf-lite/solid` needs `solid-js >=1.9.15`; apply the `seroval` override described in [adapters.md](adapters.md) (`cf-lite add solid` writes it).

## Tags

| Tag | Commit | Packages |
|---|---|---|
| `v0.4.0` | `83d6908` | `cf-lite` and the five `@cf-lite/*` adapters at 0.4.0 |
| `create-cf-lite-v0.4.1` | `4f6d34a` | `create-cf-lite` 0.4.1 |

Annotated tags, created 2026-10-06 ([D-019](DECISIONS.md#d-019-tags-v040-and-create-cf-lite-v041-are-created-by-an-agent-license-files-are-required-only-for-public-repositories)). This repository started from a single clean commit (D-023), so the two tags above exist only in the previous repository; re-create them on the commit that is published. If the history is ever rewritten, re-create both tags on the new commits.

State as of the registry check on 2026-10-06; re-check with `npm view <package> version` before relying on it.

Packages are released from `main` with `npm publish --access public` using a short-lived token supplied at publish time (never committed). Replace `<my-app>` with your project name.

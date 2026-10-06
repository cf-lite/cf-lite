# Upgrading

Run `bunx cf-lite upgrade [--dry-run]`: it applies the idempotent codemods between the version in your `package.json` and the installed one, bumps
`cf-lite` and `@cf-lite/*`, and prints manual steps ([dx.md](dx.md)). Below are the breaking changes by release, newest first. Policy: [stability.md](stability.md).

## From 0.3 to 0.4

* `cf-lite/modules/sso` no longer has a built-in issuer: set `SSO_ISSUER` and `SSO_PUBLIC_KEYS` (a JWKS or a `{kid: base64-key}` map); required `SSO_AUDIENCE` (fail-closed), optional `SSO_COOKIE_NAME`, `SSO_AUTH_ORIGIN`. `ssoLoginUrl(returnUrl, env, refresh?)` now takes the env for the auth origin. Codemod `0.4-sso-env` adds the variable names to `.dev.vars.example`; the values are manual.
* Adapter authors: `View` gained an optional `hydrate` flag (whether the page will hydrate in the browser).

## From 0.2 to 0.3

* `cfLite({ renderer: "react" })` / `"preact"` -> `cfLite({ renderer: react() })` (`import react from "@cf-lite/react"`); the string renderers are gone. Codemod `0.3-renderer` (or `bunx cf-lite add react`) does it.
* `import { Link, mount } from "cf-lite/client"` -> `"@cf-lite/react/client"` (framework-free `navigate`, `createRouter` stay in `cf-lite/client`).
* `react`/`react-dom` are no longer dependencies of `cf-lite`; an API-only app can drop them (`renderer: "none"`).

## Unreleased (0.5 line)

Additive so far: see the "Unreleased" section of [CHANGELOG.md](../CHANGELOG.md). Notable behaviour to re-check after upgrading: required catch-all routes
(`[...x]`) now need at least one segment (use `[[...x]]` for the optional form), and `cfLite()` now writes a default `_headers` (`cfLite({ headers: false })` opts out).

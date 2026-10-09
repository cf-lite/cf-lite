# `cfl export`: HTML fragments for any backend

Renders every component state through the real UI adapter and writes the markup in a stable layout, so a Razor / Twig / JSP / anything project can include it instead of re-typing it from a screenshot. `cfl` is an alias of the `cf-lite` binary.

```sh
cfl build            # optional: lists the built CSS/JS in assets.json
cfl export [--out patterns-export] [--mock] [--check]
```

It starts a throw-away `vite dev` on a free port (the same render path as [`/__preview`](preview.md)), fetches `/__preview/frame/<id>?s=<state>&fragment=1` for every state, stops the server, and writes (or with `--check` only compares) the result. Any component that fails to render makes the command exit 1 and **nothing is written**.

## Layout

```
patterns-export/
  manifest.json                          components, states, files, bytes, sha256
  assets.json                            CSS/JS of the last `cfl build` + the island runtime
  patterns/atoms/Button/default.html     <component id>/<state>.html, one per state
  patterns/atoms/Button/ghost.html
  islands/Counter/from-ten.html
```

A fragment is only the component's HTML (no `<html>`/`<head>`). Island markup is included as it renders: `<cfl-island data-i="app/islands/Counter" data-p="{...}">...</cfl-island>`; the backend page adds the island runtime from `assets.json` (`islands.runtime` + `islands.preload`) and `cfl-island{display:contents}` once, and the island hydrates in the browser as on a cf-lite page. File names are `safeName(state)` (anything outside `A-Za-z0-9._-` becomes `_`); two states that collapse to one file are an error.

`manifest.json` (abridged):

```json
{ "version": 1, "tool": "cf-lite export", "components": [
  { "id": "patterns/atoms/Button", "name": "Button", "group": "patterns/atoms", "island": false,
    "states": [{ "name": "default", "file": "patterns/atoms/Button/default.html", "bytes": 62, "sha256": "..." }] } ] }
```

`assets.json`: `{ "version": 1, "source": "dist/client", "css": [{ "file": "assets/index-<hash>.css", "bytes", "sha256" }], "js": [...], "islands": { "runtime": "/assets/islands-<hash>.js", "preload": [...] } }`. Without a build, `source` is `null` and the lists are empty (the command says so).

## Diff-clean

Sorted components, states and keys; LF newlines and exactly one trailing newline; no timestamps, no absolute paths, no machine-specific ids; files the previous export wrote that no longer belong (a removed state or component) are deleted along with empty folders. **Running it twice changes nothing** and `cfl export --check` exits 1, printing `~ changed`, `+ missing`, `- stale`, when the committed export is out of date: use it in CI next to the build, or commit the folder and review pattern changes as diffs. Hashed asset names change when the CSS/JS change; that is the point of `assets.json`.

## Using it from a backend

* **Razor / MVC**: read the fragment at build time (a small source generator or a T4/MSBuild step that turns `patterns-export/**/*.html` into `.cshtml` partials) or load it as a static file; replace the props-driven parts with model bindings. The fragments are the spec the markup must match, and `--check` + `manifest.json` hashes tell you in CI when a pattern changed so the partial needs the same edit. cf-lite does not ship a .NET integration: that part is yours.
* **Any backend**: include `assets.json`'s CSS/JS in your layout, include fragments where the pattern is used.
* **Props are not templates.** A fragment is one rendered state; it carries no placeholders. If the backend needs to render the same pattern with live data, the states are the examples to test the backend's output against (diff its HTML with the fragment).

## Options

| Flag | Meaning |
|---|---|
| `--out <dir>` | export directory, relative to the app (default `patterns-export`) |
| `--check` | write nothing; exit 1 when the directory differs from what would be written |
| `--mock` | render with `MOCK=1` (`mocks/` served to components that fetch) |

Needs a UI adapter whose server module has `bind` (react, preact, vue; see [preview.md](preview.md#adapters)).

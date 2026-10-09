// cf-lite build for the demo + every adapter example app (used before the Playwright run).
import { spawnSync } from "node:child_process";
const cli = new URL("../packages/cf-lite/dist/cli.js", import.meta.url).pathname;
// "docs" = the documentation site `site/` (axe gate in e2e/docs-a11y.spec.ts); it needs its generator first.
for (const d of ["demo", "site", "site-preact", "site-vue", "site-svelte", "site-htmx", "site-images", "site-forms", "site-security", "site-islands", "site-islands-vue", "cms-head", "docs"]) {
  const cwd = d === "docs" ? new URL("../site/", import.meta.url).pathname : new URL(`../examples/${d}/`, import.meta.url).pathname;
  if (d === "docs") { const g = spawnSync(process.execPath, ["scripts/gen.mjs"], { cwd, stdio: "inherit" }); if (g.status !== 0) process.exit(g.status ?? 1); }
  const r = spawnSync(process.execPath, [cli, "build"], { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

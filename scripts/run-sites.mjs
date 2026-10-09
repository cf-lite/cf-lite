// Runs scripts/site-e2e.mjs (workerd behaviour) for every UI adapter's example app.
import { spawnSync } from "node:child_process";
export const SITES = ["site", "site-preact", "site-vue", "site-svelte"];
if (import.meta.url === `file://${process.argv[1]}`) {
  let failed = 0;
  for (const SITE of SITES) {
    const r = spawnSync(process.execPath, [new URL("./site-e2e.mjs", import.meta.url).pathname], { stdio: "inherit", env: { ...process.env, SITE } });
    if (r.status !== 0) { failed++; console.error(`FAILED: ${SITE}`); }
  }
  process.exit(failed ? 1 : 0);
}

// Shared by scripts/size-budget.mjs (CI gate) and packages/cf-lite/test/size-budget.test.ts (tree-shake proof).
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

const root = new URL("../", import.meta.url).pathname;
export const STUB = "export default { fetch() { return new Response('ok'); } };";
// `rsc` needs @vitejs/plugin-rsc virtual imports (import.meta.viteRsc) and cannot be bundled alone; its cost is measured in examples/site-rsc-lite.
export const moduleNames = () => readdirSync(root + "packages/cf-lite/dist/modules").filter((f) => f.endsWith(".js") && f !== "rsc.js").map((f) => f.slice(0, -3)).sort();

/** Minified gzip bytes of a Worker entry bundled the way Workers see it (cloudflare:* / node:* external). */
export async function bundleGzip(contents) {
  const r = await build({ stdin: { contents, resolveDir: root }, bundle: true, minify: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], external: ["cloudflare:*", "node:*"], logLevel: "silent" });
  return gzipSync(r.outputFiles[0].contents, { level: 9 }).length;
}
export const baselineBytes = () => bundleGzip(STUB);
/** Cost of actually using the module (re-exporting everything keeps all of it). */
export const moduleBytes = (m) => bundleGzip(`export * from "cf-lite/modules/${m}";\n${STUB}`);
/** Cost of importing a module and using none of it: must equal the baseline (sideEffects:false + tree-shaking). */
export const unusedBytes = (m) => bundleGzip(`import { } from "cf-lite/modules/${m}"; import * as _u from "cf-lite/modules/${m}";\n${STUB}`);

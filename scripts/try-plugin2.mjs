// Spike: does cf-lite work on @cloudflare/vite-plugin 2.x (beta)? Copies the repo to a scratch dir, swaps the plugin to the
// `beta` dist-tag, replaces examples/site's wrangler.jsonc with cloudflare.config.ts (2.x no longer reads wrangler.jsonc),
// builds, runs `vite preview`, and asserts routing. Nothing in the real repo changes.  Usage: node scripts/try-plugin2.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const repo = new URL("../", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "cfl-v2-"));
const sh = (cmd, cwd = tmp) => { const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" }); if (r.status) throw new Error(cmd + "\n" + r.stdout + r.stderr); return r.stdout; };
sh(`rsync -a --exclude node_modules --exclude dist --exclude .git --exclude bench --exclude .wrangler --exclude .cf-lite --exclude .cloudflare --exclude test-results --exclude e2e/.tmp ${repo} ${tmp}/`);
const tag = sh(`npm view @cloudflare/vite-plugin@${process.env.PLUGIN_TAG ?? "beta"} version`).trim(); // exact version: the copied lockfile pins 1.x
rmSync(join(tmp, "package-lock.json"), { force: true });
const pkg = join(tmp, "packages/cf-lite/package.json");
writeFileSync(pkg, readFileSync(pkg, "utf8").replace(/"@cloudflare\/vite-plugin": "[^"]+"/, `"@cloudflare/vite-plugin": "${tag}"`));
sh("npm install --no-audit --no-fund 2>&1 | tail -2");
console.log("plugin:", sh("npm ls @cloudflare/vite-plugin 2>&1 | tail -2").trim());
sh("npm run build -w cf-lite 2>&1 | tail -2");
const site = join(tmp, "examples/site");
rmSync(join(site, "wrangler.jsonc"));
writeFileSync(join(site, "cloudflare.config.ts"), `import { bindings, defineConfig, defineWorker } from "@cloudflare/config";
export default defineConfig({ worker: defineWorker({ name: "cf-lite-site", entrypoint: "./server/worker.ts", compatibilityDate: "2026-09-01",
  assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] }, env: { ASSETS: bindings.assets() } }) });\n`);
const out = sh("node ../../packages/cf-lite/dist/cli.js build 2>&1 | tail -25", site);
assert.ok(existsSync(join(site, ".cloudflare/output/v0/workers/default/assets/index.html")), "2.x output layout\n" + out);
const cfg = JSON.parse(readFileSync(join(site, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8"));
assert.deepEqual(cfg.assets, { notFoundHandling: "404-page", runWorkerFirst: ["/blog/*", "/api/*"] });
const port = 19700 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [join(tmp, "node_modules/vite/bin/vite.js"), "preview", "--port", String(port), "--strictPort"], { cwd: site, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
try {
  for (let i = 0; i < 60 && !/localhost:\d+/.test(log); i++) await new Promise((r) => setTimeout(r, 500));
  const get = async (p) => { const r = await fetch(`http://localhost:${port}${p}`, { headers: { "sec-fetch-mode": "navigate", accept: "text/html" }, redirect: "follow" }); return [r.status, await r.text()]; };
  let [s, t] = await get("/"); assert.equal(s, 200); assert.match(t, /Home \(static\)/);
  [s] = await get("/app/dashboard/"); assert.equal(s, 200);
  [s] = await get("/nope"); assert.equal(s, 404);
  [s, t] = await get("/blog/hello"); assert.equal(s, 200); assert.match(t, /Blog/);
  [s, t] = await get("/api/hello"); assert.equal(s, 200);
  const hits = [...log.matchAll(/\[worker\] (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(hits.sort(), ["/api/hello", "/blog/hello"], "only ssr + api reach the Worker");
  stop();
  // dev server too (workerd via the 2.x plugin)
  const dport = port + 1;
  const dev = spawn(process.execPath, [join(tmp, "node_modules/vite/bin/vite.js"), "dev", "--port", String(dport), "--strictPort"], { cwd: site, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let dlog = ""; dev.stdout.on("data", (d) => (dlog += d)); dev.stderr.on("data", (d) => (dlog += d));
  try {
    let ok = "";
    for (let i = 0; i < 80 && !ok; i++) { await new Promise((r) => setTimeout(r, 500)); try { const r = await fetch(`http://localhost:${dport}/blog/hello`); const t = await r.text(); if (r.status === 200 && /Blog/.test(t)) ok = t; } catch {} }
    assert.ok(ok, "dev: ssr route served by the Worker\n" + dlog.slice(-1500));
    const a = await fetch(`http://localhost:${dport}/api/hello`); assert.equal(a.status, 200);
  } finally { try { process.kill(-dev.pid, "SIGTERM"); } catch {} }
  console.log("plugin 2.x spike OK (build + preview + dev):", out.trim().split("\n").pop());
} finally { stop(); rmSync(tmp, { recursive: true, force: true }); }
process.exit(0);

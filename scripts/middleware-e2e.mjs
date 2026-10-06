// WP-MIDDLEWARE e2e under local workerd: server/middleware.ts + config.matcher -> run_worker_first globs.
// Asserts the built wrangler globs, that non-matching paths never invoke the Worker (same [worker] log signature as e2e.mjs),
// gate behaviour, negative patterns, and ordering (server/worker.ts root -> middleware -> /api).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-gated/", import.meta.url).pathname;
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const wj = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_gated/wrangler.json"), "utf8"));
assert.deepEqual([...wj.assets.run_worker_first].sort(), ["!/admin/public", "!/admin/public/*", "/admin", "/admin/*", "/api/*"].sort(), "matcher compiled into run_worker_first");

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 19900 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const get = (p, init) => fetch(B + p, { redirect: "manual", ...init });
  const lines = () => [...log.matchAll(/\[(worker|mw)\] (\S+)/g)].map((m) => `${m[1]} ${m[2]}`);
  const authed = { headers: { cookie: "sess=ok" } };

  // 1. non-matching / excluded paths never invoke the Worker
  let r = await get("/"); assert.equal(r.status, 200); assert.match(await r.text(), /public home/);
  r = await get("/admin/public/info.txt"); assert.equal(r.status, 200); assert.match(await r.text(), /public info/);
  r = await get("/assets/nope.js", { headers: { "sec-fetch-mode": "no-cors" } });
  await sleep(300);
  assert.deepEqual(lines(), [], "Worker must not run for non-matching paths; got " + lines());

  // 2. matched paths: gate closed without the cookie (also for static files under the matcher), open with it
  r = await get("/admin/secret.txt"); assert.equal(r.status, 401);
  r = await get("/admin/secret.txt", authed); assert.equal(r.status, 200); assert.match(await r.text(), /secret static file/);
  r = await get("/api/private", authed); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { secret: 42 }); assert.equal(r.headers.get("x-gated"), "1");
  assert.equal((await get("/api/private")).status, 401);
  assert.equal((await get("/admin")).status, 401, "/admin itself is covered by /admin/:path*");

  // 3. reaches the Worker (/api/*) but outside the matcher: middleware is skipped
  r = await get("/api/hello"); assert.equal(r.status, 200); assert.equal(r.headers.get("x-gated"), null);
  await sleep(300);

  // 4. ordering: server/worker.ts root first, then the middleware; hello has no [mw] line
  const l = lines();
  const i = l.indexOf("worker /admin/secret.txt"); assert.ok(i >= 0 && l[i + 1] === "mw /admin/secret.txt", "root before middleware: " + l.join(" | "));
  assert.deepEqual(l.slice(-1), ["worker /api/hello"], "no middleware for /api/hello");
  assert.ok(!l.includes("mw /api/hello"));
  console.log("middleware e2e OK");
} finally {
  stop();
}
process.exit(0);

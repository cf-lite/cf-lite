// WP-DRAFT e2e: a root optional catch-all page must NOT make every static asset wake the Worker.
// Builds examples/site-catchall, runs it under local workerd (wrangler dev), and asserts from the Worker's own request log that
// public/ files, hashed assets and the prerendered page are answered by the assets layer while an unknown path reaches the catch-all.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-catchall/", import.meta.url).pathname;
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const rwf = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_catchall/wrangler.json"), "utf8")).assets.run_worker_first;
assert.ok(rwf.includes("/*") && rwf.includes("!/assets/*") && rwf.includes("!/robots.txt") && rwf.includes("!/img/*") && rwf.includes("!/about"), "negations generated: " + JSON.stringify(rwf));
assert.ok(rwf.length <= 100);

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 22100 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const get = async (p) => { const r = await fetch(`http://localhost:${port}${p}`); return { r, body: await r.text() }; };
  const asset = readdirSync(join(app, "dist/client/assets")).find((f) => f.endsWith(".js"));
  for (const [p, re] of [["/robots.txt", /user-agent/], ["/img/logo.txt", /png/], ["/about", /about/], ["/about/", /about/], [`/assets/${asset}`, /./]]) {
    const x = await get(p); assert.equal(x.r.status, 200, p); assert.match(x.body, re, p);
  }
  const hit = await get("/some/unknown/path"); assert.equal(hit.r.status, 200); assert.match(hit.body, /catch-all/);
  const root = await get("/"); assert.match(root.body, /catch-all/);
  // c.req.param("*") in the loader (optional catch-all): empty at the root, the joined segments below it
  const splat = (b) => /splat=\[(?:<!-- -->)?([^\]<]*)/.exec(b)?.[1];
  assert.equal(splat(root.body), "", "root splat: " + root.body);
  assert.equal(splat(hit.body), "some/unknown/path", "splat: " + hit.body);
  await sleep(500);
  const seen = [...log.matchAll(/\[worker\] (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(seen.sort(), ["/", "/some/unknown/path"], "only catch-all requests reach the Worker, saw " + JSON.stringify(seen));
  console.log("catch-all e2e OK: static assets never invoked the Worker");
} finally { stop(); }

// WP-ROUTE e2e under local workerd (examples/site-routes): route groups, optional catch-all, paths() prerender + dynamicParams,
// _not-found / _error / _loading boundaries with correct status codes, redirect()/notFound() sentinels, server/routes/** handlers.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-routes/", import.meta.url).pathname;
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const wj = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_routes/wrangler.json"), "utf8"));
const globs = [...wj.assets.run_worker_first];
for (const g of ["/docs", "/docs/*", "/feed.xml", "/og/*", "/news/*", "/x/boom", "/api/*"]) assert.ok(globs.includes(g), `run_worker_first has ${g}: ${globs}`);
assert.ok(!globs.includes("/blog/*") && !globs.includes("/pricing"), "static paths() pages never wake the Worker");
const C = (f) => join(app, "dist/client", f);
for (const f of ["blog/alpha/index.html", "blog/beta/index.html", "news/1/index.html", "pricing/index.html", "404.html"]) assert.ok(existsSync(C(f)), f + " emitted");
assert.ok(!existsSync(C("blog/gamma/index.html")));
assert.match(readFileSync(C("404.html"), "utf8"), /Custom not found/, "404.html is the rendered _not-found");
assert.match(readFileSync(C("blog/beta/index.html"), "utf8"), /Blog BETA/, "static loader data reaches head()");

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 20400 + Math.floor(Math.random() * 500);
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
  const hits = () => [...log.matchAll(/\[worker\] (\S+)/g)].map((m) => m[1]);
  const text = async (p) => { const r = await get(p); return [r.status, await r.text(), r]; };

  // route group: URL has no "(marketing)"; its layout wraps; static, so no Worker
  let [s, t] = await text("/pricing/"); assert.equal(s, 200); assert.match(t, /Pricing \(static, in a route group\)/); assert.match(t, /l-marketing/); assert.match(t, /l-root/);
  // paths(): prerendered, per-entry loader data, zero Worker hits
  [s, t] = await text("/blog/alpha/"); assert.equal(s, 200); assert.match(t, /Post.*alpha.*ALPHA/s);
  [s, t] = await text("/blog/beta/"); assert.equal(s, 200);
  await sleep(300);
  assert.deepEqual(hits(), [], "static pages must not invoke the Worker: " + hits());
  // unlisted param (dynamicParams default false) -> 404 page from assets
  [s, t] = await text("/blog/gamma/"); assert.equal(s, 404); assert.match(t, /Custom not found/);
  // dynamicParams = true: listed id from assets, unlisted id rendered by the Worker
  [s, t] = await text("/news/1/"); assert.equal(s, 200); assert.match(t, /News.*1/s);
  [s, t] = await text("/news/2"); assert.equal(s, 200); assert.match(t, /News.*2/s);

  // optional catch-all
  [s, t] = await text("/docs"); assert.equal(s, 200); assert.match(t, /docs:\[(<!-- -->)?\]/);
  [s, t] = await text("/docs/a/b/c"); assert.equal(s, 200); assert.match(t, /docs:\[(<!-- -->)?a\/b\/c(<!-- -->)?\]/);

  // boundaries + sentinels: status is correct because nothing has streamed yet
  [s, t] = await text("/x/ok"); assert.equal(s, 200); assert.match(t, /x ok/);
  [s, t] = await text("/x/missing"); assert.equal(s, 404); assert.match(t, /Custom not found/);
  [s, t] = await text("/x/boom"); assert.equal(s, 500); assert.match(t, /Something broke/); assert.match(t, /Internal Server Error/); assert.ok(!t.includes("secret stack detail"), "no error detail leaks in production");
  assert.match(t, /"digest"|digest/);
  let r = await get("/x/go"); assert.equal(r.status, 307); assert.equal(r.headers.get("location"), "/pricing");
  r = await get("/x/old"); assert.equal(r.status, 308); assert.equal(r.headers.get("location"), "/pricing");

  // server/routes/**: non-/api handlers
  r = await get("/feed.xml"); assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /rss/); assert.match(await r.text(), /<rss/);
  r = await get("/og/hello"); assert.equal(await r.text(), "og:hello");
  console.log("route e2e OK");
} finally {
  stop();
}

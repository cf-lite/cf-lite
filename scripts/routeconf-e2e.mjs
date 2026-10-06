// WP-ROUTECONF e2e under local workerd + vite dev: cfLite({ routeConf }) -> _redirects/_headers + Worker fallback.
// Builds a temp copy of examples/site-htmx with a routeConf, then asserts (built, wrangler dev): static/placeholder redirects and
// headers are served by the assets layer with NO Worker invocation; conditional redirects / rewrites reach the Worker only for their own
// glob; response headers also reach Worker-served responses. Then the same table under `vite dev`.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const src = new URL("../examples/site-htmx/", import.meta.url).pathname;
const dir = new URL(`../e2e/.tmp/routeconf-${process.pid}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler)([\\/]|$)/.test(p.slice(src.length)) });
const upstream = createServer((q, s) => { s.setHeader("x-up", "1"); s.end("upstream:" + q.url); });
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upPort = upstream.address().port;

writeFileSync(join(dir, "public/_redirects"), "/hand /written 302\n");
writeFileSync(join(dir, "server/worker.ts"), `import { Hono } from "hono";
import app from "../.cf-lite/app";
const root = new Hono<{ Bindings: Env }>();
root.use(async (c, next) => { console.log("[worker]", c.req.path); await next(); });
root.route("/", app);
root.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
export default root satisfies ExportedHandler<Env>;
`);
writeFileSync(join(dir, "vite.config.ts"), `import { defineConfig } from "vite";
import cfLite from "cf-lite/vite";
import { defineRouteConf } from "cf-lite/config";
export default defineConfig({ plugins: [cfLite({ routeConf: defineRouteConf({
  redirects: [
    { source: "/old", destination: "/new", status: 301 },
    { source: "/blog/:slug", destination: "/posts/:slug", status: 301 },
    { source: "/docs/:rest*", destination: "/guide/:rest*" },
    { source: "/app", destination: "/login", status: 307, missing: [{ type: "cookie", key: "sess" }] },
  ],
  rewrites: [
    { source: "/up/:path*", destination: "http://127.0.0.1:${upPort}/v1/:path*" },
    { source: "/m/:id", destination: "/api/hello", has: [{ type: "header", key: "user-agent", value: "Mobile.*", regex: true }] },
  ],
  headers: [{ source: "/:path*", headers: { "X-Frame-Options": "DENY" } }],
  security: { "X-Content-Type-Options": "nosniff" },
}) })] });
`);

const build = spawnSync(process.execPath, [join(src, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: dir, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const out = (f) => readFileSync(join(dir, "dist/client", f), "utf8");
const redirects = out("_redirects");
assert.match(redirects, /^\/old \/new 301$/m);
assert.match(redirects, /^\/blog\/:slug \/posts\/:slug 301$/m);
assert.match(redirects, /^\/docs\/\* \/guide\/:splat 308$/m);
assert.match(redirects, /^\/hand \/written 302$/m, "public/_redirects preserved");
assert.ok(redirects.indexOf("/old") < redirects.indexOf("/hand"), "generated rules first");
assert.doesNotMatch(redirects, /\/app|\/m\//, "conditional/rewrite rules are not in _redirects");
const headers = out("_headers");
assert.match(headers, /\/assets\/\*/); assert.match(headers, /X-Frame-Options: DENY/); assert.match(headers, /X-Content-Type-Options: nosniff/);
const wj = JSON.parse(readFileSync(join(dir, "dist/cf_lite_site_htmx/wrangler.json"), "utf8"));
assert.deepEqual([...wj.assets.run_worker_first].sort(), ["/api/*", "/app", "/m/*", "/up", "/up/*"].sort(), "only conditional + rewrite globs wake the Worker");

const require = createRequire(src);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(cmd, args, ready) {
  const child = spawn(process.execPath, [cmd, ...args], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
  const h = { log: "", child, stop: () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} } };
  child.stdout.on("data", (d) => (h.log += d)); child.stderr.on("data", (d) => (h.log += d));
  process.on("exit", h.stop);
  return h;
}
const until = async (h, re) => { for (let i = 0; i < 120 && !re.test(h.log); i++) await sleep(500); assert.match(h.log, re, "did not start:\n" + h.log.slice(-2000)); };
const lines = (h) => [...h.log.matchAll(/\[worker\] (\S+)/g)].map((m) => m[1]);

let wr, vt;
try {
  // ---- built, under workerd
  const pj = require.resolve("wrangler/package.json");
  const wbin = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
  const port = 19200 + Math.floor(Math.random() * 500);
  wr = start(wbin, ["dev", "--port", String(port), "--show-interactive-dev-session=false"]);
  await until(wr, /Ready on/);
  const B = `http://localhost:${port}`;
  const get = (p, h) => fetch(B + p, { redirect: "manual", headers: h });

  let r = await get("/old"); assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "/new");
  r = await get("/blog/hi"); assert.equal(r.status, 301); assert.equal(r.headers.get("location"), "/posts/hi");
  r = await get("/docs/a/b"); assert.equal(r.status, 308); assert.equal(r.headers.get("location"), "/guide/a/b");
  r = await get("/hand"); assert.equal(r.status, 302);
  r = await get("/"); assert.equal(r.status, 200); assert.equal(r.headers.get("x-frame-options"), "DENY"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  await sleep(300);
  assert.deepEqual(lines(wr), [], "assets-layer redirects/headers must not invoke the Worker; got " + lines(wr));

  r = await get("/app"); assert.equal(r.status, 307); assert.match(r.headers.get("location"), /\/login$/);
  r = await get("/app", { cookie: "sess=1" }); assert.notEqual(r.status, 307, "missing cookie condition");
  r = await get("/m/7", { "user-agent": "Mobile Safari" }); assert.equal(r.status, 200); assert.equal(await r.text(), "hello site", "internal rewrite");
  r = await get("/m/7", { "user-agent": "Desktop" }); assert.notEqual(await r.text(), "hello site", "no UA match -> no rewrite");
  r = await get("/up/a/b?q=1"); assert.equal(r.status, 200); assert.equal(await r.text(), "upstream:/v1/a/b?q=1"); assert.equal(r.headers.get("x-frame-options"), "DENY");
  r = await get("/api/hello"); assert.equal(r.status, 200); assert.equal(r.headers.get("x-frame-options"), "DENY", "Worker-served response gets the headers too"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  await sleep(300);
  const l = lines(wr);
  assert.ok(l.includes("/app") && l.includes("/m/7") && l.includes("/up/a/b") && l.includes("/api/hello"), "conditional globs reach the Worker: " + l);
  assert.ok(!l.some((p) => ["/old", "/blog/hi", "/hand", "/"].includes(p)), "static paths stayed off the Worker: " + l);
  wr.stop();

  // ---- vite dev applies the same table
  const vpj = require.resolve("vite/package.json");
  const vbin = join(dirname(vpj), JSON.parse(readFileSync(vpj, "utf8")).bin.vite);
  const dport = 19700 + Math.floor(Math.random() * 200);
  vt = start(vbin, ["dev", "--port", String(dport), "--strictPort"]);
  await until(vt, /Local:/);
  const D = `http://localhost:${dport}`;
  const dget = (p, h) => fetch(D + p, { redirect: "manual", headers: h });
  for (let i = 0; i < 60; i++) { try { if ((await dget("/api/hello")).status === 200) break; } catch {} await sleep(500); }
  r = await dget("/old"); assert.equal(r.status, 301); assert.match(r.headers.get("location"), /\/new$/);
  r = await dget("/blog/hi"); assert.match(r.headers.get("location"), /\/posts\/hi$/);
  r = await dget("/docs/a/b"); assert.match(r.headers.get("location"), /\/guide\/a\/b$/);
  r = await dget("/app"); assert.equal(r.status, 307);
  r = await dget("/app", { cookie: "sess=1" }); assert.notEqual(r.status, 307);
  r = await dget("/"); assert.equal(r.headers.get("x-frame-options"), "DENY");
  r = await dget("/m/7", { "user-agent": "Mobile Safari" }); assert.equal(await r.text(), "hello site");
  r = await dget("/up/x"); assert.equal(await r.text(), "upstream:/v1/x");
  r = await dget("/api/hello"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  console.log("routeconf e2e OK");
} finally {
  wr?.stop(); vt?.stop(); upstream.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);

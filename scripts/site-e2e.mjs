// One of the examples/site* apps (SITE=site|site-preact|site-vue|site-svelte, default site) under local workerd: static "/" beside
// SPA routes, nested layouts on spa/static/ssr, head, and which requests reach the Worker. The apps are the same app in four UI
// frameworks, so every adapter is held to the same assertions (scripts/run-sites.mjs runs them all).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const name = process.env.SITE ?? "site";
const site = new URL(`../examples/${name}/`, import.meta.url).pathname;
const require = createRequire(site);
const build = spawnSync(process.execPath, [join(site, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: site, encoding: "utf8", env: process.env });
assert.equal(build.status, 0, build.stdout + build.stderr);

const wj = JSON.parse(readFileSync(join(site, `dist/cf_lite_${name.replace(/^site-?/, "site_").replace(/_$/, "")}/wrangler.json`), "utf8"));
assert.equal(wj.assets.not_found_handling, "404-page", "static / => 404-page fallback");
assert.deepEqual([...wj.assets.run_worker_first].sort(), ["/api/*", "/blog/*"]);
for (const f of ["index.html", "404.html", "_shell.tpl", "about/index.html", "app/dashboard/index.html", "app/settings/index.html"]) assert.ok(existsSync(join(site, "dist/client", f)), f + " emitted");
const spaShell = readFileSync(join(site, "dist/client/_shell.tpl"), "utf8");
assert.equal(readFileSync(join(site, "dist/client/app/dashboard/index.html"), "utf8"), spaShell, "SPA route file = pristine shell");
assert.ok(readFileSync(join(site, "dist/client/index.html"), "utf8").includes("Home (static)"), "index.html is the prerendered static home");

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 19300 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: site, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);

try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await new Promise((r) => setTimeout(r, 500));
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const get = (p, init) => fetch(B + p, { redirect: "manual", ...init });
  const hits = () => [...log.matchAll(/\[worker\] (\S+)/g)].map((m) => m[1]);

  let r = await get("/"); let t = await r.text();
  assert.equal(r.status, 200); assert.match(t, /Home \(static\)/); assert.ok(!t.includes("<script"), "static / ships no JS");
  assert.match(t, /data-testid="l-root"/); assert.match(t, /<title[^>]*>Home — site<\/title>/);
  assert.equal((t.match(/name="description"/g) ?? []).length, 1); assert.match(t, /content="static home"/);

  r = await get("/app/dashboard/"); t = await r.text();
  assert.equal(r.status, 200); assert.ok(t.includes('type="module"'), "SPA shell carries the client bundle");
  r = await get("/app/settings/"); assert.equal(r.status, 200);
  r = await get("/about/"); assert.equal(r.status, 200); assert.match(await r.text(), /About \(static\)/);
  r = await get("/definitely/not/here", { headers: { "sec-fetch-mode": "navigate", accept: "text/html" } });
  assert.equal(r.status, 404, "unknown path is a real 404 (precedence: exact file > 404.html)");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(hits(), [], "no Worker invocation for static / spa / 404; got " + hits());

  r = await get("/blog/hello"); t = await r.text();
  assert.equal(r.status, 200);
  assert.match(t, /data-testid="l-root".*data-testid="l-blog".*Blog/s);
  assert.match(t, /<title[^>]*>hello — site blog<\/title>/); assert.match(t, /rel="canonical" href="https:\/\/example\.com\/blog\/hello"/);
  assert.ok(t.includes('type="module"'), "hydrate=true ssr page ships the bundle");
  r = await get("/api/hello"); assert.equal((await r.json()).message, "hello site");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(hits().sort(), ["/api/hello", "/blog/hello"]);
  const worker = readFileSync(join(site, `dist/cf_lite_${name.replace(/^site-?/, "site_").replace(/_$/, "")}/index.js`), "utf8");
  assert.ok(worker.split("\n").length < 400, "Worker bundle is minified");
  console.log(`site e2e OK (${name})`);
} finally {
  stop();
}
process.exit(0);

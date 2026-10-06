// Build the demo, run it under local workerd (wrangler dev), assert behaviour + which requests reach the Worker.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const demo = new URL("../examples/demo/", import.meta.url).pathname;
const require = createRequire(demo);
const build = spawnSync(process.execPath, [join(demo, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: demo, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const wj = JSON.parse(readFileSync(join(demo, "dist/cf_lite_demo/wrangler.json"), "utf8"));
assert.deepEqual([...wj.assets.run_worker_first].sort(), ["/api/*", "/cached-fn/*", "/cached/*", "/posts/*"], "run_worker_first scoped");

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 18700 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: demo, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
  const workerHits = () => [...log.matchAll(/\[worker\] (\S+)/g)].map((m) => m[1]);

  // 1. static routes never invoke the Worker
  let r = await get("/"); assert.equal(r.status, 200); assert.match(await r.text(), /id="root"/);
  r = await get("/about/"); assert.equal(r.status, 200);
  const about = await r.text();
  assert.match(about, /rendered once, at build time/);
  assert.match(about, /data-testid="layout-root"/, "static page wrapped in the root layout");
  assert.match(about, /<title[^>]*>About — cf-lite<\/title>/); assert.match(about, /<meta name="description" content="Prerendered at build time" data-cf-head>/);
  assert.ok(!about.includes("cf-lite demo\"></head>") && (about.match(/name="description"/g) ?? []).length === 1, "one description only (route head overrides layout head)"); assert.ok(!about.includes("<script"), "static page ships no JS");
  r = await get("/go/example"); assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "https://example.com/");
  r = await get("/counter"); assert.equal(r.status, 200); // SPA fallback
  r = await get("/assets/nope.js", { headers: { "sec-fetch-mode": "no-cors" } });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(workerHits(), [], "Worker must not run for static/redirect/SPA routes; got " + workerHits());

  // 2. API + SSR run the Worker
  r = await get("/api/hello?name=e2e"); assert.equal(r.status, 200);
  assert.equal((await r.json()).message, "hello e2e");
  r = await get("/posts/42"); assert.equal(r.status, 200);
  const ssr = await r.text();
  assert.match(ssr, /Post <!-- -->42/);
  assert.match(ssr, /data-testid="layout-root".*data-testid="layout-posts".*Post/s, "ssr page: root layout outside nested posts layout");
  assert.match(ssr, /<title[^>]*>Post 42 — cf-lite<\/title>/); assert.match(ssr, /<meta property="og:title" content="Post 42" data-cf-head>/);
  assert.match(ssr, /<link rel="canonical" href="https:\/\/demo\.example\.com\/posts\/42" data-cf-head>/); assert.ok(!ssr.includes("<script"), "ssr page without hydrate ships no JS");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(workerHits().sort(), ["/api/hello", "/posts/42"]);

  // 3. Durable Object WebSocket
  const msgs = await new Promise((res, rej) => {
    const out = []; const ws = new WebSocket(`ws://localhost:${port}/api/room/e2e`);
    ws.onopen = () => ws.send("ping"); ws.onmessage = (e) => { out.push(e.data); if (out.length === 2) { ws.close(); res(out); } };
    setTimeout(() => rej(new Error("ws timeout " + out)), 8000);
  });
  assert.deepEqual(msgs, ["welcome (1 connected)", "echo: ping"]);
  r = await get("/api/room/x"); assert.equal(r.status, 426);

  // 4. cron handler (workerd local scheduled trigger)
  r = await get("/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*"); assert.equal(r.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(log, /cron fired/);
  console.log("e2e OK");
} finally {
  stop();
}
process.exit(0);

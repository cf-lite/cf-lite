// WP-ISR e2e under local workerd: R2-stored HTML, revalidateTag -> queue -> regeneration, last-good-copy on failure,
// and a "two colo" check: a second wrangler dev process sharing the same persisted R2 serves the regenerated HTML
// written by the first (global consistency = the store is shared, not per-isolate).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-isr/", import.meta.url).pathname;
const require = createRequire(app);
const persist = join(app, ".wrangler/e2e-state");
rmSync(persist, { recursive: true, force: true });
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const stop = () => { for (const c of procs) try { process.kill(-c.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
async function start(port) {
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", persist, "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  procs.push(child);
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  return { base: `http://localhost:${port}`, log: () => log };
}
const page = async (a, id, headers = {}) => { const r = await fetch(`${a.base}/api/isr/page/${id}`, { headers }); return { r, st: r.headers.get("x-cf-lite-isr"), body: await r.text() }; };
const title = (b) => /<h1 id="t">([^<]*)/.exec(b)?.[1];
const until = async (what, fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - t < ms, "timeout: " + what); await sleep(300); } };

try {
  const base = 21000 + Math.floor(Math.random() * 500);
  const A = await start(base);
  const edit = (a, id, text) => fetch(`${a.base}/api/isr/edit/${id}`, { method: "POST", body: text });

  // 1. first request renders + stores; second is an R2 hit with the same timestamp
  await edit(A, "1", "First");
  let x = await page(A, "1"); assert.equal(x.st, "MISS"); assert.equal(title(x.body), "First");
  x = await until("HIT", async () => { const y = await page(A, "1"); return y.st === "HIT" ? y : null; });
  assert.match(x.r.headers.get("cache-control"), /s-maxage=300/);

  // 2. second "colo": separate process, same persisted R2 -> serves the stored HTML without rendering
  const B = await start(base + 1);
  const b1 = await page(B, "1"); assert.equal(b1.st, "HIT"); assert.equal(b1.body, x.body);

  // 3. edit content on A -> revalidateTag -> queue -> regenerated; B then serves the NEW html, no redeploy
  const er = await edit(A, "1", "Second"); assert.equal(er.status, 200);
  assert.equal((await er.json()).enqueued, 1);
  await until("regenerated HTML visible on B", async () => title((await page(B, "1")).body) === "Second");
  assert.equal(title((await page(A, "1")).body), "Second");

  // 4. failed regeneration keeps the last good copy: make the next render throw, revalidate, still serves "Second"
  await fetch(`${A.base}/api/isr/fail-next`, { method: "POST" });
  await edit(A, "1", "Third"); // regeneration consumes the failing render, retries later (retry delay 10s)
  for (let i = 0; i < 6; i++) { const y = await page(A, "1"); assert.ok(["Second", "Third"].includes(title(y.body)), "never an error page"); assert.equal(y.r.status, 200); await sleep(300); }
  await until("retry succeeded", async () => title((await page(B, "1")).body) === "Third", 60000);

  // 5. protected endpoint fails closed without a token configured
  const rv = await fetch(`${A.base}/api/isr/revalidate`, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: "{}" });
  assert.equal(rv.status, 503);

  // 6. authenticated requests bypass the store
  x = await page(A, "1", { cookie: "sso=abc" }); assert.equal(x.st, "BYPASS");
  console.log("isr e2e OK");
} finally { stop(); }

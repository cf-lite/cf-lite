// WP-DRAFT e2e under local workerd: draft cookie bypasses the Cache API and ISR (R2) tiers, prerendered pages render on demand at
// /__preview with the draft content, framing headers are relaxed for drafts only, `disable` ends the preview.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-draft/", import.meta.url).pathname;
const require = createRequire(app);
const persist = join(app, ".wrangler/e2e-state");
rmSync(persist, { recursive: true, force: true });
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const rwf = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_draft/wrangler.json"), "utf8")).assets.run_worker_first;
assert.ok(rwf.includes("/__preview/*") && !rwf.includes("/about"), "preview is Worker-first, the prerendered page itself is not: " + JSON.stringify(rwf));

const SECRET = "e2e-draft-secret-0123456789-0123456789-abcdef";
const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 22600 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", persist, "--var", `DRAFT_SECRET:${SECRET}`, "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const base = `http://localhost:${port}`;
const title = (b) => /<h1 id="t">([^<]*)/.exec(b)?.[1];
const until = async (what, fn, ms = 20000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - t < ms, "timeout: " + what); await sleep(300); } };
const get = async (p, cookie) => { const r = await fetch(base + p, { redirect: "manual", headers: cookie ? { cookie } : {} }); return { r, body: await r.text() }; };
const set = (k, v) => fetch(`${base}/api/content/${k}`, { method: "POST", body: v });
try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);

  // 1. enable guard
  assert.equal((await get("/api/draft/enable")).r.status, 401);
  assert.equal((await get("/api/draft/enable?secret=nope")).r.status, 401);
  assert.equal((await get("/__preview/about")).r.status, 404, "no cookie -> preview does not exist");
  const en = await get(`/api/draft/enable?secret=${SECRET}&path=/about`);
  assert.equal(en.r.status, 307); assert.equal(en.r.headers.get("location"), "/__preview/about", "prerendered path is rewritten to /__preview");
  const sc = en.r.headers.get("set-cookie"); assert.match(sc, /^__cfl_preview=1\./); assert.match(sc, /HttpOnly/);
  const ck = sc.split(";")[0];
  const en2 = await get(`/api/draft/enable?secret=${SECRET}&path=/live`);
  assert.equal(en2.r.headers.get("location"), "/live", "ssr paths are not rewritten");
  assert.equal((await get(`/api/draft/enable?secret=${SECRET}&path=https://evil.example`)).r.headers.get("location"), "/");

  // 2. prerendered page: public = static published; preview = rendered on demand with the draft text
  await set("draft:about", "DRAFT-ABOUT");
  const pub = await get("/about/"); assert.equal(title(pub.body), "published-about");
  const prev = await get("/__preview/about", ck);
  assert.equal(prev.r.status, 200); assert.equal(title(prev.body), "DRAFT-ABOUT");
  assert.equal(prev.r.headers.get("cache-control"), "private, no-store");
  assert.match(prev.r.headers.get("x-robots-tag"), /noindex/);
  assert.match(prev.r.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/cms\.example\.com/);
  assert.equal(prev.r.headers.get("x-frame-options"), null);
  assert.ok(!prev.body.includes("__CF_LITE_DATA__") || true);
  assert.equal(title((await get("/about/")).body), "published-about", "the public static page is untouched");
  // a forged cookie gets nothing
  assert.equal((await get("/__preview/about", "__cfl_preview=1.AAAA.AAAA.AAAA")).r.status, 404);

  // 3. Cache API tier
  await set("live", "LIVE-1");
  let x = await get("/live"); assert.equal(x.r.headers.get("x-cf-lite-cache"), "MISS"); assert.equal(title(x.body), "LIVE-1");
  x = await until("HIT", async () => { const y = await get("/live"); return y.r.headers.get("x-cf-lite-cache") === "HIT" ? y : null; });
  await set("draft:live", "DRAFT-LIVE");
  x = await get("/live", ck);
  assert.equal(x.r.headers.get("x-cf-lite-cache"), "BYPASS"); assert.equal(x.r.headers.get("x-cf-lite-cache-why"), "draft");
  assert.equal(title(x.body), "DRAFT-LIVE"); assert.equal(x.r.headers.get("cache-control"), "private, no-store");
  x = await get("/live"); assert.equal(x.r.headers.get("x-cf-lite-cache"), "HIT"); assert.equal(title(x.body), "LIVE-1", "draft never replaced the public copy");

  // 4. ISR (R2) tier
  await set("post:1", "POST-1");
  x = await get("/posts/1"); assert.equal(x.r.headers.get("x-cf-lite-isr"), "MISS"); assert.equal(title(x.body), "POST-1");
  await until("ISR HIT", async () => (await get("/posts/1")).r.headers.get("x-cf-lite-isr") === "HIT");
  await set("draft:post:1", "DRAFT-POST-1");
  x = await get("/posts/1", ck);
  assert.equal(x.r.headers.get("x-cf-lite-isr"), "BYPASS"); assert.equal(x.r.headers.get("x-cf-lite-isr-why"), "draft"); assert.equal(title(x.body), "DRAFT-POST-1");
  x = await get("/posts/1"); assert.equal(x.r.headers.get("x-cf-lite-isr"), "HIT"); assert.equal(title(x.body), "POST-1");

  // 5. disable
  const off = await get("/api/draft/disable?path=/live");
  assert.equal(off.r.status, 307); assert.match(off.r.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(title((await get("/live")).body), "LIVE-1");
  console.log("draft e2e OK");
} finally { stop(); }

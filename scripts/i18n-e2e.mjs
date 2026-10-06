// WP-I18N e2e under local workerd: examples/site-i18n (static pages per locale via paths(), one SSR page, dynamic sitemap).
// Asserts: `/` redirects by Accept-Language / cookie / country / default; ONLY `/` and unprefixed localized paths reach the Worker
// (prefixed static pages are served by the assets layer: no "[worker]" log line); hreflang + <html lang>; catalog fallback to the default
// locale; SSR page under [locale]; unknown locale prefix 404; sitemap alternates; run_worker_first is a narrow glob set.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const app = join(root, "examples/site-i18n/");
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(root, "packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8", env: { ...process.env, SITE_URL: "https://i18n.example.com" } });
assert.equal(build.status, 0, build.stdout + build.stderr);
const cfg = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_i18n/wrangler.json"), "utf8"));
assert.deepEqual(cfg.assets.run_worker_first, ["/", "/about", "/en/posts/*", "/posts/*", "/sitemap-*.xml", "/sitemap.xml", "/vi/posts/*"], "narrow Worker-first set (no /*)");

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 19700 + Math.floor(Math.random() * 300);
const child = spawn(process.execPath, [wr, "dev", "-c", join(app, "dist/cf_lite_site_i18n/wrangler.json"), "--port", String(port), "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 240 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const get = (path, headers = {}) => fetch(B + path, { redirect: "manual", headers });
  const hits = async (path, headers) => { const before = log.length; const r = await get(path, headers); await sleep(300); return { r, worker: log.slice(before).includes(`[worker] ${new URL(B + path).pathname}`) }; };

  // detection: only on `/`
  let x = await hits("/", { "accept-language": "vi-VN,vi;q=0.9,en;q=0.8" });
  assert.equal(x.r.status, 307); assert.equal(x.r.headers.get("location"), "/vi/"); assert.match(x.r.headers.get("vary"), /Accept-Language/); assert.ok(x.worker, "/ reaches the Worker");
  assert.equal((await get("/", { "accept-language": "en-US,en;q=0.9" })).headers.get("location"), "/en/");
  assert.equal((await get("/", { "accept-language": "fr" })).headers.get("location"), "/en/", "no match -> default locale");
  assert.equal((await get("/")).headers.get("location"), "/en/");
  assert.equal((await get("/", { "accept-language": "en", cookie: "locale=vi" })).headers.get("location"), "/vi/", "cookie beats Accept-Language");
  assert.equal((await get("/?utm=1", { "accept-language": "vi" })).headers.get("location"), "/vi/?utm=1", "query kept");
  // unprefixed localized paths redirect too (static-only app: they are Worker-first globs, nothing else is)
  x = await hits("/about", { "accept-language": "vi" });
  assert.equal(x.r.status, 307); assert.equal(x.r.headers.get("location"), "/vi/about"); assert.ok(x.worker);
  assert.equal((await get("/posts/hello", { "accept-language": "vi" })).headers.get("location"), "/vi/posts/hello");

  // prefixed static pages: served by the assets layer, the Worker is NOT invoked
  for (const p of ["/en/", "/vi/", "/en/about/", "/vi/about/"]) {
    const y = await hits(p);
    assert.equal(y.r.status, 200, `${p} -> ${y.r.status}`); assert.equal(y.worker, false, `${p} must not reach the Worker`);
  }
  let html = await (await get("/vi/about/")).text();
  assert.match(html, /<html lang="vi">/);
  assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/i18n\.example\.com\/en\/about"/);
  assert.match(html, /<link rel="alternate" hreflang="vi" href="https:\/\/i18n\.example\.com\/vi\/about"/);
  assert.match(html, /hreflang="x-default" href="https:\/\/i18n\.example\.com\/en\/about"/);
  assert.match(html, /data-testid="note">This note only exists in English\./, "missing vi key falls back to the default locale");
  html = await (await get("/vi/")).text();
  assert.match(html, /<title[^>]*>Xin chào<\/title>/); assert.match(html, /3 mục/); assert.match(html, /Chào mừng, cf-lite!/);
  html = await (await get("/en/")).text();
  assert.match(html, /<html lang="en">/); assert.match(html, />3 items</);

  // SSR page under [locale] (per-locale Worker-first globs), with the same lang/hreflang from the request path
  x = await hits("/vi/posts/hello");
  assert.equal(x.r.status, 200); assert.ok(x.worker);
  assert.equal(x.r.headers.get("content-language"), "vi");
  html = await x.r.text();
  assert.match(html, /<html lang="vi">/); assert.match(html, /Bài viết: hello/);
  assert.match(html, /hreflang="en" href="https:\/\/i18n\.example\.com\/en\/posts\/hello"/);
  assert.match(await (await get("/en/posts/hello")).text(), /Post: hello/);
  // unknown prefix: never rendered with locale "xx"
  assert.equal((await get("/xx/posts/hello")).status, 404);

  // sitemap: per-locale entries with alternates
  const xml = await (await get("/sitemap.xml")).text();
  assert.match(xml, /xmlns:xhtml/);
  assert.match(xml, /<loc>https:\/\/i18n\.example\.com\/vi\/about<\/loc>/);
  assert.match(xml, /<xhtml:link rel="alternate" hreflang="en" href="https:\/\/i18n\.example\.com\/en\/about"\/>/);
  assert.match(xml, /hreflang="x-default" href="https:\/\/i18n\.example\.com\/en\/about"/);
  console.log("i18n e2e ok");
} finally {
  stop();
}

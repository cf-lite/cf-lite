// WP-IMAGES e2e under local workerd (real IMAGES binding): format negotiation, cache HIT on 2nd call, allow-list / whitelist rejection.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-images/", import.meta.url).pathname;
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const wj = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_images/wrangler.json"), "utf8"));
assert.ok(wj.assets.run_worker_first.includes("/_img"), "/_img is Worker-first");

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
  const img = (src, w, accept = "*/*", q = "") => fetch(`${B}/_img?src=${encodeURIComponent(src)}&w=${w}${q}`, { headers: { accept } });
  const A = "image/avif,image/webp,*/*";

  let r = await img("/img/hero.png", 640, A);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/avif"); assert.equal(r.headers.get("x-cf-lite-image"), "MISS");
  const first = Buffer.from(await r.arrayBuffer()); assert.ok(first.length > 100 && first.length < 20000, "resized+compressed: " + first.length);
  r = await img("/img/hero.png", 640, A);
  assert.equal(r.headers.get("x-cf-lite-image"), "HIT", "second call is served from the Cache API");
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(first));
  r = await img("/img/hero.png", 640, "image/webp,*/*"); assert.equal(r.headers.get("content-type"), "image/webp");
  r = await img("/img/hero.png", 640, "*/*"); assert.equal(r.headers.get("content-type"), "image/png");

  // whitelist + SSRF guard
  assert.equal((await img("/img/hero.png", 641)).status, 400, "width not in whitelist");
  assert.equal((await img("/img/hero.png", 640, "*/*", "&q=50")).status, 400, "quality not in whitelist");
  assert.equal((await img("https://evil.example.com/a.png", 640)).status, 403, "host not allow-listed");
  assert.equal((await img("http://169.254.169.254/latest/meta-data", 640)).status, 400);
  assert.equal((await img("/../wrangler.jsonc", 640)).status, 400);
  assert.equal((await img("/nope.png", 640)).status, 415, "SPA fallback serves index.html for a missing file: not an image, refused");

  // SSR page: dimensions + srcset, preload for the priority image
  const html = await (await fetch(B + "/")).text();
  assert.match(html, /<img[^>]*data-testid="hero"[^>]*width="1600"[^>]*height="800"/);
  assert.match(html, /srcSet="\/_img\?src=%2Fimg%2Fhero\.png&amp;w=320&amp;q=75 320w/);
  assert.match(html, /<img[^>]*data-testid="lazy"[^>]*loading="lazy"/);
  console.log("images e2e OK");
} finally {
  stop();
}
process.exit(0);

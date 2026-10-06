// WP-METADATA e2e under local workerd: site-blog (app Worker) + og-worker (satori + resvg-wasm) wired through the OG service binding.
// Asserts: dynamic sitemap/robots/manifest, preview-host noindex, OG PNG is 1200x630 with a byte-stable hash, 2nd request = Cache HIT.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const app = join(root, "examples/site-blog/");
const og = join(root, "packages/cf-lite/og-worker/");
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(root, "packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 19200 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [wr, "dev", "-c", join(app, "dist/cf_lite_site_blog/wrangler.json"), "-c", join(og, "wrangler.jsonc"), "--port", String(port), "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 240 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const sha = (b) => createHash("sha256").update(b).digest("hex");

  // sitemap (dynamic, edge cached)
  let r = await fetch(B + "/sitemap.xml");
  assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /application\/xml/);
  assert.equal(r.headers.get("x-cf-lite-sitemap"), "MISS");
  const xml = await r.text();
  assert.match(xml, /<loc>https:\/\/blog\.example\.com\/posts\/og-images<\/loc><lastmod>2026-09-10<\/lastmod>/);
  assert.ok(r.headers.get("last-modified"));
  r = await fetch(B + "/sitemap.xml"); assert.equal(r.headers.get("x-cf-lite-sitemap"), "HIT", "second sitemap request is an edge-cache hit");

  // robots + manifest + preview noindex (localhost is not a preview host)
  r = await fetch(B + "/robots.txt"); const robots = await r.text();
  assert.match(robots, /Disallow: \/api\//); assert.match(robots, /Sitemap: https:\/\/blog\.example\.com\/sitemap\.xml/);
  assert.equal(r.headers.get("x-robots-tag"), null);
  r = await fetch(B + "/manifest.webmanifest"); assert.equal((await r.json()).name, "cf-lite blog");

  // head sugar (SSR): canonical, og:*, twitter:*, json-ld, zero JS needed
  r = await fetch(B + "/posts/hello"); const html = await r.text();
  assert.match(html, /<link rel="canonical" href="https:\/\/blog\.example\.com\/posts\/hello"/);
  assert.match(html, /property="og:image" content="https:\/\/blog\.example\.com\/posts\/hello\/opengraph-image\.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /<script type="application\/ld\+json">[^<]*"BlogPosting"/);

  // OG image: PNG 1200x630, cached, byte-stable
  r = await fetch(B + "/posts/hello/opengraph-image.png");
  assert.equal(r.status, 200, await r.clone().text()); assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-cf-lite-og"), "MISS");
  const png = Buffer.from(await r.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
  const hash = r.headers.get("x-cf-lite-og-hash");
  await sleep(300);
  r = await fetch(B + "/posts/hello/opengraph-image.png");
  assert.equal(r.headers.get("x-cf-lite-og"), "HIT", "second OG request is served from the Cache API");
  assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(png));
  // different params -> different input hash and a different image
  r = await fetch(B + "/posts/og-images/opengraph-image.png");
  assert.notEqual(r.headers.get("x-cf-lite-og-hash"), hash);
  const other = Buffer.from(await r.arrayBuffer()); assert.notEqual(sha(other), sha(png));
  // byte-stable across renders: bypass the cache with a distinct query (same tree) and compare
  r = await fetch(B + "/posts/hello/opengraph-image.png?v=1");
  assert.equal(r.headers.get("x-cf-lite-og"), "MISS"); assert.match(r.headers.get("cache-control"), /immutable/);
  assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(png), "fixed input renders to identical bytes");
  console.log("metadata e2e ok; og png sha256", sha(png).slice(0, 16), png.length, "bytes");
} finally {
  stop();
}

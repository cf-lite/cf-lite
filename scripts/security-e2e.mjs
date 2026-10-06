// WP-SECURITY e2e under local workerd (examples/site-security): static `_headers` CSP (hashes), SSR nonce CSP, base headers on API,
// rate limiting (memory fallback + Durable Object exact limiter) with 429 + Retry-After.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-security/", import.meta.url).pathname;
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const hdrs = readFileSync(join(app, "dist/client/_headers"), "utf8");
assert.match(hdrs, /Content-Security-Policy: .*script-src 'self' 'sha256-/);
assert.ok(!/script-src[^;]*unsafe-inline/.test(hdrs), "no unsafe-inline for scripts");

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 21500 + Math.floor(Math.random() * 500);
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

  // -------- static page: assets layer serves the hash policy + base headers, no Worker involved
  let r = await fetch(B + "/"); let t = await r.text();
  const csp = r.headers.get("content-security-policy");
  assert.ok(csp, "static CSP header"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const inline = [...t.matchAll(/<script>([^<]*)<\/script>/g)];
  assert.ok(inline.length >= 1, "static hydrated page has an inline data script");
  const { createHash } = await import("node:crypto");
  for (const m of inline) assert.ok(csp.includes(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`), "inline script hash is in the policy");

  // -------- SSR page: per-request nonce, on the header and on every inline script; differs between requests
  r = await fetch(B + "/ssr"); t = await r.text();
  const c1 = r.headers.get("content-security-policy"); const n1 = /'nonce-([^']+)'/.exec(c1)?.[1];
  assert.ok(n1, "SSR CSP carries a nonce: " + c1); assert.ok(!/script-src[^;]*unsafe-inline/.test(c1));
  assert.match(t, new RegExp(`<script nonce="${n1.replace(/[+/=]/g, "\\$&")}">window.__CF_LITE_DATA__`));
  for (const m of t.matchAll(/<script\b([^>]*)>/g)) if (!/\bsrc=/.test(m[1])) assert.match(m[1], /nonce=/, "every inline script has a nonce");
  assert.ok(!/<script(?![^>]*nonce)[^>]*>(?!<\/script>)/.test(t.replace(/<script[^>]*src=[^>]*><\/script>/g, "")), "no bare inline script");
  const r2 = await fetch(B + "/ssr"); await r2.text();
  assert.notEqual(/'nonce-([^']+)'/.exec(r2.headers.get("content-security-policy"))?.[1], n1, "nonce is per request");
  assert.equal(r.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  // the router ignores empty segments and percent-decodes, so these variants reach the same page: the matcher guard must still run
  for (const v of ["/ssr/", "//ssr", "/%73sr"]) {
    const rv = await fetch(B + v, { redirect: "manual" }); await rv.text();
    if (rv.status === 200) assert.match(rv.headers.get("content-security-policy") ?? "", /'nonce-/, `matcher guard skipped for ${v}`);
  }

  // -------- API: base headers, no CSP on JSON
  r = await fetch(B + "/api/limited/soft"); assert.equal(r.status, 200); await r.text();
  assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.equal(r.headers.get("content-security-policy"), null);

  // -------- rate limit: memory fallback (3 / 60 s)
  for (let i = 0; i < 2; i++) { r = await fetch(B + "/api/limited/soft"); assert.equal(r.status, 200); await r.text(); }
  r = await fetch(B + "/api/limited/soft"); assert.equal(r.status, 429); await r.text();
  assert.ok(Number(r.headers.get("retry-after")) >= 1 && Number(r.headers.get("retry-after")) <= 60, "Retry-After seconds");

  // -------- Durable Object exact limiter (2 / 60 s per key), keys independent
  for (const who of ["a", "b"]) {
    for (let i = 0; i < 2; i++) { r = await fetch(B + `/api/limited/exact?who=${who}`); assert.equal(r.status, 200, `${who} #${i}`); await r.text(); }
    r = await fetch(B + `/api/limited/exact?who=${who}`); assert.equal(r.status, 429, `${who} over`); assert.ok(r.headers.get("retry-after")); await r.text();
  }
  console.log("security e2e OK");
} catch (e) { console.error("--- wrangler log ---\n" + log.slice(-4000)); throw e; } finally { stop(); }

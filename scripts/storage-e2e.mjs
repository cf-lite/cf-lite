// (The cap is lowered via a var and the oversize body kept tiny: replying early to a multi-MiB body makes miniflare's dev proxy drop the connection - a dev-proxy artefact; the 413 paths are covered in test/storage-workerd.test.ts.)
// Storage example (examples/site-uploads) under local workerd: `cf-lite db apply`, streamed upload with limits,
// Range/ETag serving, D1 session list, presign without secrets (501). Local only - no account, no remote.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import http from "node:http";

const ex = new URL("../examples/site-uploads/", import.meta.url).pathname;
const cli = join(ex, "../../packages/cf-lite/dist/cli.js");
const require = createRequire(ex);
const sh = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: ex, encoding: "utf8" });
let r = sh(["build"]); assert.equal(r.status, 0, r.stdout + r.stderr);
const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const state = mkdtempSync(join(tmpdir(), "cfl-storage-e2e-"));

r = sh(["db", "apply", "--persist-to", state]); assert.equal(r.status, 0, "db apply: " + r.stdout + r.stderr);
r = sh(["db", "apply", "--persist-to", state]); assert.equal(r.status, 0); assert.match(r.stdout + r.stderr, /No migrations to apply/i, "second apply is a no-op");
r = sh(["db", "apply", "--remote"]); assert.notEqual(r.status, 0, "remote apply must be refused without --yes"); assert.match(r.stderr, /--yes/);

const port = 19200 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", state, "--var", "MAX_UPLOAD_BYTES:1000", "--show-interactive-dev-session=false"], { cwd: ex, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
// PUT over a fresh connection per request (agent:false). Early replies to an unread body poison a pooled keep-alive
// connection in miniflare's dev proxy (dev-only artefact), so the rejection cases must not share one.
const put = (url, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "PUT", agent: false, headers: { ...headers, "content-length": body.length, connection: "close" } }, (res) => {
    let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve({ status: res.statusCode, text: async () => t }));
  });
  req.on("error", reject); req.end(body);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(64).keys()]);

  let res = await put(`${B}/api/files/pic.png`, PNG, { "content-type": "image/png" });
  assert.equal(res.status, 201, await res.text());
  res = await put(`${B}/api/files/evil.png`, "<script>1</script>", { "content-type": "image/png", connection: "close" });
  assert.equal(res.status, 415, "content that is not a PNG is refused");
  res = await put(`${B}/api/files/x.html`, "<b>", { "content-type": "text/html", connection: "close" });
  assert.equal(res.status, 415, "type not on the allow-list: " + (await res.text()).slice(0, 500));

  res = await fetch(`${B}/api/files/pic.png/raw`, { headers: { range: "bytes=8-15" } });
  assert.equal(res.status, 206); assert.equal(res.headers.get("content-range"), `bytes 8-15/${PNG.length}`);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG.slice(8, 16)]);
  const etag = (await fetch(`${B}/api/files/pic.png/raw`)).headers.get("etag");
  assert.equal((await fetch(`${B}/api/files/pic.png/raw`, { headers: { "if-none-match": etag } })).status, 304);
  assert.equal((await fetch(`${B}/api/files/nope/raw`)).status, 404);

  const rows = await (await fetch(`${B}/api/files`)).json();
  assert.deepEqual(rows.map((x) => x.key), ["u/pic.png"], "only the accepted upload is recorded");
  assert.equal((await fetch(`${B}/api/files/pic.png/presign`, { method: "POST" })).status, 501, "presign is off without R2_* secrets");
  // last on purpose: an early 413 to an unread body leaves miniflare's dev proxy in a bad state for the next request (dev-only)
  res = await put(`${B}/api/files/big.pdf`, new Uint8Array(5000), { "content-type": "application/pdf", connection: "close" });
  assert.equal(res.status, 413, "over the cap");
  console.log("storage e2e OK");
} finally { stop(); rmSync(state, { recursive: true, force: true }); }

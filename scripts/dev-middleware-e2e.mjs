// Dev parity for server/middleware.ts: the gate behaves as in the built Worker, and editing `config.matcher` regenerates + restarts.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const src = new URL("../examples/site-gated/", import.meta.url).pathname;
const dir = new URL(`../e2e/.tmp/devmw-${process.pid}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler)([\\/]|$)/.test(p.slice(src.length)) });
const pj = createRequire(src).resolve("vite/package.json");
const vitebin = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.vite);
const port = 19400 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [vitebin, "dev", "--port", String(port), "--strictPort"], { cwd: dir, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", () => { stop(); rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 40000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timeout: " + what + "\n" + log.slice(-2500)); await sleep(300); } };
const get = (p, h) => fetch(`http://localhost:${port}${p}`, { headers: h, redirect: "manual" });

try {
  await waitFor(() => /Local:/.test(log), "vite dev start");
  await waitFor(async () => (await get("/api/hello")).status === 200, "worker up");
  assert.equal((await get("/api/private")).status, 401, "gate closed in dev");
  assert.equal((await get("/api/private", { cookie: "sess=ok" })).status, 200);
  assert.equal((await get("/api/hello")).headers.get("x-gated"), null, "outside matcher: no middleware");

  // widen the matcher: /api/hello (already Worker-first via /api/*) and /pricing (new glob -> routing changed -> restart)
  const f = join(dir, "server/middleware.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace('"/api/private/:path*"', '"/api/private/:path*", "/api/hello", "/pricing"'));
  await waitFor(async () => (await get("/api/hello")).status === 401 && (await get("/pricing")).status === 401, "matcher edit takes effect");
  assert.match(log, /routing changed/);
  console.log("dev middleware e2e OK");
} finally { stop(); }
process.exit(0);

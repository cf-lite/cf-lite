#!/usr/bin/env node
// Usage: node measure.mjs <app> [--runs N]   (app = cf-lite | vinext | next-opennext)
// Copies bench/apps/<app> to bench/work/<app>, installs, builds (timed), measures bundle/client JS,
// serves under LOCAL workerd (never deployed) and measures latency. Writes bench/results/<app>.json.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const app = process.argv[2];
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 3;
const N = Number(process.env.BENCH_REQS ?? 3000);
const port = { "cf-lite": 18801, vinext: 18802, "next-opennext": 18803, "bare-vite": 18804, "bare-wrangler": 18805, "cf-lite-wrangler": 18806, "cf-lite-ssr": 18807, "cf-lite-ssr-preact": 18808 }[app];
// variant -> source dir / framework kind. "bare-*" = control Worker (no framework) to expose the local launcher's latency floor.
const kind = { "bare-vite": "bare-worker", "bare-wrangler": "bare-worker", "cf-lite-wrangler": "cf-lite", "cf-lite-ssr-preact": "cf-lite-ssr" }[app] ?? app;
const isCfLite = kind.startsWith("cf-lite");
const appEnv = app.endsWith("-preact") ? { CF_LITE_RENDERER: "preact" } : {};
const WRANGLER = "npx wrangler dev --port PORT";
if (!port) throw new Error("unknown app " + app);

const src = join(here, "apps", kind), work = join(here, "work", app);
const sh = (cmd, opts = {}) => spawnSync("bash", ["-lc", cmd], { cwd: work, encoding: "utf8", ...opts });
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

const cfg = {
  "bare-vite": { outputs: ["dist", ".wrangler"], serve: "npx vite preview --port PORT --strictPort" },
  "bare-wrangler": { outputs: ["dist", ".wrangler"], serve: WRANGLER },
  "cf-lite-wrangler": { outputs: ["dist", ".cf-lite", ".wrangler"], serve: WRANGLER },
  "cf-lite": { outputs: ["dist", ".cf-lite", ".wrangler"], serve: "npx vite preview --port PORT --strictPort", ready: /localhost:\d+|Local:/ },
  "cf-lite-ssr": { outputs: ["dist", ".cf-lite", ".wrangler"], serve: "npx vite preview --port PORT --strictPort" },
  "cf-lite-ssr-preact": { outputs: ["dist", ".cf-lite", ".wrangler"], serve: "npx vite preview --port PORT --strictPort" },
  vinext: { outputs: ["dist", ".cloudflare", ".vite", "node_modules/.vite"], serve: "npx vite preview --port PORT --strictPort", ready: /localhost:\d+|Local:/ },
  "next-opennext": { outputs: [".next", ".open-next", ".wrangler"], serve: "npx wrangler dev --port PORT", ready: /Ready on/ },
}[app];

const result = { app, node: process.version, cpus: os.cpus().length, cpuModel: os.cpus()[0].model, date: new Date().toISOString(), notes: [] };
function done() { mkdirSync(join(here, "results"), { recursive: true }); writeFileSync(join(here, "results", app + ".json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); }

// ---- 1. install
rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
cpSync(src, work, { recursive: true });
let t = Date.now();
let r;
if (isCfLite) {
  const pk = spawnSync("npm", ["pack", "--pack-destination", join(here, "work"), "-w", "cf-lite", "-w", "@cf-lite/react", "-w", "@cf-lite/preact", "--silent"], { cwd: join(here, ".."), encoding: "utf8" });
  const tgz = pk.stdout.trim().split("\n").filter(Boolean).map((f) => join(here, "work", f)).join(" ");
  r = sh(`npm install --no-audit --no-fund ${tgz} 2>&1 | tail -3 && npm install --no-audit --no-fund 2>&1 | tail -3`);
} else r = sh("npm install --no-audit --no-fund 2>&1 | tail -3");
result.installSeconds = (Date.now() - t) / 1000;
if (!existsSync(join(work, "node_modules"))) { result.buildFailed = "install failed: " + r.stdout; done(); process.exit(0); }

// ---- 2. build (timed; outputs removed between runs = cold-ish: no vite/next cache, deps already installed)
const times = []; let lastBuild;
for (let i = 0; i < runs; i++) {
  for (const o of cfg.outputs) rmSync(join(work, o), { recursive: true, force: true });
  t = Date.now();
  lastBuild = sh(app === "next-opennext" ? "npx opennextjs-cloudflare build 2>&1" : "npm run build 2>&1", { timeout: 900_000, maxBuffer: 1 << 28, env: { ...process.env, ...appEnv, NEXT_TELEMETRY_DISABLED: "1", CI: "1" } });
  times.push((Date.now() - t) / 1000);
  if (lastBuild.status !== 0) { result.buildFailed = `exit ${lastBuild.status}: ` + lastBuild.stdout.split("\n").slice(-25).join("\n"); result.buildSeconds = times; done(); process.exit(0); }
}
result.buildSeconds = times; result.buildMedianSeconds = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];

// ---- 3. Worker bundle size: wrangler's own bundler where applicable, plus raw gzip of shipped worker files
const fileStats = (files) => ({ files: files.length, raw: files.reduce((s, f) => s + statSync(f).size, 0), gzip: files.reduce((s, f) => s + gz(readFileSync(f)), 0) });
if (isCfLite || kind === "bare-worker") {
  const wd = readdirSync(join(work, "dist")).find((d) => d !== "client");
  result.worker = fileStats([join(work, "dist", wd, "index.js")]); // single esbuilt/rolldown file, already the deployable
  result.assetsDir = "dist/client";
} else if (app === "vinext") {
  const d = join(work, ".cloudflare/output/v0/workers/default/bundle");
  result.worker = fileStats(walk(d).filter((f) => /\.(js|mjs|json)$/.test(f) && !f.includes("/.vite/")));
  result.assetsDir = ".cloudflare/output/v0/workers/default/assets";
} else {
  const out = join(work, ".wrangler-dryrun");
  const dr = sh(`npx wrangler deploy --dry-run --outdir ${out} 2>&1`);
  const m = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(dr.stdout);
  if (existsSync(out)) result.worker = fileStats(walk(out).filter((f) => /\.(js|mjs|wasm)$/.test(f)));
  if (m) result.wranglerDryRun = { uploadKiB: +m[1], gzipKiB: +m[2] };
  result.assetsDir = ".open-next/assets";
}
const assets = join(work, result.assetsDir);
result.staticAssets = existsSync(assets) ? fileStats(walk(assets)) : null;

// ---- 4. serve under local workerd
const serveCmd = cfg.serve.replace("PORT", port);
const child = spawn("bash", ["-lc", "exec " + serveCmd], { cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...appEnv, CI: "1" } });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const leaked = () => spawnSync("bash", ["-c", `ps -eo pid,args | grep "workerd" | grep "work/${app}/node_modules" | grep -v grep | awk '{print $1}'`], { encoding: "utf8" }).stdout.split(/\s+/).filter(Boolean).map(Number);
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} for (const p of leaked()) try { process.kill(p, "SIGTERM"); } catch {} };
process.on("exit", stop); process.on("SIGINT", () => { stop(); process.exit(1); });
const B = `http://localhost:${port}`;
try {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await fetch(B + "/api/hello", { redirect: "manual" }); up = true; } catch {}
    if (child.exitCode != null) break;
  }
  if (!up) { result.serveFailed = log.split("\n").slice(-20).join("\n"); done(); process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000));

  // ---- 5. client JS on the content page (what a browser must download & run, gzip = transfer size)
  const content = isCfLite ? "/about/" : "/about"; // assets layer canonicalises /about -> /about/ (auto-trailing-slash)
  const res = await fetch(B + content, { headers: { "accept-encoding": "identity" } });
  const html = await res.text();
  const srcs = new Set([...html.matchAll(/<(?:script|link)[^>]*?(?:src|href)="([^"]+\.js[^"]*)"/g)].map((m) => m[1]));
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let ext = 0, extRaw = 0;
  for (const s of srcs) { const b = Buffer.from(await (await fetch(new URL(s, B + content))).arrayBuffer()); ext += gz(b); extRaw += b.length; }
  const inl = inline.reduce((s, x) => s + Buffer.byteLength(x), 0);
  result.contentPage = { htmlBytes: Buffer.byteLength(html), htmlGzip: gz(Buffer.from(html)), jsFiles: srcs.size, jsGzip: ext, jsRaw: extRaw, inlineScripts: inline.length, inlineScriptBytes: inl, totalJsGzip: ext + gz(Buffer.from(inline.join("\n"))) };

  // ---- 6. latency (same-host loopback; server and client compete for the same CPUs, see README caveats)
  const routes = { redirect: "/go/example", api: "/api/hello", content: content, ...(kind === "cf-lite-ssr" ? { ssr: "/posts/7" } : {}) };
  result.latencyMs = {}; result.requests = N;
  for (const [name, path] of Object.entries(routes)) {
    const hit = () => fetch(B + path, { redirect: "manual" }).then((r) => r.arrayBuffer().then(() => r.status));
    for (let i = 0; i < 200; i++) await hit();
    const lat = []; let status;
    for (let i = 0; i < N; i++) { const s = performance.now(); status = await hit(); lat.push(performance.now() - s); }
    lat.sort((a, b) => a - b);
    const C = 16, per = Math.ceil(N / C); const ts = performance.now();
    await Promise.all(Array.from({ length: C }, async () => { for (let i = 0; i < per; i++) await hit(); }));
    const rps = (per * C) / ((performance.now() - ts) / 1000);
    result.latencyMs[name] = { status, p50: +pct(lat, 50).toFixed(3), p95: +pct(lat, 95).toFixed(3), p99: +pct(lat, 99).toFixed(3), rpsC16: Math.round(rps) };
  }
} finally { stop(); }
done();
process.exit(0);

// RSC vs SSR vs vinext on the same page, local workerd (vite preview). Same method family as bench/methodology.md.
// usage: node bench/rsc-bench.mjs <cf-lite-app-dir> <vinext-app-dir> [n=300]
// Wall time includes the ~15 ms local launcher floor (see methodology.md caveat 1): compare deltas, not absolutes.
// CPU = utime+stime of the workerd process(es) under the launcher, sampled around batches of 50 requests (/proc, 10 ms ticks):
// per-batch mean ms/request, so p50/p95 are over batch means, not single requests.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
const [cfDir, vxDir, N = "300"] = process.argv.slice(2), n = +N;
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const gz = (b) => gzipSync(b, { level: 9 }).length;
const size = (files) => ({ files: files.length, raw: files.reduce((s, f) => s + statSync(f).size, 0), gzip: files.reduce((s, f) => s + gz(readFileSync(f)), 0) });
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };

const servers = [];
const start = (dir, port) => {
  const child = spawn(process.execPath, [join(process.cwd(), "node_modules/vite/bin/vite.js"), "preview", "--port", String(port), "--strictPort"], { cwd: dir, detached: true, stdio: "ignore" });
  servers.push(child.pid); console.error("started vite preview pid", child.pid, "port", port); return child.pid;
};
const kids = (pid) => { const out = []; const stack = [pid]; while (stack.length) { const p = stack.pop(); try { for (const c of readFileSync(`/proc/${p}/task/${p}/children`, "utf8").split(/\s+/).filter(Boolean)) { out.push(+c); stack.push(+c); } } catch {} } return out; };
const cpuOf = (pid) => { let t = 0; for (const p of kids(pid)) { try { const s = readFileSync(`/proc/${p}/stat`, "utf8"); if (!/\(workerd\)/.test(s)) continue; const f = s.slice(s.lastIndexOf(")") + 2).split(" "); t += (+f[11] + +f[12]) * 10; } catch {} } return t; }; // ms
const stop = () => { for (const p of servers) { try { process.kill(-p, "SIGTERM"); } catch {} } };
process.on("exit", stop); process.on("SIGINT", () => { stop(); process.exit(1); });
const up = async (base, path) => { for (let i = 0; i < 120; i++) { try { const r = await fetch(base + path); await r.text(); if (r.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error("server not up " + base); };
const one = async (url) => { const t0 = performance.now(); const r = await fetch(url); const rd = r.body.getReader(); let ttfb = 0, bytes = 0; for (;;) { const { done, value } = await rd.read(); if (!ttfb) ttfb = performance.now() - t0; if (done) break; bytes += value.length; } return [ttfb, performance.now() - t0, bytes]; };

const cfPid = start(cfDir, 28801), vxPid = start(vxDir, 28802);
const cfBase = "http://localhost:28801", vxBase = "http://localhost:28802";
await up(cfBase, "/ssr?ms=0"); await up(vxBase, "/rsc?ms=0");
const targets = [
  { name: "cf-lite render=ssr", base: cfBase, path: "/ssr", pid: cfPid },
  { name: "cf-lite render=rsc", base: cfBase, path: "/rsc", pid: cfPid },
  { name: "vinext (RSC)", base: vxBase, path: "/rsc", pid: vxPid },
];
const out = { n, rows: [] };
for (const ms of [0, 150, 400]) for (const t of targets) { // interleaved per ms level
  const url = `${t.base}${t.path}?ms=${ms}`;
  for (let i = 0; i < 40; i++) await one(url);
  const rows = [], batches = [];
  for (let b = 0; b < n / 50; b++) { const c0 = cpuOf(t.pid); for (let i = 0; i < 50; i++) rows.push(await one(url)); batches.push((cpuOf(t.pid) - c0) / 50); }
  out.rows.push({ target: t.name, ms, bytes: rows[0][2], ttfb_p50: q(rows.map((r) => r[0]), .5), ttfb_p95: q(rows.map((r) => r[0]), .95), total_p50: q(rows.map((r) => r[1]), .5), total_p95: q(rows.map((r) => r[1]), .95), cpu_ms_p50: q(batches, .5), cpu_ms_p95: q(batches, .95), cpu_ms_mean: +(batches.reduce((a, b) => a + b, 0) / batches.length).toFixed(2) });
}
// client JS: every <script src>/modulepreload JS the HTML references (gzip), plus inline script bytes (Flight payload etc.)
const clientJs = async (base, path, dirScope) => {
  const html = await (await fetch(`${base}${path}?ms=0`)).text();
  const srcs = new Set([...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).concat([...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1])));
  let gzip = 0, raw = 0; for (const s of srcs) { const b = Buffer.from(await (await fetch(new URL(s, base))).arrayBuffer()); raw += b.length; gzip += gz(b); }
  const inl = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("");
  return { externalFiles: srcs.size, externalRaw: raw, externalGzip: gzip, inlineRaw: inl.length, inlineGzip: gz(Buffer.from(inl)), htmlBytes: html.length };
};
out.clientJs = { "cf-lite render=ssr": await clientJs(cfBase, "/ssr"), "cf-lite render=rsc": await clientJs(cfBase, "/rsc"), "vinext (RSC)": await clientJs(vxBase, "/rsc") };
// Worker size
const wd = (d) => readdirSync(join(d, "dist")).find((x) => x !== "client" && x !== "server");
out.worker = {
  "cf-lite app (ssr+rsc routes, whole Worker incl. rsc env)": size(walk(join(cfDir, "dist", "ssr")).filter((f) => /\.m?js$/.test(f))),
  "vinext": size(walk(join(vxDir, ".cloudflare/output/v0/workers/default/bundle")).filter((f) => /\.(js|mjs|json)$/.test(f) && !f.includes("/.vite/"))),
};
console.log(JSON.stringify(out, null, 1));
stop();

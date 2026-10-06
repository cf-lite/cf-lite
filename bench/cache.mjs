// SSR TTFB + CPU: uncached vs cache miss vs cache hit, local workerd (wrangler dev) running examples/demo.
//   node bench/cache.mjs [--n 300]      -> prints a table, writes bench/cache-results.md
// Page = the demo's /cached-fn/:id (React SSR, 400 list rows, no I/O in the loader). "uncached" is /cached-fn/missing, the same page
// whose cache() returns false; "miss" = a never-seen id each request (render + Cache API put); "hit" = one id, served from caches.default.
// CPU = user+sys jiffies of the workerd process tree (from /proc) / requests. Local numbers only - see docs/caching.md for caveats.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, cpus } from "node:os";
import { dirname, join } from "node:path";

const NN = Number(process.argv[process.argv.indexOf("--n") + 1]) || 300;
const demo = new URL("../examples/demo/", import.meta.url).pathname;
const require = createRequire(demo);
const b = spawnSync(process.execPath, [join(demo, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: demo, encoding: "utf8" });
if (b.status) throw new Error(b.stdout + b.stderr);
const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const state = mkdtempSync(join(tmpdir(), "cfl-cache-bench-"));
const port = 19900 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", state, "--show-interactive-dev-session=false"], { cwd: demo, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);

// jiffies of every descendant of the wrangler process we started (only reads /proc)
function tree(root) {
  const kids = new Map();
  for (const d of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    try { const s = readFileSync(`/proc/${d}/stat`, "utf8"); const f = s.slice(s.lastIndexOf(")") + 2).split(" "); (kids.get(+f[1]) ?? kids.set(+f[1], []).get(+f[1])).push({ pid: +d, j: +f[11] + +f[12], comm: s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")) }); } catch {}
  }
  const out = [], q = [root];
  while (q.length) for (const k of kids.get(q.shift()) ?? []) { out.push(k); q.push(k.pid); }
  return out;
}
const jiffies = () => { const t = tree(child.pid).filter((p) => /workerd/.test(p.comm)); if (!t.length) throw new Error("workerd process not found"); return t.reduce((a, p) => a + p.j, 0); };
const HZ = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout) || 100;

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
async function phase(name, pathOf, N = NN) {
  const ttfb = [], total = []; const j0 = jiffies();
  for (let i = 0; i < N; i++) {
    const t0 = performance.now(); const r = await fetch(`http://localhost:${port}${pathOf(i)}`); const t1 = performance.now(); await r.arrayBuffer(); const t2 = performance.now();
    ttfb.push(t1 - t0); total.push(t2 - t0);
    if (!/^(uncached|floor)/.test(name) && r.headers.get("x-cf-lite-cache") !== (name.startsWith("hit") ? "HIT" : "MISS")) throw new Error(`${name}: got ${r.headers.get("x-cf-lite-cache")} at ${i}`);
    if (name.startsWith("uncached") && r.headers.get("x-cf-lite-cache") !== "BYPASS") throw new Error("uncached: expected BYPASS");
  }
  const cpuMs = ((jiffies() - j0) / HZ / N) * 1000;
  ttfb.sort((x, y) => x - y); total.sort((x, y) => x - y);
  return { name, p50: pct(ttfb, 50), p95: pct(ttfb, 95), tot50: pct(total, 50), cpuMs };
}

try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await new Promise((r) => setTimeout(r, 500));
  if (!log.includes("Ready on")) throw new Error("wrangler dev did not start:\n" + log);
  const stamp = Date.now().toString(36);
  for (let i = 0; i < 30; i++) { await (await fetch(`http://localhost:${port}/cached-fn/warm${i}`)).arrayBuffer(); await (await fetch(`http://localhost:${port}/cached-fn/missing`)).arrayBuffer(); }
  await (await fetch(`http://localhost:${port}/cached-fn/hot`)).arrayBuffer();
  const rows = [];
  rows.push(await phase("floor", () => "/api/hello")); // Worker round trip with no SSR: the local proxy/dev-loop floor
  rows.push(await phase("uncached", () => "/cached-fn/missing"));
  rows.push(await phase("miss", (i) => `/cached-fn/${stamp}-${i}`));
  rows.push(await phase("hit", () => "/cached-fn/hot"));
  // same three with a 50 ms await in the loader (a stand-in for one D1/fetch round trip)
  await (await fetch(`http://localhost:${port}/cached-fn/slow-hot`)).arrayBuffer();
  const M = (NN / 3) | 0;
  rows.push(await phase("uncached +50ms I/O", () => "/cached-fn/slow-nocache", M));
  rows.push(await phase("miss +50ms I/O", (i) => `/cached-fn/slow-${stamp}-${i}`, M));
  rows.push(await phase("hit +50ms I/O", () => "/cached-fn/slow-hot", M));
  const f = (x) => x.toFixed(2);
  const md = [`# Cache bench (local workerd)`, ``, `${new Date().toISOString().slice(0, 10)} - ${cpus()[0]?.model}, ${cpus().length} cores, node ${process.version}, ${NN} sequential requests per row (a third of that for the +50 ms I/O rows), page = demo \`/cached-fn/:id\` (React SSR, 400 rows).`, ``,
    `| case | TTFB p50 (ms) | TTFB p95 (ms) | total p50 (ms) | workerd CPU / request (ms) |`, `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.name} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.tot50)} | ${f(r.cpuMs)} |`), ``,
    `"floor" = \`/api/hello\` (a trivial Worker route: the dev-loop + HTTP floor every row pays). "uncached" = same page, cache() returns false. "miss" = render + \`caches.default.put\` (+ a tag-ledger read is skipped: nothing stored yet). "hit" = \`cache.match\` + ledger check (KV binding, memoised per isolate) + no render.`,
    `CPU is user+sys time of the local workerd processes per request, which includes the HTTP/proxy work of wrangler's dev loop; read it as a ratio, not as Workers billed CPU. The first block has no I/O in the loader; the +50 ms block adds one awaited 50 ms call, which is where a cache hit pays off (hit cost stays flat). The local Cache API is miniflare's SQLite-backed emulation - a hit costs ~8 ms over the floor here, far more than a real colo cache read.`, ``].join("\n");
  console.log(md);
  writeFileSync(new URL("./cache-results.md", import.meta.url), md);
} finally { stop(); rmSync(state, { recursive: true, force: true }); }
process.exit(0);

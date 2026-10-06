#!/usr/bin/env node
// Performance budget gate (docs/rc-status.md gate 2.3): build time, cold start, request p50 and Worker size of the reference examples,
// compared with the committed bench/budgets.json. Runs locally / from a scheduled job on a maintainer machine, deliberately NOT in GitHub CI (Actions minutes).
//
//   node scripts/perf-budget.mjs                  # measure (local workerd), compare, exit 1 on regression
//   node scripts/perf-budget.mjs --update         # re-measure and rewrite the baselines (review the JSON diff; justify in the PR)
//   node scripts/perf-budget.mjs --only demo,site # subset;  --runs 3 (default)  --reqs 300 (default)
//   node scripts/perf-budget.mjs --live           # ALSO deploy temporary Workers, measure, delete them with proof (needs CF creds in env)
//   node scripts/perf-budget.mjs --live --cpu     # live + Worker CPU p50 from the GraphQL analytics API (data lags minutes)
//
// Local metrics: buildSeconds = median `cf-lite build` with dist/.cf-lite removed (deps installed); workerGzipBytes = `cf-lite analyze`;
// coldStartMs = median wall time from spawning `wrangler dev` to the first 200 on "/" (workerd start + first request);
// p50Ms = median of sequential loopback requests after warm-up. workerd exposes no per-request CPU time locally, so p50Ms (loopback
// round trip, client and server share the CPUs) is the local proxy; true CPU p50 is only available in --live --cpu.
// The machine is shared and noisy: medians + a generous tolerance, and a failing metric is re-measured once before it fails the gate.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { compare, deployedUrl, liveSafe, median, percentile, tempWorkerName } from "./perf-budget-lib.mjs";

const root = new URL("../", import.meta.url).pathname;
const file = root + "bench/budgets.json";
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n), opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const RUNS = Number(opt("--runs", 3)), REQS = Number(opt("--reqs", 300));
const REFERENCE = ["demo", "site", "site-preact", "site-forms", "site-isr", "site-islands"];
const only = opt("--only", null)?.split(",");
const cli = join(root, "packages/cf-lite/dist/cli.js");
const wrangler = join(dirname(createRequire(root).resolve("wrangler/package.json")), "bin/wrangler.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

function build(ex) {
  const cwd = join(root, "examples", ex);
  for (const o of ["dist", ".cf-lite"]) rmSync(join(cwd, o), { recursive: true, force: true });
  const t = performance.now();
  const r = spawnSync(process.execPath, [cli, "build"], { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`build failed: ${ex}\n${r.stdout}${r.stderr}`);
  return (performance.now() - t) / 1000;
}

/** Spawn `wrangler dev` (own process group; only that group is ever signalled), return { coldMs, p50Ms, stop }. */
async function serveAndProbe(ex) {
  const cwd = join(root, "examples", ex), port = await freePort(), B = `http://127.0.0.1:${port}`;
  const t0 = performance.now();
  const child = spawn(process.execPath, [wrangler, "dev", "--port", String(port), "--ip", "127.0.0.1", "--show-interactive-dev-session=false", "--persist-to", join(cwd, ".wrangler/perf-state")], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  const onExit = () => stop(); process.on("exit", onExit); // safety net if the script dies mid-probe
  try {
    let coldMs = NaN, status = 0;
    for (let i = 0; i < 240; i++) {
      if (child.exitCode != null) throw new Error(`wrangler dev exited early (${ex}):\n${log.slice(-800)}`);
      try { const r = await fetch(B + "/", { redirect: "manual" }); await r.arrayBuffer(); status = r.status; if (status < 500) { coldMs = performance.now() - t0; break; } } catch {}
      await sleep(100);
    }
    if (!Number.isFinite(coldMs)) throw new Error(`no response from ${ex}:\n${log.slice(-800)}`);
    if (status >= 400) throw new Error(`GET / answered ${status} for ${ex}`);
    for (let i = 0; i < 50; i++) await (await fetch(B + "/")).arrayBuffer(); // warm-up
    const lat = [];
    for (let i = 0; i < REQS; i++) { const s = performance.now(); await (await fetch(B + "/")).arrayBuffer(); lat.push(performance.now() - s); }
    return { coldMs, p50Ms: percentile(lat, 50), p95Ms: percentile(lat, 95) };
  } finally { stop(); process.off("exit", onExit); await sleep(300); }
}

async function measureLocal(ex) {
  const { analyze } = await import(root + "packages/cf-lite/dist/analyze.js");
  const builds = []; for (let i = 0; i < RUNS; i++) builds.push(build(ex));
  const workerGzipBytes = analyze(join(root, "examples", ex)).worker?.gzipTotal ?? NaN;
  const colds = [], p50s = [], p95s = [];
  for (let i = 0; i < RUNS; i++) { const p = await serveAndProbe(ex); colds.push(p.coldMs); p50s.push(p.p50Ms); p95s.push(p.p95Ms); }
  const r = (x, d) => +x.toFixed(d);
  return { buildSeconds: r(median(builds), 2), workerGzipBytes, coldStartMs: Math.round(median(colds)), p50Ms: r(median(p50s), 3), p95Ms: r(median(p95s), 3) };
}

// ------------------------------------------------------------------ live mode (temporary Workers, deleted with proof)
const CF = "https://api.cloudflare.com/client/v4";
async function cfApi(path, init = {}) { const r = await fetch(CF + path, { ...init, headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json", ...init.headers } }); return { status: r.status, body: await r.json().catch(() => null) }; }
async function cpuP50(account, name, sinceIso) {
  const q = `query($a:String!,$s:String!,$f:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{scriptName:$s,datetime_geq:$f}){quantiles{cpuTimeP50} sum{requests}}}}}`;
  const r = await cfApi("/graphql", { method: "POST", body: JSON.stringify({ query: q, variables: { a: account, s: name, f: sinceIso } }) });
  const rows = r.body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const req = rows.reduce((s, x) => s + (x.sum?.requests ?? 0), 0);
  return req ? { cpuTimeP50Us: median(rows.map((x) => x.quantiles.cpuTimeP50)), requests: req } : null;
}
async function measureLive(ex, withCpu, account) {
  const cwd = join(root, "examples", ex);
  const wj = readFileSync(join(cwd, "wrangler.jsonc"), "utf8");
  if (!liveSafe(wj)) return { skipped: "example has resource bindings; not deployed temporarily" };
  build(ex);
  const name = tempWorkerName(ex), since = new Date().toISOString();
  const proof = { name, deployedAt: since };
  let url = null;
  try {
    const d = spawnSync(process.execPath, [wrangler, "deploy", "--name", name], { cwd, encoding: "utf8", env: { ...process.env, CI: "1" } });
    proof.deployExit = d.status; url = deployedUrl(d.stdout + d.stderr);
    if (d.status !== 0 || !url) throw new Error(`deploy failed for ${ex}: ${(d.stdout + d.stderr).slice(-600)}`);
    await sleep(3000);
    const t = performance.now(); const first = await fetch(url + "/"); await first.arrayBuffer(); const firstMs = performance.now() - t;
    const lat = []; for (let i = 0; i < 100; i++) { const s = performance.now(); await (await fetch(url + "/")).arrayBuffer(); lat.push(performance.now() - s); }
    const out = { firstRequestMs: Math.round(firstMs), status: first.status, rttP50Ms: +median(lat).toFixed(1), rttP95Ms: +percentile(lat, 95).toFixed(1) };
    if (withCpu) {
      for (let i = 0; i < 12 && !out.cpu; i++) { await sleep(30_000); out.cpu = await cpuP50(account, name, since); }
      out.cpuP50Ms = out.cpu ? +(out.cpu.cpuTimeP50Us / 1000).toFixed(3) : null;
    }
    return { ...out, proof };
  } finally {
    const del = spawnSync(process.execPath, [wrangler, "delete", "--name", name, "--force"], { cwd, encoding: "utf8", env: { ...process.env, CI: "1" } });
    proof.deleteExit = del.status;
    const after = await cfApi(`/accounts/${account}/workers/scripts/${name}`);
    proof.apiStatusAfterDelete = after.status; proof.deleted = after.status === 404;
    if (url) { try { proof.urlAfterDelete = (await fetch(url + "/")).status; } catch { proof.urlAfterDelete = "unreachable"; } }
    if (!proof.deleted) { console.error(`!! temporary Worker ${name} STILL EXISTS (api status ${after.status}). Delete it by hand: wrangler delete --name ${name}`); process.exitCode = 2; }
  }
}

// ------------------------------------------------------------------ main
const names = (only ?? REFERENCE).filter((e) => existsSync(join(root, "examples", e, "wrangler.jsonc")));
const measured = {};
for (const ex of names) { process.stdout.write(`measuring ${ex} ... `); measured[ex] = await measureLocal(ex); console.log(JSON.stringify(measured[ex])); }

if (flag("--update")) {
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const rules = prev.rules ?? { buildSeconds: { pct: 60, abs: 3 }, coldStartMs: { pct: 100, abs: 800 }, p50Ms: { pct: 60, abs: 0.5 }, workerGzipBytes: { pct: 5, abs: 256 } };
  const examples = { ...(prev.examples ?? {}) };
  for (const [ex, m] of Object.entries(measured)) examples[ex] = { buildSeconds: m.buildSeconds, coldStartMs: m.coldStartMs, p50Ms: m.p50Ms, workerGzipBytes: m.workerGzipBytes };
  const host = { node: process.version, wrangler: JSON.parse(readFileSync(join(dirname(wrangler), "../package.json"), "utf8")).version, cpus: (await import("node:os")).cpus().length, date: new Date().toISOString().slice(0, 10) };
  writeFileSync(file, JSON.stringify({ _doc: "Local-workerd perf baselines; regenerate with `node scripts/perf-budget.mjs --update` on an otherwise idle machine. Gate fails when measured > baseline*(1+pct/100)+abs (docs/performance-budgets.md).", measuredOn: host, rules, examples }, null, 2) + "\n");
  console.log("wrote", file);
} else {
  const budgets = JSON.parse(readFileSync(file, "utf8"));
  let rows = compare(measured, budgets);
  const bad = rows.filter((r) => !r.ok && r.base != null);
  if (bad.length) { // one retry of only the failing examples: shared-host noise is common, a real regression repeats
    console.log(`\n${bad.length} metric(s) over budget; re-measuring ${[...new Set(bad.map((b) => b.ex))].join(", ")} once ...`);
    for (const ex of new Set(bad.map((b) => b.ex))) { const again = await measureLocal(ex); for (const k of Object.keys(measured[ex])) measured[ex][k] = k === "workerGzipBytes" ? again[k] : Math.min(measured[ex][k], again[k]); }
    rows = compare(measured, budgets);
  }
  for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.ex.padEnd(13)} ${r.metric.padEnd(16)} ${String(r.got).padStart(9)}  (baseline ${r.base ?? "MISSING"}, limit ${r.limit == null ? "-" : +r.limit.toFixed(3)})${r.why ? "  " + r.why : ""}`);
  const fails = rows.filter((r) => !r.ok);
  if (fails.length) { console.error(`\nPerf budget exceeded (${fails.length}). If intentional: node scripts/perf-budget.mjs --update, and justify in the PR.`); process.exitCode = 1; } else console.log("\nperf budget ok");
}

if (flag("--live")) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!process.env.CLOUDFLARE_API_TOKEN || !account) { console.error("--live needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment (export them first); skipping live."); process.exitCode ||= 3; }
  else {
    const live = {};
    for (const ex of names) { process.stdout.write(`live ${ex} ... `); live[ex] = await measureLive(ex, flag("--cpu"), account); console.log(JSON.stringify(live[ex])); }
    mkdirSync(join(root, "bench/results"), { recursive: true });
    const out = join(root, "bench/results", `perf-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), live }, null, 2) + "\n"); console.log("wrote", out);
  }
}

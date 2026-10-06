#!/usr/bin/env node
// `cf-lite dev` (vite dev) with RSC routes: copies examples/site-rsc to a scratch dir, serves an rsc route, edits a server component
// (HMR / re-render without restart), checks getRequest() ALS, loader data, a client island in Chromium, and that the edit shows without a full reload.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const src = new URL("../examples/site-rsc/", import.meta.url).pathname;
const dir = new URL(`../e2e/.tmp/rscdev-${process.pid}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler)([\\/]|$)/.test(p.slice(src.length)) });
const pj = createRequire(src).resolve("vite/package.json");
const vitebin = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.vite);
const port = 19800 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [vitebin, "dev", "--port", String(port), "--strictPort"], { cwd: dir, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", () => { stop(); rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 60000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timeout: " + what + "\n" + log.slice(-2500)); await sleep(300); } };
const base = `http://localhost:${port}`;
const body = async (p) => (await fetch(base + p, { headers: { accept: "text/html" } })).text();
let br;
try {
  await waitFor(() => /Local:/.test(log), "vite dev start");
  const rsc = await waitFor(async () => { const t = await body("/rsc?ms=10"); return /rendered by: rsc/.test(t) && t; }, "rsc route served by dev");
  assert.match(rsc, /__FLIGHT_DATA/); assert.match(rsc, /slow data after (<!-- -->)?10/);
  // request context (AsyncLocalStorage) + loader data + env binding under dev
  const d = await waitFor(async () => { const t = await body("/rsc-data?id=7"); return /id="ctx"/.test(t) && t; }, "rsc-data");
  assert.match(d, /id="ctx"[^>]*>hello-env/); assert.match(d, /data (<!-- -->)?7/); assert.match(d, /<title>data 7<\/title>/);
  assert.equal((await fetch(base + "/rsc-nf")).status, 404); assert.equal((await fetch(base + "/rsc-err")).status, 500);
  assert.match(await body("/"), /id="root"|<div/); // non-rsc page still served
  // HMR: edit the server component, next request (no restart) shows it
  const f = join(dir, "app/routes/rsc.tsx"), orig = readFileSync(f, "utf8");
  br = await chromium.launch(); const p = await br.newPage(), errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(base + "/rsc?ms=10", { waitUntil: "networkidle" });
  await p.click("#counter"); await p.click("#counter"); // client island hydrated in dev
  assert.match(await p.textContent("#counter"), /clicks: 2/);
  writeFileSync(f, orig.replace("rendered by: rsc (cf-lite)", "rendered by: rsc EDITED"));
  await waitFor(async () => /rendered by: rsc EDITED/.test(await body("/rsc?ms=10")), "server-component edit served");
  // the open page picks the edit up through rsc HMR (soft re-fetch) or a reload; either way the new text must show and the island must still work
  await waitFor(async () => /EDITED/.test((await p.textContent("#mode")) ?? ""), "browser shows edit " + "", 20000).catch(async (e) => { console.log("PAGE:", p.url(), (await p.content()).slice(0, 1500)); throw e; });
  await p.waitForSelector("#counter"); await p.click("#counter");
  assert.match(await p.textContent("#counter"), /clicks: \d+/);
  writeFileSync(f, orig);
  await waitFor(async () => /rendered by: rsc \(cf-lite\)/.test(await body("/rsc?ms=10")), "edit reverted");
  // client component HMR: edit the "use client" module the page imports. The browser must show the new markup WITHOUT a document reload
  // (a window marker survives) and keep working; with Fast Refresh the counter state survives too (asserted: the counter keeps its 2 clicks).
  const cf = join(dir, "app/islands/counter.tsx"), corig = readFileSync(cf, "utf8");
  await p.goto(base + "/rsc?ms=10", { waitUntil: "networkidle" });
  await p.click("#counter"); await p.click("#counter");
  await p.evaluate(() => { window.__hmrMarker = "alive"; });
  writeFileSync(cf, corig.replace("{label}: {n}", "{label} ~ {n}"));
  await waitFor(async () => /clicks ~ \d+/.test((await p.textContent("#counter")) ?? ""), "browser shows the client-component edit", 30000).catch(async (e) => { console.log("PAGE:", p.url(), (await p.content()).slice(0, 1500)); throw e; });
  const reloaded = (await p.evaluate(() => window.__hmrMarker)) !== "alive";
  const afterEdit = await p.textContent("#counter");
  console.log(`client-component HMR: ${reloaded ? "full reload" : "in place"}; counter after edit: ${afterEdit}`);
  assert.match(afterEdit, /clicks ~ 2/, "Fast Refresh keeps the island's state (2 clicks before the edit)");
  await p.click("#counter");
  assert.match(await p.textContent("#counter"), /clicks ~ \d+/);
  assert.equal(reloaded, false, "client component edit caused a full document reload");
  writeFileSync(cf, corig);
  await waitFor(async () => /clicks: \d+/.test((await p.textContent("#counter")) ?? ""), "client edit reverted in the browser", 30000);
  const real = errs.filter((e) => !/Failed to fetch|net::/.test(e)); assert.deepEqual(real, [], "page errors: " + real.join("|"));
  console.log("rsc dev e2e OK");
} finally {
  await br?.close().catch(() => {}); stop();
}
process.exit(0);

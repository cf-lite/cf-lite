// Dev server: adding/removing an SSR route file must take effect without a manual restart.
// Copies examples/site (minus its ssr page) to a scratch dir inside the repo (so node_modules resolves), runs `vite dev`,
// then creates / deletes app/routes/late/[id].tsx and checks the next request is served by the Worker (ssr) / the SPA shell.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const src = new URL("../examples/site/", import.meta.url).pathname;
const dir = new URL(`../e2e/.tmp/dev-${process.pid}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler|blog)([\\/]|$)/.test(p.slice(src.length)) });
const require = createRequire(src);
const pj = require.resolve("vite/package.json");
const vitebin = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.vite);
const port = 19900 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [vitebin, "dev", "--port", String(port), "--strictPort"], { cwd: dir, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", () => { stop(); rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const restarts = () => (log.match(/routing changed/g) ?? []).length;
const waitFor = async (fn, what, ms = 40000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timeout: " + what + "\n" + log.slice(-2500)); await sleep(300); } };
const body = async (p) => (await fetch(`http://localhost:${port}${p}`, { headers: { accept: "text/html" } })).text();

try {
  await waitFor(() => /Local:/.test(log), "vite dev start");
  await waitFor(async () => (await body("/app/dashboard")).includes('id="root"'), "first response");
  assert.ok(!(await body("/late/5")).includes("Late 5"), "no ssr route yet");
  const f = join(dir, "app/routes/late/[id].tsx");

  // add an SSR route -> routing changes -> auto restart -> served by the Worker, SSR-rendered
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, 'export const render = "ssr";\nexport default function Late({ params }: { params: { id: string } }) { return <main>Late {params.id}</main>; }\n');
  await waitFor(() => restarts() === 1, "restart after add");
  const html = await waitFor(async () => { const t = await body("/late/5"); return /Late <!-- -->5|Late 5/.test(t) && t; }, "ssr route served after add");
  assert.match(html, /data-ssr/, "rendered by the Worker");

  // change an existing SSR route's body: no routing change -> no restart (HMR/regen only)
  writeFileSync(f, 'export const render = "ssr";\nexport default function Late({ params }: { params: { id: string } }) { return <main>Later {params.id}</main>; }\n');
  await sleep(2500);
  assert.equal(restarts(), 1, "editing an ssr route body must not restart");
  await waitFor(async () => /Later/.test(await body("/late/5")), "edited body served");

  // add an SPA route: no restart
  writeFileSync(join(dir, "app/routes/extra.tsx"), "export default function X() { return <main>x</main>; }\n");
  await sleep(2500);
  assert.equal(restarts(), 1, "adding an spa route must not restart");

  // remove the SSR route -> restart -> falls back to the SPA shell (no SSR markup)
  unlinkSync(f);
  await waitFor(() => restarts() === 2, "restart after unlink");
  await waitFor(async () => { const t = await body("/late/5"); return t.includes('id="root"') && !/Late/.test(t) && !t.includes("data-ssr"); }, "ssr route gone after unlink");
  console.log("dev e2e OK (restarts:", restarts() + ")");
} finally {
  stop();
}
process.exit(0);

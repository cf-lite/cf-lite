// `vite dev` (workerd SSR + the framework's own Vite plugin) for every UI adapter's example app: the SSR route streams the nested layouts,
// the API answers, the SPA shell is served. Covers dev-mode SSR, which the built-output tests do not.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const pj = createRequire(root).resolve("vite/package.json");
const vitebin = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.vite);

for (const site of ["site", "site-preact", "site-vue", "site-svelte", "site-solid", "site-htmx"]) {
  const port = 19800 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [vitebin, "dev", "--port", String(port), "--strictPort"], { cwd: join(root, "examples", site), env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  try {
    for (let i = 0; i < 120 && !log.includes("Local:"); i++) await new Promise((r) => setTimeout(r, 500));
    assert.ok(log.includes("Local:"), `${site}: vite dev did not start\n${log}`);
    const B = `http://localhost:${port}`;
    if (site === "site-htmx") { // renderer "none": no SSR route; the fragment + API routes answer in dev
      let r = await fetch(`${B}/api/ui/page/dashboard`); assert.equal(r.status, 200); assert.match(await r.text(), /hx-post="\/api\/ui\/count"/);
      r = await fetch(`${B}/`, { headers: { accept: "text/html" } }); assert.match(await r.text(), /hx-get="\/api\/ui"/);
      console.log(`dev e2e OK (${site})`); continue;
    }
    let r = await fetch(`${B}/blog/hello`, { headers: { accept: "text/html" } }); let t = await r.text();
    assert.equal(r.status, 200, `${site}: /blog/hello ${r.status}\n${t.slice(0, 500)}\n${log.slice(-1500)}`);
    assert.match(t, /data-testid="l-root"[\s\S]*data-testid="l-blog"[\s\S]*Blog[\s\S]*hello/); assert.match(t, /<title[^>]*>hello — site blog<\/title>/);
    r = await fetch(`${B}/api/hello`); assert.equal((await r.json()).message, "hello site");
    r = await fetch(`${B}/app/dashboard`, { headers: { accept: "text/html" } }); t = await r.text();
    assert.equal(r.status, 200); assert.match(t, /id="root"/);
    console.log(`dev e2e OK (${site})`);
  } finally { stop(); }
}
process.exit(0);

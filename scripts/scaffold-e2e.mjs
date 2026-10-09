// `create-cf-lite --ui <x>` for every UI: scaffold (no install; the repo's workspace links supply the packages), build, serve under
// local workerd, assert the API answers and the shell is served. Proves the scaffolds are not just well-formed text.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cf-lite/dist/cli.js");
const require = createRequire(root);
const wr = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");

for (const ui of ["none", "react", "preact", "vue", "svelte", "htmx"]) {
  const dir = join(root, `examples/.scaffold-${ui}`);
  rmSync(dir, { recursive: true, force: true });
  let r = spawnSync(process.execPath, [join(root, "packages/create-cf-lite/index.mjs"), dir, "--ui", ui, "--no-install"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [cli, "build"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, `${ui}: build failed\n${r.stdout}${r.stderr}`);
  const port = 19400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  try {
    for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await new Promise((r) => setTimeout(r, 500));
    assert.ok(log.includes("Ready on"), `${ui}: wrangler dev did not start\n${log}`);
    const api = await (await fetch(`http://localhost:${port}/api/hello`)).json();
    assert.equal(api.message, "hello from cf-lite");
    const html = await (await fetch(`http://localhost:${port}/`)).text();
    assert.match(html, /<div id="root"/); assert.match(html, /type="module"/);
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(Object.keys(pj.dependencies).includes("react"), ui === "react");
    if (ui === "htmx") { // preset: server-rendered fragment + hx-* wiring, no UI adapter
      assert.match(html, /id="root"[^>]*hx-get="\/api\/ui"/);
      const frag = await fetch(`http://localhost:${port}/api/ui`); assert.match(frag.headers.get("content-type") ?? "", /text\/html/);
      const ft = await frag.text(); assert.match(ft, /hx-post="\/api\/ui\/count"/);
      const cnt = await fetch(`http://localhost:${port}/api/ui/count`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "n=5" });
      assert.match(await cnt.text(), /clicked 5/);
      assert.ok(!Object.keys(pj.dependencies).some((d) => d.startsWith("@cf-lite/")), "htmx preset adds no adapter package");
    }
    console.log(`scaffold e2e OK (${ui})`);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
}
process.exit(0);

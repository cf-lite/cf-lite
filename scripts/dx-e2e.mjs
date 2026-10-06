// WP-DX e2e: every create-cf-lite template scaffolds, builds, passes `cf-lite doctor`, reports in `cf-lite analyze`, and answers under local workerd.
// Plus the CLI surface of `add --dry-run`, `add tailwind`, and `upgrade`.
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cf-lite/dist/cli.js");
const require = createRequire(root);
const wr = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
const cf = (dir, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });

async function serve(dir, fn) {
  const port = 19800 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  try {
    for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await new Promise((r) => setTimeout(r, 500));
    assert.ok(log.includes("Ready on"), `wrangler dev did not start\n${log}`);
    await fn(`http://localhost:${port}`);
  } finally { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
}

const probes = {
  blog: async (o) => {
    const home = await (await fetch(o + "/")).text(); assert.match(home, /\/posts\/hello/);
    const post = await (await fetch(o + "/posts/hello")).text(); assert.match(post, /<title[^>]*>Hello, edge/); assert.match(post, /application\/ld\+json/);
    const sm = await (await fetch(o + "/sitemap.xml")).text(); assert.match(sm, /\/posts\/second/);
    assert.match(await (await fetch(o + "/robots.txt")).text(), /Disallow: \/api\//);
  },
  api: async (o) => {
    const c = await fetch(o + "/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "a" }) }); assert.equal(c.status, 201);
    assert.equal((await (await fetch(o + "/api/items")).json()).items.length, 1);
    assert.equal((await fetch(o + "/api/items", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    const body = JSON.stringify({ event: "x" });
    assert.equal((await fetch(o + "/api/webhook", { method: "POST", body })).status, 401); // secret from .dev.vars, no signature
    const sig = createHmac("sha256", "change-me").update(body).digest("hex");
    assert.equal((await fetch(o + "/api/webhook", { method: "POST", body, headers: { "x-signature": sig } })).status, 200);
  },
  saas: async (o) => {
    assert.match(await (await fetch(o + "/")).text(), /<div id="root"/);
    assert.equal((await fetch(o + "/api/dashboard")).status, 401);
    const me = await fetch(o + "/api/auth/me"); assert.ok([200, 500].includes(me.status)); // 500 only if SESSION_SECRETS is unset; must not be a 404
  },
  realtime: async (o) => { assert.ok((await fetch(o + "/")).ok); },
  patterns: async (o) => { assert.match(await (await fetch(o + "/")).text(), /<h1>Patterns<\/h1>/); },
  "ai-chat": null, // the AI binding needs a Cloudflare login even for `wrangler dev`: build + doctor only
};

for (const kind of ["blog", "saas", "api", "realtime", "ai-chat", "patterns"]) {
  const dir = join(root, `examples/.dx-${kind}`);
  rmSync(dir, { recursive: true, force: true });
  let r = spawnSync(process.execPath, [join(root, "packages/create-cf-lite/index.mjs"), dir, "--template", kind, "--no-install"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  if (kind === "api") writeFileSync(join(dir, ".dev.vars"), "WEBHOOK_SECRET=change-me\n");
  if (kind === "saas") writeFileSync(join(dir, ".dev.vars"), "SESSION_SECRETS=dev-secret-dev-secret-dev-secret-00\n");
  try {
    r = cf(dir, "build"); assert.equal(r.status, 0, `${kind}: build failed\n${r.stdout}${r.stderr}`);
    r = cf(dir, "doctor"); assert.equal(r.status, 0, `${kind}: doctor\n${r.stdout}${r.stderr}`);
    r = cf(dir, "analyze"); assert.equal(r.status, 0, `${kind}: analyze\n${r.stdout}${r.stderr}`); assert.match(r.stdout, /Worker:/);
    if (kind === "patterns") { // `cfl export` on a freshly scaffolded app: fragments + manifest, built assets listed, second run changes nothing
      r = cf(dir, "export"); assert.equal(r.status, 0, `patterns: export\n${r.stdout}${r.stderr}`);
      const m = JSON.parse(readFileSync(join(dir, "patterns-export/manifest.json"), "utf8")); assert.deepEqual(m.components.map((c) => c.id), ["patterns/atoms/Button"]);
      assert.equal(readFileSync(join(dir, "patterns-export/patterns/atoms/Button/ghost.html"), "utf8"), '<button type="button" class="btn btn--ghost">Cancel</button>\n');
      assert.ok(JSON.parse(readFileSync(join(dir, "patterns-export/assets.json"), "utf8")).css.length >= 1, "assets.json lists the built CSS");
      r = cf(dir, "export", "--check"); assert.equal(r.status, 0, r.stderr);
    }
    if (probes[kind]) await serve(dir, probes[kind]);
    console.log(`dx e2e OK (${kind})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// CLI: add --dry-run prints a diff and changes nothing; tailwind twice = no diff; upgrade
{
  const dir = join(root, "examples/.dx-cli");
  rmSync(dir, { recursive: true, force: true });
  let r = spawnSync(process.execPath, [join(root, "packages/create-cf-lite/index.mjs"), dir, "--no-install"], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr);
  try {
    const pj = readFileSync(join(dir, "package.json"), "utf8"), wj = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    r = cf(dir, "add", "tailwind", "--dry-run"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\+ app\/styles\.css/); assert.match(r.stdout, /~ vite\.config\.ts/);
    r = cf(dir, "add", "do", "room", "--dry-run"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /\+ server\/do\/room\.ts/);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), pj); assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), wj); assert.ok(!existsSync(join(dir, "app/styles.css")));
    r = cf(dir, "add", "tailwind", "--no-install"); assert.equal(r.status, 0, r.stderr);
    r = cf(dir, "add", "tailwind", "--no-install"); assert.match(r.stdout, /nothing to change/);
    r = cf(dir, "upgrade", "--dry-run", "--to", "0.4.0"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /already up to date/);
    r = cf(dir, "add", "nonsense-target", "--dry-run"); assert.notEqual(r.status, 0);
    console.log("dx e2e OK (cli)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
process.exit(0);

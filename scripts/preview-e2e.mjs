// DX kit e2e (docs/preview.md, docs/mocks.md, docs/export.md) on a scratch copy of examples/site-patterns:
//   dev + MOCK=1: /__preview (manifest, frames, islands hydrate in real Chromium, viewport toggle, deep links, live discovery), mocks (routes, handler, host folder, page loader)
//   dev without MOCK: mocks are inert
//   cfl export: layout, run-twice = no diff, --check, stale removal, asset manifest after a build
//   production build: no preview/mock code in the Worker, no /__preview in run_worker_first, `wrangler dev` of the build does not serve it
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const root = new URL("../", import.meta.url).pathname;
const src = join(root, "examples/site-patterns/");
const dir = join(root, `e2e/.tmp/preview-${process.pid}/`);
const cli = join(root, "packages/cf-lite/dist/cli.js");
const require = createRequire(root);
const pj = require.resolve("vite/package.json");
const vitebin = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.vite);
const wr = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
mkdirSync(dir, { recursive: true });
cpSync(src, dir, { recursive: true, filter: (p) => !/(^|[\\/])(dist|node_modules|\.cf-lite|\.wrangler|patterns-export)([\\/]|$)/.test(p.slice(src.length)) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const stopAll = () => { for (const c of kids) try { process.kill(-c.pid, "SIGTERM"); } catch {} };
process.on("exit", () => { stopAll(); rmSync(dir, { recursive: true, force: true }); });
const waitFor = async (fn, what, ms = 60000, log = () => "") => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t > ms) throw new Error("timeout: " + what + "\n" + log().slice(-2000)); await sleep(300); } };

async function vite(env, fn) {
  const port = 19700 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [vitebin, "dev", "--port", String(port), "--strictPort"], { cwd: dir, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(child);
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  try {
    await waitFor(() => /Local:/.test(log), "vite dev start", 60000, () => log);
    const B = `http://localhost:${port}`;
    await waitFor(async () => (await fetch(`${B}/__preview/api/manifest`)).ok, "preview manifest", 60000, () => log);
    await fn(B, () => log);
  } finally { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
}
const json = async (u) => (await fetch(u)).json();

// ---- dev with MOCK=1 -------------------------------------------------------------------------------------------------------
await vite({ MOCK: "1" }, async (B, log) => {
  const m = await json(`${B}/__preview/api/manifest`);
  assert.equal(m.mock.enabled, true);
  assert.deepEqual(m.items.map((i) => i.id), ["islands/Counter", "patterns/atoms/Button", "patterns/molecules/ProductCard", "patterns/organisms/ProductGrid"]);
  assert.deepEqual(m.items.find((i) => i.id === "patterns/atoms/Button").states, ["default", "ghost", "disabled"]);
  assert.deepEqual(m.mock.routes.map((r) => `${r.method} ${r.host ?? ""}${r.pattern}`), ["POST /api/echo", "GET /api/products", "* /api/products/:id", "GET shop.example.com/stock"]);

  // fragments: SSR through the real adapter, aliases resolved, island markup, async state props
  const frag = (c, s) => fetch(`${B}/__preview/frame/${c}?s=${s}&fragment=1`).then((r) => r.text());
  assert.equal(await frag("patterns/atoms/Button", "ghost"), '<button type="button" class="btn btn--ghost">Details</button>\n');
  assert.match(await frag("patterns/molecules/ProductCard", "expensive"), /Limited edition[\s\S]*1999\.00/);
  assert.match(await frag("patterns/molecules/ProductCard", "sold-out"), /Linen sofa[\s\S]*disabled=""/);
  assert.match(await frag("islands/Counter", "from-ten"), /^<cfl-island data-i="app\/islands\/Counter" data-p="\{&quot;start&quot;:10\}">/);
  assert.equal((await fetch(`${B}/__preview/frame/patterns/atoms/Button?s=nope`)).status, 404);
  const frame = await (await fetch(`${B}/__preview/frame/patterns/atoms/Button?s=default`)).text();
  assert.match(frame, /<div id="root" data-preview><button/); assert.match(frame, /preview\.setup\.ts/); assert.doesNotMatch(frame, /app\/main\.tsx/);
  assert.equal((await fetch(`${B}/app/preview.setup.ts`)).status, 200);

  // mocks: own-origin routes, handler params/body, 404 handler Response, page loader's fetch() served from mocks/, host folder via fetch()
  let r = await fetch(`${B}/api/products`); assert.equal(r.headers.get("x-cfl-mock"), "mocks/api/products.json"); assert.equal((await r.json()).length, 2);
  assert.deepEqual(await json(`${B}/api/products/2`), { id: 2, name: "Linen sofa" });
  assert.equal((await fetch(`${B}/api/products/9`)).status, 404);
  r = await fetch(`${B}/api/echo?x=1`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
  assert.deepEqual(await r.json(), { got: { a: 1 }, query: { x: "1" } });
  assert.equal((await fetch(`${B}/api/echo`)).status, 404, "POST-only mock does not answer GET (and there is no real route)");
  const products = await (await fetch(`${B}/products`, { headers: { accept: "text/html" } })).text();
  assert.match(products, /Oak shelf/); assert.match(products, /Linen sofa/);
  assert.match(log(), /mock GET \/api\/products <- mocks\/api\/products\.json/);

  // browser: iframe renders + island hydrates, viewport toggle, deep link, HTML tab, filter
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (c) => { if (c.type() === "error") errors.push(c.text()); });
    await page.goto(`${B}/__preview?c=islands/Counter&s=from-ten`);
    const btn = page.frameLocator("iframe").locator("[data-testid=counter]");
    await btn.waitFor(); assert.match(await btn.textContent(), /clicks: 10/);
    // island hydrated in the frame: clicks change the count (retry: a cold dev server may reload the frame once after dependency optimisation)
    await waitFor(async () => { await btn.click({ timeout: 5000 }); return /clicks: 1[1-9]/.test(await btn.textContent()); }, "island hydrates in the preview frame", 40000, log);
    await page.getByRole("button", { name: "Mobile 375" }).click();
    assert.equal(await page.locator(".tile").evaluate((e) => e.style.width), "375px");
    assert.match(page.url(), /[?&]vp=375/); assert.match(page.url(), /s=from-ten/); // deep link follows the UI
    await page.getByRole("button", { name: "HTML" }).click();
    await waitFor(async () => /cfl-island/.test(await page.locator("pre").first().textContent()), "html tab");
    assert.match(page.url(), /tab=html/);
    // deep link in a fresh page: all states of one component, tablet, no click needed
    await page.goto(`${B}/__preview?c=patterns/atoms/Button&vp=768`);
    await page.locator(".tile").nth(2).waitFor();
    assert.equal(await page.locator(".tile").count(), 3);
    assert.equal(await page.locator(".tile").first().evaluate((e) => e.style.width), "768px");
    assert.match(await page.locator("#mocks").textContent(), /MOCK=1 on/);
    await page.fill("#q", "grid"); assert.equal(await page.locator("#nav .c").count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }

  // live discovery: a new component + states file appears without a restart of the page
  mkdirSync(join(dir, "app/patterns/atoms/Pill"), { recursive: true });
  writeFileSync(join(dir, "app/patterns/atoms/Pill/Pill.tsx"), "export default function Pill({ t }: { t: string }) { return <i>{t}</i>; }\n");
  writeFileSync(join(dir, "app/patterns/atoms/Pill/Pill.states.ts"), 'import { defineStates } from "cf-lite/preview";\nimport Pill from "./Pill";\nexport default defineStates(Pill, { new: { t: "fresh" } });\n');
  await waitFor(async () => (await json(`${B}/__preview/api/manifest`)).items.some((i) => i.id === "patterns/atoms/Pill"), "new component discovered", 40000, log);
  assert.equal(await waitFor(async () => { const t = await frag("patterns/atoms/Pill", "new"); return t.includes("fresh") && t; }, "new component renders", 40000, log), "<i>fresh</i>\n");
  rmSync(join(dir, "app/patterns/atoms/Pill"), { recursive: true });
  await waitFor(async () => !(await json(`${B}/__preview/api/manifest`)).items.some((i) => i.id === "patterns/atoms/Pill"), "removed component gone", 40000, log);
  // a mock edit is picked up
  writeFileSync(join(dir, "mocks/api/products.json"), '[{"id":7,"name":"Edited","price":1}]\n');
  await waitFor(async () => (await json(`${B}/api/products`))[0]?.name === "Edited", "mock edit served", 40000, log);
  await sleep(1500); // two saves a few ms apart can coalesce in the file watcher; a person saving twice is slower than that
  writeFileSync(join(dir, "mocks/api/products.json"), readFileSync(join(src, "mocks/api/products.json")));
  await waitFor(async () => (await json(`${B}/api/products`))[0]?.name === "Oak shelf", "mock restored", 40000, log);
});
console.log("dx e2e OK: dev preview + mocks (MOCK=1)");

// ---- dev without MOCK: inert -----------------------------------------------------------------------------------------------
await vite({ MOCK: "" }, async (B) => {
  const m = await json(`${B}/__preview/api/manifest`);
  assert.equal(m.mock.enabled, false); assert.equal(m.mock.routes.length, 4, "mocks are still listed (so the UI can say how to turn them on)");
  const r = await fetch(`${B}/api/products`);
  assert.equal(r.headers.get("x-cfl-mock"), null); assert.doesNotMatch(await r.text(), /Oak shelf/);
  assert.doesNotMatch(await (await fetch(`${B}/products`, { headers: { accept: "text/html" } })).text(), /Oak shelf/);
});
console.log("dx e2e OK: dev without MOCK");

// ---- cfl export ------------------------------------------------------------------------------------------------------------
const cf = (...a) => spawnSync(process.execPath, [cli, ...a], { cwd: dir, encoding: "utf8" });
const tree = (d, p = "") => readdirSync(join(d, p), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(d, `${p}${e.name}/`) : [`${p}${e.name}`])).sort();
const snap = (d) => Object.fromEntries(tree(d).map((f) => [f, readFileSync(join(d, f), "utf8")]));
let r = cf("export", "--mock"); assert.equal(r.status, 0, r.stderr + r.stdout);
const out = join(dir, "patterns-export");
assert.deepEqual(tree(out), ["assets.json", "islands/Counter/default.html", "islands/Counter/from-ten.html", "manifest.json", "patterns/atoms/Button/default.html", "patterns/atoms/Button/disabled.html", "patterns/atoms/Button/ghost.html", "patterns/molecules/ProductCard/default.html", "patterns/molecules/ProductCard/expensive.html", "patterns/molecules/ProductCard/sold-out.html", "patterns/organisms/ProductGrid/default.html", "patterns/organisms/ProductGrid/empty.html"]);
const first = snap(out);
assert.equal(first["patterns/atoms/Button/ghost.html"], '<button type="button" class="btn btn--ghost">Details</button>\n');
assert.match(first["patterns/organisms/ProductGrid/default.html"], /Oak shelf[\s\S]*Linen sofa/); // states import the mock JSON: same data as MOCK=1 routes
assert.equal(JSON.parse(first["assets.json"]).source, null, "no build yet: empty asset manifest");
assert.doesNotMatch(first["manifest.json"], /\d{4}-\d\d-\d\dT|\/home\/|\/tmp\//, "no timestamps or absolute paths");
r = cf("export", "--mock"); assert.equal(r.status, 0); assert.deepEqual(snap(out), first, "second export is byte-identical");
assert.match(r.stdout, /0 written, 0 removed/);
r = cf("export", "--mock", "--check"); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /up to date/);
writeFileSync(join(out, "patterns/atoms/Button/ghost.html"), "edited by hand\n");
r = cf("export", "--check"); assert.equal(r.status, 1); assert.match(r.stderr, /~ patterns\/atoms\/Button\/ghost\.html/);
assert.equal(readFileSync(join(out, "patterns/atoms/Button/ghost.html"), "utf8"), "edited by hand\n", "--check never writes");
r = cf("export"); assert.equal(r.status, 0); assert.deepEqual(snap(out), first, "re-export repairs the hand edit");
// a removed state disappears from the export (stale cleanup), and a different --out works
writeFileSync(join(dir, "app/patterns/atoms/Button/Button.states.ts"), 'import { defineStates } from "cf-lite/preview";\nimport Button from "./Button";\nexport default defineStates(Button, { default: { label: "Add to cart" } });\n');
r = cf("export"); assert.equal(r.status, 0, r.stderr);
assert.ok(!existsSync(join(out, "patterns/atoms/Button/ghost.html")) && !existsSync(join(out, "patterns/atoms/Button/disabled.html")));
assert.deepEqual(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).components.find((c) => c.id === "patterns/atoms/Button").states.map((s) => s.name), ["default"]);
r = cf("export", "--out", "elsewhere"); assert.equal(r.status, 0); assert.ok(existsSync(join(dir, "elsewhere/manifest.json")));
// a component that throws fails the export (non-zero, nothing half-written)
writeFileSync(join(dir, "app/patterns/atoms/Button/Button.tsx"), 'export default function Button(): never { throw new Error("kaboom"); }\n');
const before = snap(out);
r = cf("export"); assert.equal(r.status, 1); assert.match(r.stderr, /Button\/default: .*kaboom/); assert.deepEqual(snap(out), before);
cpSync(join(src, "app/patterns/atoms/Button"), join(dir, "app/patterns/atoms/Button"), { recursive: true, force: true });
console.log("dx e2e OK: cfl export");

// ---- production build ------------------------------------------------------------------------------------------------------
r = cf("build"); assert.equal(r.status, 0, r.stderr + r.stdout);
const built = JSON.parse(readFileSync(join(dir, "dist/cf_lite_site_patterns/wrangler.json"), "utf8"));
assert.ok(!JSON.stringify(built.assets).includes("__preview"), "run_worker_first has no /__preview in production");
const worker = readFileSync(join(dir, "dist/cf_lite_site_patterns/index.js"), "utf8");
for (const m of ["createPreview", "x-cfl-mock", "cf-lite.mock-fetch", "preview render error", "Limited edition", "Oak shelf"]) assert.ok(!worker.includes(m), `production Worker must not contain "${m}"`);
assert.ok(!readdirSync(join(dir, "dist/client/assets")).some((f) => /preview|mock/i.test(f)));
r = cf("export"); assert.equal(r.status, 0, r.stderr);
const assets = JSON.parse(readFileSync(join(out, "assets.json"), "utf8"));
assert.equal(assets.source, "dist/client"); assert.ok(assets.css.length >= 1 && assets.js.length >= 1); assert.match(assets.islands.runtime, /^\/assets\/islands-/);
assert.ok(assets.css.every((f) => /^assets\/.*\.css$/.test(f.file) && /^[0-9a-f]{64}$/.test(f.sha256)));
{ // the built Worker answers the app, but /__preview and mocks are gone
  const port = 19600 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] }); kids.push(child);
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  await waitFor(() => log.includes("Ready on"), "wrangler dev", 60000, () => log);
  const B = `http://localhost:${port}`;
  const idx = await fetch(`${B}/__preview/api/manifest`); const t = await idx.text();
  assert.doesNotMatch(t, /"adapterBind"|"items"/, "no preview manifest in production");
  const fr = await (await fetch(`${B}/__preview/frame/patterns/atoms/Button?s=default`)).text(); assert.doesNotMatch(fr, /data-preview/);
  assert.doesNotMatch(await (await fetch(`${B}/api/products`)).text(), /Oak shelf/, "no mocks in production");
  assert.match(await (await fetch(`${B}/`)).text(), /Patterns demo/);
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
}
console.log("dx e2e OK: production build has no preview/mocks");

#!/usr/bin/env node
// View Transitions (docs/view-transitions.md) in a real build + real Chromium. Copies examples/site, builds it twice (option off / on),
// serves dist/client statically, and checks: the shell carries the rule + router meta only when enabled; a document navigation gets a
// cross-document transition (`pageswap` event has a viewTransition); an SPA navigation runs inside document.startViewTransition without a
// reload; prefers-reduced-motion turns both off; the option-off build has neither.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const src = new URL("../examples/site/", import.meta.url).pathname;
const cli = new URL("../packages/cf-lite/dist/cli.js", import.meta.url).pathname;
const root = new URL(`../e2e/.tmp/vt-${process.pid}/`, import.meta.url).pathname;
const build = (name, opt) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler)([\\/]|$)/.test(p.slice(src.length)) });
  if (opt) { const f = join(dir, "vite.config.ts"); writeFileSync(f, readFileSync(f, "utf8").replace("cfLite({ renderer: react() })", `cfLite({ renderer: react(), viewTransitions: ${opt} })`)); }
  const r = spawnSync(process.execPath, [cli, "build"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return join(dir, "dist/client");
};
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const serve = (dir) => new Promise((res) => {
  const s = createServer((req, rsp) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!extname(p)) p = join(p, "index.html");
    const f = join(dir, p);
    if (!existsSync(f)) { rsp.statusCode = 404; return rsp.end("nf"); }
    rsp.setHeader("content-type", MIME[extname(f)] ?? "application/octet-stream"); rsp.end(readFileSync(f));
  }).listen(0, "127.0.0.1", () => res(s));
});

const off = build("off", null), on = build("on", "{ router: true }"), docOnly = build("doc", "true");
const shell = (d) => readFileSync(join(d, "index.html"), "utf8");
assert.doesNotMatch(shell(off), /view-transition/);
assert.match(shell(on), /@view-transition\{navigation:auto\}/); const spaShell = (d) => readFileSync(join(d, "app/dashboard/index.html"), "utf8"); // SPA pages keep the entry script; static pages drop all scripts
const entryJs = (d) => readFileSync(join(d, spaShell(d).match(/src="\/(assets\/[^"]+\.js)"/)[1]), "utf8");
const has = (d) => /prefers-reduced-motion: reduce/.test(spaShell(d) + entryJs(d)); // only the router hook mentions it (the CSS rule says no-preference)
assert.equal(has(on), true, "router option: the SPA entry carries the transition code");
assert.equal(has(docOnly), false, "document-only: no transition code in the client entry");
assert.equal(has(off), false, "off: no transition code in the client entry");
assert.match(readFileSync(join(on, "about/index.html"), "utf8"), /@view-transition/, "prerendered pages derive from the shell");

const swapOf = async (page, from, clickHref) => {
  await page.goto(from);
  await page.evaluate(() => { sessionStorage.removeItem("swap"); addEventListener("pageswap", (e) => sessionStorage.setItem("swap", e.viewTransition ? "vt" : "none")); });
  await page.evaluate((h) => document.querySelector(`a[href='${h}']`).click(), clickHref);
  await page.waitForURL((u) => u.pathname.startsWith(clickHref)); await page.waitForTimeout(400);
  return page.evaluate(() => sessionStorage.getItem("swap"));
};
const spaNav = async (page, base) => {
  await page.goto(base + "/app/dashboard/");
  await page.waitForSelector("[data-testid=l-app]");
  await page.evaluate(() => { window.__vt = 0; window.__alive = 1; const o = document.startViewTransition?.bind(document); if (o) document.startViewTransition = (cb) => { window.__vt++; return o(cb); }; });
  await page.click("a[href='/app/settings']");
  await page.waitForSelector("text=Settings (spa)");
  return { vt: await page.evaluate(() => window.__vt), alive: await page.evaluate(() => window.__alive === 1), title: await page.title() };
};

const br = await chromium.launch();
const servers = [];
try {
  for (const [name, dir, expectDoc, expectSpa] of [["off", off, false, false], ["doc-only", docOnly, true, false], ["on", on, true, true]]) {
    const s = await serve(dir); servers.push(s);
    const base = `http://127.0.0.1:${s.address().port}`;
    const ctx = await br.newContext(); const page = await ctx.newPage();
    const swap = await swapOf(page, base + "/", "/about");
    assert.equal(swap, expectDoc ? "vt" : "none", `${name}: cross-document transition`);
    const spa = await spaNav(page, base);
    assert.equal(spa.alive, true, `${name}: SPA navigation must not reload the document`);
    assert.equal(spa.vt, expectSpa ? 1 : 0, `${name}: startViewTransition calls on SPA navigation`);
    assert.equal(spa.title, "Settings — site");
    await ctx.close();
    if (name === "on") { // reduced motion: neither mechanism runs
      const rctx = await br.newContext({ reducedMotion: "reduce" }); const rp = await rctx.newPage();
      assert.equal(await swapOf(rp, base + "/", "/about"), "none", "reduced motion: no cross-document transition");
      const rs = await spaNav(rp, base);
      assert.equal(rs.vt, 0, "reduced motion: router must not start a transition"); assert.equal(rs.alive, true);
      await rctx.close();
    }
    console.log(`view transitions e2e [${name}]: document=${swap} spa=${spa.vt}`);
  }
  console.log("view transitions e2e OK");
} finally {
  await br.close().catch(() => {}); servers.forEach((s) => s.close()); rmSync(root, { recursive: true, force: true });
}
process.exit(0);

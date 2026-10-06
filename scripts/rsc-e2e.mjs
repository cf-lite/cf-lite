#!/usr/bin/env node
// RSC spike e2e (docs/design/rsc.md): build examples/site-rsc, `vite preview` it (workerd), check the rsc route
// (streamed Suspense, Flight payload, client-island hydration), the ssr control, and that SPA/static routes still work.
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const root = new URL("../", import.meta.url).pathname, cwd = root + "examples/site-rsc", port = 28790;
const b = spawnSync(process.execPath, [root + "packages/cf-lite/dist/cli.js", "build"], { cwd, encoding: "utf8" });
assert.equal(b.status, 0, b.stdout + b.stderr);
const srv = spawn(process.execPath, [root + "node_modules/vite/bin/vite.js", "preview", "--port", String(port), "--strictPort"], { cwd, stdio: "ignore" });
const base = `http://localhost:${port}`;
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + "/api/hello"); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  const get = async (p) => { const r = await fetch(base + p); return { s: r.status, t: await r.text() }; };
  const rsc = await get("/rsc?ms=50"); assert.equal(rsc.s, 200); assert.match(rsc.t, /rendered by: rsc \(cf-lite\)/); assert.match(rsc.t, /__FLIGHT_DATA/);
  const fl = await get("/rsc?__rsc"); assert.match(fl.t, /"Counter"/);
  assert.equal((await get("/ssr?ms=0")).s, 200); assert.equal((await get("/api/hello")).s, 200);
  assert.doesNotMatch((await get("/")).t, /FLIGHT|\.rsc/); // static page: no RSC runtime
  // --- P2: streaming order, request context + loader + bindings, head, layouts, cache/tags, notFound/redirect/error ---
  {
    const r = await fetch(base + "/rsc?ms=400"), rd = r.body.getReader(), dec = new TextDecoder();
    const first = dec.decode((await rd.read()).value); let rest = "";
    for (;;) { const { done, value } = await rd.read(); if (done) break; rest += dec.decode(value); }
    assert.match(first, /slow-fallback/); assert.doesNotMatch(first, /slow data after/); assert.match(rest, /slow data after (<!-- -->)?400/); // shell flushed before the slow boundary
  }
  const num = (t) => Number(/renders:(?:<!-- -->)?(\d+)/.exec(t)[1]);
  const d1 = await fetch(base + "/rsc-data?id=1"), d1t = await d1.text();
  assert.equal(d1.status, 200); assert.equal(d1.headers.get("x-cf-lite-cache"), "MISS");
  assert.match(d1t, /data (<!-- -->)?1/); assert.match(d1t, /hello-env/); assert.match(d1t, /<title>data 1<\/title>/); assert.match(d1t, /og:title/);
  assert.match(d1t, /name="description" content="rsc layout default"/); assert.match(d1t, /data-testid="rsc-root"/); assert.match(d1t, /id="rsc-nav"/); // head + layout
  assert.match(d1t, /id="ctx"[^>]*>hello-env/); // getRequest(): env, url, loader data inside an async server component
  const d1b = await fetch(base + "/rsc-data?id=1"), d1bt = await d1b.text();
  assert.equal(d1b.headers.get("x-cf-lite-cache"), "HIT"); assert.equal(num(d1bt), num(d1t)); // HTML + inline payload served from cache, no re-render
  const f1 = await fetch(base + "/rsc-data?id=1&__rsc"), f1t = await f1.text(); // payload: its own key, same path tag
  assert.equal(f1.headers.get("x-cf-lite-cache"), "MISS"); assert.match(f1t, /slow done|\$L/);
  assert.equal((await fetch(base + "/rsc-data?id=1&__rsc")).headers.get("x-cf-lite-cache"), "HIT");
  await fetch(base + "/rsc-data?id=2").then((r) => r.text());
  const purge = (body) => fetch(base + "/api/cache/purge", { method: "POST", headers: { authorization: "Bearer e2e-purge-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await purge({ tags: ["rsc:1"] })).status, 200);
  const d1c = await fetch(base + "/rsc-data?id=1"), d1ct = await d1c.text();
  assert.equal(d1c.headers.get("x-cf-lite-cache"), "MISS"); assert.ok(num(d1ct) > num(d1t)); // tag purge invalidated the HTML entry
  assert.equal((await fetch(base + "/rsc-data?id=1&__rsc")).headers.get("x-cf-lite-cache"), "MISS"); // ... and the payload entry
  assert.equal((await fetch(base + "/rsc-data?id=2")).headers.get("x-cf-lite-cache"), "HIT"); // other tag untouched
  assert.equal((await purge({ paths: ["/rsc-data"] })).status, 200);
  assert.equal((await fetch(base + "/rsc-data?id=2")).headers.get("x-cf-lite-cache"), "MISS"); // path tag covers every variant
  const dp = await get("/nested/deep"); assert.equal(dp.s, 200);
  assert.match(dp.t, /data-testid="rsc-root"/); assert.match(dp.t, /data-testid="rsc-nested"/); assert.match(dp.t, /<title>deep page<\/title>/); assert.match(dp.t, /name="x-url" content="\/nested\/deep"/); assert.match(dp.t, /content="nested layout"/); assert.doesNotMatch(dp.t, /content="rsc layout default"/);
  const nf = await get("/rsc-nf"); assert.equal(nf.s, 404); assert.match(nf.t, /custom rsc not found/);
  assert.equal((await get("/rsc-loader-nf")).s, 404);
  const rdr = await fetch(base + "/rsc-redirect", { redirect: "manual" }); assert.equal(rdr.status, 302); assert.equal(rdr.headers.get("location"), "/rsc-data?id=r");
  const er = await get("/rsc-err"); assert.equal(er.s, 500); assert.match(er.t, /custom rsc error/); assert.doesNotMatch(er.t, /SECRET-boom/); assert.match(er.t, /id="err-digest"[^>]*>[^<]+/);
  const late = await get("/rsc-late"); assert.equal(late.s, 200); assert.match(late.t, /late-shell/); // status already sent: degraded client-side
  const br = await chromium.launch(), p = await br.newPage(), errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(base + "/rsc", { waitUntil: "networkidle" }); await p.waitForSelector("#slow"); await p.click("#counter"); await p.click("#counter");
  assert.match(await p.textContent("#counter"), /clicks: 2/);
  await p.goto(base + "/ssr", { waitUntil: "networkidle" }); await p.click("#counter"); assert.match(await p.textContent("#counter"), /clicks: 1/);
  await p.goto(base + "/about", { waitUntil: "networkidle" }); assert.match(await p.textContent("body"), /About/);
  await p.goto(base + "/rsc-late", { waitUntil: "networkidle" }); await p.waitForSelector("#nf-boundary"); // post-flush notFound -> not-found boundary
  await p.goto(base + "/rsc-late?mode=redirect", { waitUntil: "networkidle" }); await p.waitForURL(/\/rsc-data\?id=late/); // post-flush redirect -> client navigation
  await p.waitForSelector("#slow");
  // --- P3: zero-JS pure pages, per-route island chunks, soft navigation, prefetch, scroll restore, form actions + hostile inputs ---
  {
    const pure = await get("/rsc-pure"); assert.equal(pure.s, 200); assert.doesNotMatch(pure.t, /<script|__FLIGHT_DATA/); assert.match(pure.t, /pure server page/);
    const jsReqs = async (path) => { const q = []; const pg = await br.newPage(); pg.on("request", (r) => /\.js(\?|$)/.test(r.url()) && q.push(r.url())); await pg.goto(base + path, { waitUntil: "networkidle" }); await pg.close(); return q; };
    assert.deepEqual(await jsReqs("/rsc-pure"), []); // zero client JS
    assert.equal((await jsReqs("/rsc-data")).filter((u) => /counter|toggle|rsc-other/.test(u)).length, 0); // island chunks only where used
    const r1 = await jsReqs("/rsc"); assert.ok(r1.some((u) => /counter/.test(u)) && !r1.some((u) => /toggle|rsc-other/.test(u)), r1.join());
    const r2 = await jsReqs("/rsc-other"); assert.ok(r2.some((u) => /toggle|rsc-other/.test(u)) && !r2.some((u) => /counter/.test(u)), r2.join());

    // soft navigation: same document (marker survives), title/head update, back restores, non-RSC target = full load
    const sp = await br.newPage(), flightReqs = []; sp.on("request", (r) => /__rsc/.test(r.url()) && flightReqs.push(r.url()));
    await sp.goto(base + "/rsc", { waitUntil: "networkidle" }); await sp.waitForSelector("#slow");
    await sp.evaluate(() => { window.__marker = 1; });
    await sp.hover("#l-form"); await sp.waitForTimeout(400);
    assert.equal(flightReqs.filter((u) => u.includes("/rsc-form")).length, 1); // hover prefetch
    await sp.click("#l-form"); await sp.waitForURL(/\/rsc-form$/); await sp.waitForSelector("#names", { state: "attached" });
    assert.equal(await sp.evaluate(() => window.__marker), 1); assert.equal(await sp.title(), "form");
    assert.equal(flightReqs.filter((u) => u.includes("/rsc-form")).length, 1); // the prefetched payload was consumed, not refetched
    await sp.click("#l-data"); await sp.waitForURL(/\/rsc-data$/); await sp.waitForSelector("#fb, #slow"); assert.equal(await sp.title(), "data 1"); assert.equal(await sp.evaluate(() => window.__marker), 1);
    await sp.goBack(); await sp.waitForURL(/\/rsc-form$/); await sp.waitForSelector("#names", { state: "attached" }); assert.equal(await sp.evaluate(() => window.__marker), 1);
    await sp.click("#l-about"); await sp.waitForURL(/\/about\/?$/); assert.equal(await sp.evaluate(() => window.__marker), undefined); // SPA route: full page load

    // viewport prefetch + scroll restoration
    flightReqs.length = 0;
    await sp.goto(base + "/rsc-tall", { waitUntil: "networkidle" }); await sp.waitForTimeout(300);
    assert.equal(flightReqs.filter((u) => u.includes("id=vp")).length, 0); // far below the fold: not yet
    await sp.evaluate(() => window.scrollTo(0, 2500)); await sp.waitForTimeout(400);
    assert.equal(flightReqs.filter((u) => u.includes("id=vp")).length, 1);
    await sp.evaluate(() => { window.__marker = 2; }); const y0 = await sp.evaluate(() => scrollY); assert.ok(y0 > 1500);
    await sp.click("#bottom-link"); await sp.waitForURL(/\/rsc-other$/); await sp.waitForSelector("#toggle");
    assert.equal(await sp.evaluate(() => window.__marker), 2); assert.ok(await sp.evaluate(() => scrollY) < 50);
    await sp.goBack(); await sp.waitForURL(/\/rsc-tall$/); await sp.waitForTimeout(300);
    assert.ok(Math.abs(await sp.evaluate(() => scrollY) - y0) < 80, "scroll restored: " + await sp.evaluate(() => scrollY));

    // form action through the client: payload refreshed in place, island state kept, no document load
    await sp.goto(base + "/rsc-form", { waitUntil: "networkidle" }); await sp.evaluate(() => { window.__marker = 3; });
    await sp.click("#counter"); await sp.fill("#name", "alice"); await sp.click("#sign");
    await sp.waitForFunction(() => document.querySelector("#names")?.textContent?.includes("alice"));
    assert.equal(await sp.evaluate(() => window.__marker), 3); assert.match(await sp.textContent("#counter"), /clicks: 1/); assert.match(await sp.textContent("#last"), /\/rsc-form/);
    await sp.close();

    // no-JS path + hostile requests against the action endpoint
    const form = await get("/rsc-form"); const idField = /name="(\$ACTION_ID_[^"]+)"/.exec(form.t)?.[1]; assert.ok(idField, "form carries $ACTION_ID_"); const realId = idField.slice("$ACTION_ID_".length), file = realId.split("#")[0];
    const names = async () => [...(await get("/rsc-form")).t.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
    const same = { origin: base, "sec-fetch-site": "same-origin" };
    const post = (fields, headers = same, path = "/rsc-form") => { const fd = new FormData(); for (const [k, v] of fields) fd.append(k, v); return fetch(base + path, { method: "POST", body: fd, redirect: "manual", headers }); };
    const before = (await names()).length;
    let r = await post([[idField, ""], ["name", "bob"]]); assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/rsc-form"); assert.ok((await names()).includes("bob"));
    const after = (await names()).length; assert.equal(after, before + 1 + 0 * 1); // alice (browser) is included in `before`
    const noop = async (res, status, label) => { assert.equal(res.status, status, label); await res.text(); assert.equal((await names()).length, after, label + ": action must not run"); };
    await noop(await post([[idField, ""], ["name", "x"]], { origin: "http://evil.example", "sec-fetch-site": "cross-site" }), 403, "cross-origin");
    await noop(await post([[idField, ""], ["name", "x"]], { origin: "http://evil.example" }), 403, "cross-origin (no fetch metadata)");
    await noop(await post([[idField, ""], ["name", "x"]], {}), 403, "no origin");
    await noop(await post([[idField, ""], ["name", "x"]], { "x-e2e-rate": "deny", ...same }), 429, "rate-limit hook");
    for (const bad of [`${file}#nope`, `${file}#constructor`, `${file}#__proto__`, "deadbeef#sign", "../../etc/passwd#x", "x#y z", "nohash", `${file}#sign#sign`, "a".repeat(400) + "#b"]) await noop(await post([["$ACTION_ID_" + bad, ""], ["name", "x"]]), 400, "forged id " + bad.slice(0, 20));
    await noop(await post([["$ACTION_REF_1", ""], ["$ACTION_1:0", "[]"], ["name", "x"]]), 400, "bound ref");
    await noop(await post([[idField, ""], ["$ACTION_ID_" + realId.replace("#sign", "#clear"), ""]]), 400, "two ids");
    await noop(await post([["name", "x"]]), 400, "no id");
    await noop(await post([[idField, ""], ["name", "x".repeat(10_000)]]), 413, "oversized (content-length)");
    const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("a=" + "y".repeat(10_000))); c.close(); } }); // no content-length
    await noop(await fetch(base + "/rsc-form", { method: "POST", body: chunked, duplex: "half", redirect: "manual", headers: { ...same, "content-type": "application/x-www-form-urlencoded" } }), 413, "oversized (streamed)");
    await noop(await fetch(base + "/rsc-form", { method: "POST", body: JSON.stringify([idField]), headers: { ...same, "content-type": "application/json" } }), 415, "json body");
    await noop(await fetch(base + "/rsc-form", { method: "POST", body: "0:[]", headers: { ...same, "content-type": "text/x-component" } }), 415, "flight reply body");
    await noop(await fetch(base + "/rsc-form", { method: "POST", body: "--x\r\ngarbage", headers: { ...same, "content-type": "multipart/form-data; boundary=x" } }), 400, "broken multipart");
    await noop(await post([[idField, ""], ["name", "x"]], same, "/rsc-data"), 400, "real action id posted to a route that does not export it");
    await noop(await post([["$ACTION_ID_" + realId.replace("#sign", "#clear"), ""]]), 400, "registered action not in this route's allowlist");
    // errors: digest only, redirect/notFound sentinels
    r = await post([[idField, ""], ["name", "boom"]]); const bt = await r.text(); assert.equal(r.status, 500); assert.doesNotMatch(bt, /SECRET-action-boom/); assert.match(bt, /custom rsc error|digest/);
    r = await fetch(base + "/rsc-form", { method: "POST", redirect: "manual", headers: { ...same, accept: "text/x-component" }, body: (() => { const f = new FormData(); f.append(idField, ""); f.append("name", "boom"); return f; })() }); assert.equal(r.status, 500); assert.doesNotMatch(await r.text(), /SECRET-action-boom/);
    r = await post([[idField, ""], ["name", "go"]]); assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/rsc-pure");
    r = await post([[idField, ""], ["name", "nf"]]); assert.equal(r.status, 404);
    r = await fetch(base + "/rsc-form", { method: "POST", headers: { ...same, accept: "text/x-component" }, body: (() => { const f = new FormData(); f.append(idField, ""); f.append("name", "go"); return f; })() }); assert.equal(r.headers.get("x-cf-lite-redirect"), "/rsc-pure");
    assert.equal((await names()).length, after);
  }
  // --- P4: nonce CSP (security() strict): bootstrap + every inline Flight script carries the nonce; hydration works with CSP enforced; never cached ---
  {
    const r = await fetch(base + "/rsc-csp"), t = await r.text(), csp = r.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]; assert.ok(nonce, "csp header carries a nonce: " + csp);
    const scripts = [...t.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]); assert.ok(scripts.length >= 2, "bootstrap + flight scripts present");
    for (const sc of scripts) assert.ok(sc.includes(`nonce="${nonce}"`), "script without nonce: " + sc);
    const r2 = await fetch(base + "/rsc-csp"), n2 = /'nonce-([^']+)'/.exec(r2.headers.get("content-security-policy") ?? "")?.[1]; await r2.text(); assert.notEqual(n2, nonce); // fresh nonce per request
    const pg = await br.newPage(), viol = []; pg.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && viol.push(m.text())); pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.goto(base + "/rsc-csp", { waitUntil: "networkidle" }); await pg.waitForSelector("#slow"); await pg.click("#counter"); await pg.click("#counter");
    assert.match(await pg.textContent("#counter"), /clicks: 2/); assert.equal(await pg.evaluate(() => window.__headRan), 1, "head script ran under the nonce CSP"); assert.deepEqual(viol, []); await pg.close();
    // cache key: a keepParams allowlist without __rsc must not let the Flight variant fill (or read) the HTML entry
    const ct = async (p) => { const x = await fetch(base + p); await x.text(); return [x.headers.get("content-type"), x.headers.get("x-cf-lite-cache")]; };
    assert.match((await ct("/rsc-key?id=1&__rsc=1"))[0], /text\/x-component/); assert.match((await ct("/rsc-key?id=1"))[0], /text\/html/);
    assert.match((await ct("/rsc-key?id=1&__rsc=1"))[0], /text\/x-component/); assert.deepEqual(await ct("/rsc-key?id=1"), ["text/html;charset=utf-8", "HIT"]);
  }
  await br.close(); assert.deepEqual(errs, []);
  console.log("rsc e2e OK");
} finally { srv.kill(); }

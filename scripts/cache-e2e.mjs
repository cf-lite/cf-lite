// Edge caching (cf-lite/modules/cache) under local workerd: miss -> hit -> stale -> revalidate, tag/path purge, auth bypass.
// Runs the demo twice: tag ledger in KV, then in D1 (CF_CACHE_STORE).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const demo = new URL("../examples/demo/", import.meta.url).pathname;
const require = createRequire(demo);
const build = spawnSync(process.execPath, [join(demo, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: demo, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = "e2e-" + Math.random().toString(36).slice(2);

async function run(store) {
  const state = mkdtempSync(join(tmpdir(), "cfl-cache-e2e-"));
  const port = 19300 + Math.floor(Math.random() * 500);
  const args = [wr, "dev", "--port", String(port), "--persist-to", state, "--var", `CACHE_PURGE_TOKEN:${TOKEN}`, "--var", `CF_CACHE_STORE:${store}`, "--show-interactive-dev-session=false"];
  const child = spawn(process.execPath, args, { cwd: demo, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
  process.on("exit", stop);
  try {
    for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
    assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
    const B = `http://localhost:${port}`;
    // "Ready on" can precede a workerd/miniflare reload (config + asset dir settle); one CI run saw a transient 500 on the first auth-checked request.
    // The 401 path itself is deterministic (0/150 non-401 locally), so wait for the Worker to answer consistently before asserting anything.
    for (let ok = 0, i = 0; ok < 3 && i < 60; i++) { ok = (await fetch(B + "/api/cache/purge", { method: "POST" }).then((r) => r.status, () => 0)) === 401 ? ok + 1 : 0; await sleep(ok ? 300 : 500); }
    const page = async (path, headers) => {
      const r = await fetch(B + path, { headers, redirect: "manual" });
      const t = await r.text();
      return { status: r.headers.get("x-cf-lite-cache"), nonce: /nonce:(?:<!-- -->)?(\w+)/.exec(t)?.[1], r, t };
    };
    const purge = (body, token = TOKEN) => fetch(B + "/api/cache/purge", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const tag = `[${store}]`;

    // miss -> hit (same render), tracking params share the entry, real params don't
    let a = await page("/cached/a"); assert.equal(a.status, "MISS", tag + " first request misses"); assert.ok(a.nonce);
    assert.match(a.r.headers.get("cache-control"), /^public, max-age=0, s-maxage=2, stale-while-revalidate=4$/);
    let b = await page("/cached/a"); assert.equal(b.status, "HIT"); assert.equal(b.nonce, a.nonce); assert.equal(b.t, a.t, "hit serves the identical body");
    assert.ok(!b.r.headers.has("x-cfl-t") && b.r.headers.has("age"));
    b = await page("/cached/a?utm_source=x&fbclid=y"); assert.equal(b.status, "HIT"); assert.equal(b.nonce, a.nonce);
    b = await page("/cached/a?page=2"); assert.equal(b.status, "MISS"); assert.notEqual(b.nonce, a.nonce);

    // past maxAge: stale is served instantly, a background render refreshes it
    await sleep(2300);
    b = await page("/cached/a"); assert.equal(b.status, "STALE", tag + " past maxAge within swr"); assert.equal(b.nonce, a.nonce);
    await sleep(600);
    b = await page("/cached/a"); assert.equal(b.status, "HIT", tag + " revalidated in background"); assert.notEqual(b.nonce, a.nonce);
    const fresh = b.nonce;

    // past maxAge + swr: a real miss again
    await sleep(6500);
    b = await page("/cached/a"); assert.equal(b.status, "MISS", tag + " expired entry is not served"); assert.notEqual(b.nonce, fresh);

    // auth bypass: never served from / written to the cache
    const anon = (await page("/cached/a")).nonce;
    const u1 = await page("/cached/a", { cookie: "sso=whatever" }), u2 = await page("/cached/a", { cookie: "sso=whatever" });
    assert.deepEqual([u1.status, u2.status], ["BYPASS", "BYPASS"]); assert.notEqual(u1.nonce, u2.nonce); assert.notEqual(u1.nonce, anon);
    assert.equal(u1.r.headers.get("cache-control"), "private, no-cache");
    assert.equal((await page("/cached/a", { authorization: "Bearer x" })).status, "BYPASS");
    b = await page("/cached/a"); assert.equal(b.status, "HIT"); assert.equal(b.nonce, anon, "authenticated renders did not pollute the entry");

    // purge endpoint: closed without the right token
    const bad = await purge({ tags: ["cached"] }, "wrong");
    assert.equal(bad.status, 401, `wrong-token purge: ${bad.status} ${(await bad.text()).slice(0, 200)}\n--- worker log tail ---\n${log.slice(-1500)}`);
    assert.equal((await fetch(B + "/api/cache/purge", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await page("/cached/a")).status, "HIT", "a rejected purge changed nothing");

    // tag purge
    const c1 = await page("/cached/c"); await sleep(25);
    const pr = await purge({ tags: ["cached"] }); assert.equal(pr.status, 200); assert.deepEqual((await pr.json()).tags, ["cached"]);
    await sleep(25);
    for (const p of ["/cached/a", "/cached/c"]) { b = await page(p); assert.equal(b.status, "MISS", tag + " tag purge " + p); }
    b = await page("/cached/c"); assert.equal(b.status, "HIT"); assert.notEqual(b.nonce, c1.nonce);

    // path purge hits every query variant of that path only
    await page("/cached/a?q=1"); await page("/cached/c"); await sleep(25);
    assert.equal((await purge({ paths: ["/cached/a"] })).status, 200); await sleep(25);
    assert.deepEqual([(await page("/cached/a")).status, (await page("/cached/a?q=1")).status, (await page("/cached/c")).status], ["MISS", "MISS", "HIT"]);

    // function form: decided from loader data; unknown posts are never cached; per-post tag purge
    let f = await page("/cached-fn/1"); assert.equal(f.status, "MISS");
    const f1 = await page("/cached-fn/1"); assert.equal(f1.status, "HIT"); assert.equal(f1.nonce, f.nonce);
    assert.deepEqual([(await page("/cached-fn/missing")).status, (await page("/cached-fn/missing")).status], ["BYPASS", "BYPASS"]);
    await page("/cached-fn/2"); await sleep(25); await purge({ tags: ["post:1"] }); await sleep(25);
    assert.deepEqual([(await page("/cached-fn/1")).status, (await page("/cached-fn/2")).status], ["MISS", "HIT"]);

    // purge input validation
    assert.equal((await purge({ tags: ["a,b"] })).status, 400);
    console.log(`cache e2e OK (${store})`);
  } finally {
    stop();
    rmSync(state, { recursive: true, force: true });
  }
}
await run("kv");
await run("d1");
process.exit(0);

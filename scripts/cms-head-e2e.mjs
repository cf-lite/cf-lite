// examples/cms-head e2e under local workerd (wrangler dev): route-by-URL from the mock CMS, block composition, locales, published vs draft
// (preview cookie), publish -> signed webhook -> tag purge -> ISR regeneration, webhook negative cases, a second "colo" sharing R2/KV.
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/cms-head/", import.meta.url).pathname;
const require = createRequire(app);
const persist = join(app, ".wrangler/e2e-state");
rmSync(persist, { recursive: true, force: true });
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const stop = () => { for (const c of procs) try { process.kill(-c.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
async function start(port) {
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", persist, "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  procs.push(child);
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  return { base: `http://localhost:${port}`, log: () => log };
}
const TOKEN = "demo-cms-token", WH_SECRET = "demo-webhook-secret-not-a-real-secret", DRAFT = "demo-draft-secret-0123456789abcdef-not-real";
const get = async (a, path, headers = {}) => { const r = await fetch(a.base + path, { headers, redirect: "manual" }); return { r, st: r.headers.get("x-cf-lite-isr"), body: await r.text() }; };
const gql = async (a, query, variables) => (await fetch(`${a.base}/api/cms/graphql`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ query, variables }) })).json();
const draft = (a, id, fields) => gql(a, "mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id version } }", { id, fields });
const publish = (a, id) => gql(a, "mutation($id: String!) { publish(id: $id) { id version } }", { id });
const has = (b, s) => b.includes(s);
const until = async (what, fn, ms = 30000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - t < ms, "timeout: " + what); await sleep(300); } };
const signed = (body, t = Math.floor(Date.now() / 1000), secret = WH_SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const hook = (a, body, headers) => fetch(`${a.base}/api/webhooks/cms`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

try {
  // 0. client bundle carries the registry/components, never the CMS client, the mock, or the loader
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const clientJs = walk(join(app, "dist/client")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(has(clientJs, "data-block") || has(clientJs, "Hero"), "client bundle has the block components");
  for (const s of ["CMS_TOKEN", "graphql", "saveDraft", "Bearer "]) assert.ok(!has(clientJs, s), `client bundle must not contain server code (${s})`);

  const base = 22000 + Math.floor(Math.random() * 400);
  const A = await start(base);

  // 1. route-by-URL from the CMS, per locale; unknown -> 404; `/` -> /en
  const root = await get(A, "/"); assert.equal(root.r.status, 302); assert.equal(root.r.headers.get("location"), "/en");
  let home = await get(A, "/en");
  assert.equal(home.r.status, 200);
  assert.ok(has(home.body, 'data-testid="hero"') && has(home.body, "Home"), "hero block rendered");
  assert.ok(has(home.body, "Welcome to the cf-lite CMS demo"), "BlockRef resolved to the shared Banner block");
  assert.ok(has(home.body, "left column") && has(home.body, 'href="/en/about"'), "Columns composed nested blocks");
  assert.ok(has(home.body, "First post") && has(home.body, "Second post"), "ArticleList got its data from the loader");
  assert.equal(home.st, "MISS");
  const vi = await get(A, "/vi"); assert.ok(has(vi.body, "Trang chủ") && has(vi.body, "Bài đầu tiên") && has(vi.body, 'lang="vi"'));
  const art = await get(A, "/en/blog/first"); assert.equal(art.r.status, 200); assert.ok(has(art.body, 'data-view="Article"') && has(art.body, "Hello (1)"));
  assert.equal((await get(A, "/en/nope")).r.status, 404);
  assert.equal((await get(A, "/fr")).r.status, 404);
  // 2. second request is served from R2
  await until("HIT", async () => (await get(A, "/en")).st === "HIT");
  const direct = await fetch(`${A.base}/api/cms/graphql`, { method: "POST", body: JSON.stringify({ query: "query($l: Locale!){ route(path:\"/\", locale:$l, preview:true){ __typename } }", variables: { l: "en" } }) });
  assert.match(JSON.stringify(await direct.json()), /unauthorized/, "draft reads need the CMS token");

  // 3. draft vs published: the working copy is only visible with the preview cookie, and a previewer never touches the shared cache
  const B = await start(base + 1);
  await get(A, "/en/about"); // warm
  assert.ok((await draft(A, "page-about-en", { title: "About v2" })).data.saveDraft.version === 2);
  assert.ok(has((await get(A, "/en/about")).body, ">About<") || !has((await get(A, "/en/about")).body, "About v2"), "published copy unchanged by a draft");
  assert.equal((await get(A, "/api/draft/enable?secret=nope")).r.status, 401);
  const en = await get(A, `/api/draft/enable?secret=${DRAFT}&path=/en/about`);
  assert.equal(en.r.status, 307); assert.equal(en.r.headers.get("location"), "/en/about");
  const cookie = en.r.headers.get("set-cookie").split(";")[0];
  const pv = await get(A, "/en/about", { cookie });
  assert.ok(has(pv.body, "About v2") && has(pv.body, 'data-testid="preview-badge"'), "preview shows the draft");
  assert.equal(pv.st, "BYPASS");
  assert.ok(!has((await get(B, "/en/about")).body, "About v2"), "other colo still serves the published copy");

  // 3b. editor: static page, token-gated entry list and "preview button" URL that leads into the preview flow
  const ed = await get(A, "/api/cms/editor"); assert.equal(ed.r.status, 200); assert.ok(has(ed.body, "cms:content-saved") && !has(ed.body, TOKEN) && !has(ed.body, DRAFT), "editor page holds no secret");
  assert.equal((await get(A, "/api/cms/admin/entries")).r.status, 401);
  assert.equal((await get(A, "/api/cms/admin/preview-url?id=page-about-en")).r.status, 401);
  const auth = { authorization: `Bearer ${TOKEN}` };
  const list = JSON.parse((await get(A, "/api/cms/admin/entries", auth)).body); assert.ok(list.find((e) => e.id === "page-about-en" && e.draft === 2));
  const pu = JSON.parse((await get(A, "/api/cms/admin/preview-url?id=page-about-en", auth)).body).url;
  const en2 = await get(A, pu); assert.equal(en2.r.status, 307); assert.equal(en2.r.headers.get("location"), "/en/about");
  assert.equal((await get(A, "/api/cms/admin/preview-url?id=block-banner", auth)).r.status, 404, "blocks have no route to preview");
  const lj = await get(A, "/cms-saved-listener.js"); assert.equal(lj.r.status, 200); assert.match(lj.r.headers.get("content-type"), /javascript/); assert.ok(has(lj.body, "cms:content-saved"));
  assert.ok(has(pv.body, 'src="/cms-saved-listener.js"'), "preview pages carry the content-saved listener");
  assert.ok(!has((await get(B, "/en/about")).body, "listener.js"), "published pages stay zero-JS");
  // 4. publish -> signed webhook (in-process) -> revalidate tags -> regenerated HTML visible on BOTH colos
  const pub = await publish(A, "page-about-en"); assert.equal(pub.data.publish.version, 2);
  const log = await (await fetch(`${A.base}/api/cms/admin/deliveries`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(log.at(-1).status, 200, "webhook delivered and accepted: " + JSON.stringify(log));
  await until("regenerated About v2 on A", async () => has((await get(A, "/en/about")).body, "About v2"));
  await until("regenerated About v2 on B", async () => has((await get(B, "/en/about")).body, "About v2"));
  assert.ok(!has((await get(A, "/vi/about")).body, "About v2"), "other locale untouched");

  // 5. article publish purges lists on every page of that locale; a shared block purges everything
  await draft(A, "article-1-en", { title: "First post EDITED" }); await publish(A, "article-1-en");
  await until("article list on home regenerated", async () => has((await get(B, "/en")).body, "First post EDITED"));
  await draft(A, "block-banner", { block: { __typename: "Banner", text: "Maintenance tonight" } }); await publish(A, "block-banner");
  await until("banner everywhere (en home)", async () => has((await get(B, "/en")).body, "Maintenance tonight"));

  // 6. webhook receiver: bad signature, wrong secret, stale timestamp, replay (dedupe), garbage
  const ev = JSON.stringify({ id: "dl-test-1", events: [{ action: "publish", type: "page", id: "page-about-en", locale: "en", paths: ["/en/about"] }] });
  assert.equal((await hook(A, ev, { "x-cms-signature": "t=1,v1=" + "0".repeat(64) })).status, 401);
  assert.equal((await hook(A, ev, { "x-cms-signature": signed(ev, undefined, "x".repeat(32)) })).status, 401);
  assert.equal((await hook(A, ev, { "x-cms-signature": signed(ev, Math.floor(Date.now() / 1000) - 3600) })).status, 401);
  assert.equal((await hook(A, ev, {})).status, 401);
  const ok1 = await hook(A, ev, { "x-cms-signature": signed(ev), "x-cms-delivery": "dl-test-1" });
  assert.equal(ok1.status, 200); assert.equal((await ok1.json()).events, 1);
  assert.equal((await (await hook(A, ev, { "x-cms-signature": signed(ev), "x-cms-delivery": "dl-test-1" })).json()).duplicate, true);
  const bad = JSON.stringify({ events: [{ action: "explode", type: "page", id: "x" }] }); assert.equal((await hook(A, bad, { "x-cms-signature": signed(bad) })).status, 400);
  const junk = "not json"; assert.equal((await hook(A, junk, { "x-cms-signature": signed(junk) })).status, 400);
  console.log("cms-head e2e OK");
} finally { stop(); }

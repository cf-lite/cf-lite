// WP-ACTIONS e2e under local workerd (examples/site-forms): POST ?/name dispatch, 303 / re-render flows, validation hook, JSON (JS) mode,
// R2 upload hand-off and the CSRF negative corpus (missing/foreign Origin, cross-site Sec-Fetch-Site, content-type confusion, method override).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-forms/", import.meta.url).pathname;
const require = createRequire(app);
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
const wj = JSON.parse(readFileSync(join(app, "dist/cf_lite_site_forms/wrangler.json"), "utf8"));
for (const g of ["/contact", "/enhanced"]) assert.ok(wj.assets.run_worker_first.includes(g), `run_worker_first has ${g}`);

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 20900 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const same = { origin: B, "sec-fetch-site": "same-origin" };
  const post = (p, body, headers = same) => fetch(B + p, { method: "POST", redirect: "manual", body, headers });
  const refused = async (p, body, headers, want, name) => { const r = await post(p, body, headers); assert.equal(r.status, want, name); };
  const form = (o) => new URLSearchParams(o);
  const good = { name: "Ada", email: "ada@example.com", message: "hello there" };

  // -------- GET still works; the page shows the loader count
  let r = await fetch(B + "/contact"); assert.equal(r.status, 200); assert.match(await r.text(), /messages: (<!-- -->)?0/);

  // -------- validation: 422 + field errors + values echoed back (no secrets), page re-rendered (works without JS)
  r = await post("/contact?/send", form({ name: "", email: "nope", message: "hi" }));
  let t = await r.text(); assert.equal(r.status, 422);
  assert.match(t, /data-testid="err-name"[^>]*>Name is required/); assert.match(t, /Enter a valid email/); assert.match(t, /at least 5 characters/);
  assert.match(t, /value="nope"/, "typed values survive the re-render");
  // -------- success -> re-render 200 with actionData
  r = await post("/contact?/send", form(good)); t = await r.text(); assert.equal(r.status, 200); assert.match(t, /Thanks (<!-- -->)?Ada/);
  r = await fetch(B + "/contact"); assert.match(await r.text(), /messages: (<!-- -->)?1/, "action state is visible to the next GET");
  // -------- undefined result -> 303 back to the page (PRG), other query params survive, ?/name removed
  r = await post("/contact?x=1&/clear", form({})); assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/contact?x=1");
  // -------- redirect sentinel (307 default is upgraded to 303), formaction style
  r = await post("/contact?/go", form({})); assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/thanks");
  // -------- unknown action / prototype names / route without actions
  r = await post("/contact?/nope", form({})); assert.equal(r.status, 404);
  r = await post("/contact?/constructor", form({})); assert.equal(r.status, 404, "prototype keys are not actions");
  r = await post("/contact?/__proto__", form({})); assert.equal(r.status, 404);
  r = await post("/thanks?/x", form({})); assert.equal(r.status, 404, "a page without actions does not accept POST");
  // -------- custom failure status / error boundary (no leak)
  r = await post("/contact?/teapot", form({})); assert.equal(r.status, 418); assert.match(await r.text(), /I am a teapot/);
  r = await post("/contact?/boom", form({})); t = await r.text(); assert.equal(r.status, 500); assert.ok(!t.includes("secret stack detail"), "no error detail leaks");

  // -------- JS mode: JSON, always HTTP 200, same outcomes
  const js = { ...same, "x-cf-lite-action": "1" };
  r = await post("/contact?/send", form({ name: "", email: "x", message: "y" }), js);
  let j = await r.json(); assert.equal(r.status, 200); assert.equal(j.type, "failure"); assert.equal(j.status, 422); assert.ok(j.data.errors.name);
  r = await post("/contact?/send", form(good), js); j = await r.json(); assert.deepEqual([j.type, j.status, j.data.ok], ["success", 200, true]);
  r = await post("/contact?/go", form({}), js); j = await r.json(); assert.deepEqual([r.status, j.type, j.location], [200, "redirect", "/thanks"]);
  r = await post("/contact?/clear", form({}), js); j = await r.json(); assert.deepEqual([j.type, j.location], ["redirect", "/contact"]);
  r = await post("/contact?/boom", form({}), js); j = await r.json(); assert.equal(j.type, "error"); assert.ok(!JSON.stringify(j).includes("secret"));

  // -------- uploads to R2 (multipart), limits, sniffing of type allowlist
  const up = (file, headers) => { const fd = new FormData(); fd.set("file", file); return post("/contact?/upload", fd, headers); };
  r = await up(new File(["hello r2"], "a.txt", { type: "text/plain" })); t = await r.text(); assert.equal(r.status, 200); assert.match(t, /uploaded (<!-- -->)?8/);
  r = await up(new File([new Uint8Array(100_000)], "big.txt", { type: "text/plain" })); assert.equal(r.status, 413);
  r = await up(new File(["<b>x</b>"], "a.html", { type: "text/html" })); assert.equal(r.status, 415);
  r = await up(new File([], "e.txt", { type: "text/plain" })); assert.equal(r.status, 400);
  r = await up(new File(["hello r2"], "a.txt", { type: "text/plain" }), { origin: "https://evil.example" }); assert.equal(r.status, 403, "multipart cross-origin is blocked before parsing");

  // -------- CSRF negative corpus
  const body = form(good), n0 = async () => Number(/messages: (?:<!-- -->)?(\d+)/.exec(await (await fetch(B + "/contact")).text())[1]);
  const before = await n0();
  const bad = [
    ["no Origin, no Sec-Fetch-Site", {}],
    ["foreign Origin", { origin: "https://evil.example" }],
    ["Origin: null", { origin: "null" }],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }],
    ["same-site (sibling subdomain)", { "sec-fetch-site": "same-site", origin: "https://sub.example" }],
    ["cross-site metadata with spoofed same Origin", { "sec-fetch-site": "cross-site", origin: B }],
    ["origin with our host as a prefix", { origin: B + ".evil.example" }],
  ];
  for (const [name, h] of bad) await refused("/contact?/send", body, h, 403, name);
  assert.equal(await n0(), before, "no blocked request ran the action");
  // content-type confusion: same-origin but not a form content type
  for (const ct of ["text/plain", "application/json", "application/xml", ""]) {
    await refused("/contact?/send", JSON.stringify(good), { ...same, ...(ct ? { "content-type": ct } : {}) }, 415, "content-type " + ct);
  }
  // method override attempts are not honoured: a GET-override header / _method field still runs only the named action as POST
  r = await post("/contact?/send", form({ ...good, _method: "DELETE" }), { ...same, "x-http-method-override": "GET" }); assert.equal(r.status, 200);
  r = await fetch(B + "/contact?/send", { method: "PUT", headers: same, body }); assert.notEqual(r.status, 200, "only POST reaches actions");
  r = await fetch(B + "/contact?/send", { method: "DELETE", headers: same }); assert.notEqual(r.status, 200);
  assert.equal(await n0(), before + 1, "exactly the one legitimate submit ran");
  // GET with ?/send never runs an action
  r = await fetch(B + "/contact?/send"); assert.equal(r.status, 200); assert.equal(await n0(), before + 1);
  // fetch-metadata same-origin without Origin (some clients omit it on same-origin) is fine
  r = await post("/contact?/clear", form({}), { "sec-fetch-site": "same-origin" }); assert.equal(r.status, 303);
  // oversize declared body
  r = await post("/contact?/send", new Uint8Array(5 * 1024 * 1024), { ...same, "content-type": "application/x-www-form-urlencoded" }); assert.equal(r.status, 413);
  // -------- action on a cached page purges its tag: HIT -> POST -> fresh render
  const cstat = async () => { const x = await fetch(B + "/board"); return [x.headers.get("x-cf-lite-cache"), await x.text()]; };
  await cstat(); // MISS, stores
  let [st, bt] = await cstat(); assert.equal(st, "HIT", "second GET is served from cache"); assert.ok(!bt.includes("first note"));
  r = await post("/board?/add", form({ note: "first note" })); assert.equal(r.status, 303); assert.equal(r.headers.get("location"), "/board");
  [st, bt] = await cstat(); assert.notEqual(st, "HIT", "the action purged the tag"); assert.match(bt, /first note/);
  r = await post("/board?/add", form({ note: "x" }), { origin: "https://evil.example" }); assert.equal(r.status, 403);
  console.log("actions e2e OK");
} catch (e) { console.error("--- wrangler log ---\n" + log.slice(-4000)); throw e; } finally { stop(); }

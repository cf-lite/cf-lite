// WP-JOBS e2e under local workerd (wrangler dev): queue enqueue -> consumer -> retry -> DLQ, cron dispatch by expression,
// workflow steps, after(), email routing - all through the generated .cf-lite/handlers.ts of examples/site-jobs.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const app = new URL("../examples/site-jobs/", import.meta.url).pathname;
const require = createRequire(app);
rmSync(join(app, ".wrangler/state"), { recursive: true, force: true }); // fresh local KV/queues
const build = spawnSync(process.execPath, [join(app, "../../packages/cf-lite/dist/cli.js"), "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);
assert.doesNotMatch(build.stdout + build.stderr, /\[cf-lite\] .*(wrangler|lacks|no entry)/, "the example's own doctor checks must be clean:\n" + build.stdout + build.stderr);

const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 20400 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--test-scheduled", "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const B = `http://localhost:${port}`;
  const post = (p, body) => fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const state = async () => (await fetch(B + "/api/jobs/state")).json();
  const until = async (what, pred, ms = 40000) => {
    const t = Date.now();
    for (;;) {
      const s = await state();
      if (pred(s)) return s;
      assert.ok(Date.now() - t < ms, `timeout waiting for ${what}; state=${JSON.stringify(s)}\n${log.slice(-2000)}`);
      await sleep(400);
    }
  };

  // 1. enqueue -> consumer runs
  let r = await post("/api/jobs/enqueue", { id: "ok1" }); assert.equal(r.status, 200);
  let s = await until("consumer ran", (x) => x["done:ok1"] === "1");
  assert.equal(s["attempt:ok1"], "1");

  // 2. failing message: retried once (attempt 2), then dead-lettered into jobs-dlq, whose consumer records it
  await post("/api/jobs/enqueue", { id: "bad1", fail: true });
  s = await until("retry + DLQ", (x) => x["dlq:bad1"] === "1");
  assert.equal(s["attempt:bad1"], "2", "retry happened (attempt 2) before dead-lettering");
  assert.equal(s["done:bad1"], undefined);

  // 3. cron dispatch by expression: a declared expression runs the file; an unknown one runs nothing and does not fail
  r = await fetch(`${B}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("*/5 * * * *")}&time=1234`);
  assert.equal(r.status, 200, await r.text());
  s = await until("cron tick", (x) => x["cron:tick"] !== undefined, 10000);
  assert.ok(Number(s["cron:tick"]) > 0);
  r = await fetch(`${B}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("1 1 1 1 *")}`);
  assert.equal(r.status, 200);
  for (let i = 0; i < 20 && !/matched no server\/cron file/.test(log); i++) await sleep(250);
  assert.match(log, /matched no server\/cron file/);

  // 4. workflow steps (create profile -> sleep -> welcome)
  r = await post("/api/jobs/workflow", { userId: "u7" }); assert.equal(r.status, 200); assert.equal((await r.json()).id, "wf-u7");
  await until("workflow finished", (x) => x["wf:u7"] === "free");

  // 5. after(): response returns before the work is done, work completes afterwards
  r = await post("/api/jobs/after", {}); assert.deepEqual(await r.json(), { accepted: true });
  assert.equal((await state())["after:done"], undefined, "after() must not block the response");
  await until("after() task", (x) => x["after:done"] === "1", 10000);

  // 6. email routing: specific match handled, unmatched rejected
  const mail = (to) => fetch(`${B}/cdn-cgi/handler/email?from=${encodeURIComponent("a@b.com")}&to=${encodeURIComponent(to)}`, { method: "POST", body: `From: a@b.com\r\nTo: ${to}\r\nSubject: hi\r\nMessage-ID: <1@b.com>\r\n\r\nhello\r\n` });
  r = await mail("support@example.com"); assert.equal(r.status, 200, await r.text());
  await until("email handled", (x) => x["email:support@example.com"] === "a@b.com", 10000);
  r = await mail("nobody@example.com"); assert.notEqual(r.status, 200, "unmatched recipient is rejected");
  console.log("jobs e2e OK");
} finally {
  stop();
}
process.exit(0);

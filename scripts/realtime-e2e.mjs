// WP-REALTIME e2e under local workerd: scaffold templates/realtime (+ `cf-lite add do probe`), build, wrangler dev, then
// two-client broadcast + presence, auth refusal, room isolation, resume with replay, bad frames, and a REAL hibernation eviction
// (idle > 10s -> the DO instance is destroyed and rebuilt; the same sockets keep working).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cf-lite/dist/cli.js");
const dir = join(root, "examples/.scaffold-realtime");
rmSync(dir, { recursive: true, force: true });
cpSync(join(root, "packages/cf-lite/templates/realtime"), dir, { recursive: true });
renameSync(join(dir, "_gitignore"), join(dir, ".gitignore"));
const sh = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });

// `add do probe` = file + wrangler binding + SQLite migration (v2). Then give the probe a test-only shape.
let r = sh(["add", "do", "probe"]);
assert.equal(r.status, 0, r.stdout + r.stderr);
const wj = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
assert.match(wj, /"name": "PROBE", "class_name": "Probe"/);
assert.match(wj, /"tag": "v2", "new_sqlite_classes": \["Probe"\]/);
writeFileSync(join(dir, "server/do/probe.ts"), `import { HibernatingRoom } from "cf-lite/modules/realtime";
export default class Probe extends HibernatingRoom<Env> {
  static options = { heartbeatMs: 0 }; // no alarm -> the DO may hibernate after ~10s idle
  static migrations = ["CREATE TABLE seen (n INTEGER)"];
  instance = crypto.randomUUID();
  messages = { whoami: (c) => c.send("whoami", { instance: this.instance, rows: this.sql\`SELECT count(*) AS n FROM seen\`[0].n }), touch: (c) => { this.sql\`INSERT INTO seen VALUES (1)\`; c.send("touched"); } };
}
`);
writeFileSync(join(dir, "server/api/probe.ts"), `import { Hono } from "hono";
import { durableObjects } from "../../.cf-lite/do";
export default new Hono<{ Bindings: Env }>().get("/:room", (c) => durableObjects.probe.fetch(c.req.param("room"), c.req.raw));
`);
writeFileSync(join(dir, "server/env.d.ts"), "interface Env { ASSETS: Fetcher; CHAT: DurableObjectNamespace; PROBE: DurableObjectNamespace }\n");

r = sh(["build"]);
assert.equal(r.status, 0, r.stdout + r.stderr);
assert.doesNotMatch(r.stdout + r.stderr, /\[cf-lite\] .*(wrangler|lacks|no entry|migration)/, "doctor checks must be clean:\n" + r.stdout + r.stderr);

const require = createRequire(root);
const pj = require.resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const port = 20900 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--show-interactive-dev-session=false"], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Raw client: collects parsed frames, `next(pred)` waits for one. */
const client = (path, headers) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${port}${path}`);
  const frames = [], waiters = [];
  ws.onmessage = (e) => {
    const f = e.data === "pong" ? { type: "$pong" } : JSON.parse(e.data);
    frames.push(f);
    for (const w of [...waiters]) if (w.pred(f)) { waiters.splice(waiters.indexOf(w), 1); w.res(f); }
  };
  const c = {
    ws, frames,
    send: (type, data) => ws.send(JSON.stringify({ type, data })),
    next: (pred, ms = 8000) => { const hit = frames.find((f, i) => !f.__seen && pred(f)); if (hit) { hit.__seen = true; return Promise.resolve(hit); }
      return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout; frames=" + JSON.stringify(frames) + "\n" + log.slice(-1500))), ms); waiters.push({ pred, res: (f) => { clearTimeout(t); f.__seen = true; res(f); } }); }); },
  };
  ws.onopen = () => resolve(c);
  ws.onerror = () => setTimeout(() => reject(new Error("ws error " + path + "\n" + log.slice(-2500))), 700);
});
const is = (type) => (f) => f.type === type;

try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  const http = `http://localhost:${port}`;

  // 0. plain GET is refused, missing name refused (authorize)
  assert.equal((await fetch(`${http}/api/rooms/lobby`)).status, 426);
  await assert.rejects(client("/api/rooms/lobby"), /ws error/, "authorize() refused the upgrade (no name)");

  // 1. two clients: hello (presence), join announce, broadcast reaches both incl. sender, rooms are isolated
  const a = await client("/api/rooms/lobby?name=ada");
  const ha = await a.next(is("$hello"));
  assert.equal(ha.data.presence.length, 1);
  assert.equal(ha.data.resumed, false);
  const b = await client("/api/rooms/lobby?name=bob");
  const hb = await b.next(is("$hello"));
  assert.deepEqual(hb.data.presence.map((p) => p.meta.name).sort(), ["ada", "bob"]);
  const j = await a.next((f) => f.type === "$presence" && f.data.op === "join");
  assert.equal(j.data.meta.name, "bob");
  const other = await client("/api/rooms/other?name=eve"); await other.next(is("$hello"));
  a.send("chat", { text: "hello" });
  const ma = await a.next(is("chat")), mb = await b.next(is("chat"));
  assert.deepEqual([ma.data, mb.data], [{ name: "ada", text: "hello" }, { name: "ada", text: "hello" }]);
  assert.equal(mb.seq, 1);
  await sleep(300);
  assert.ok(!other.frames.some(is("chat")), "rooms are isolated");
  // bad frames: non-JSON is tolerated (no crash), keeps working
  a.ws.send("not json"); b.send("chat", { text: "still works" });
  assert.equal((await a.next(is("chat"))).data.text, "still works");

  // 2. resume: bob drops, ada talks, bob comes back with token+since and gets the missed message; ada sees no duplicate join
  const token = hb.data.token, since = (await b.next(is("chat"))).seq; // bob's last seen seq (2)
  b.ws.close();
  await a.next((f) => f.type === "$presence" && f.data.op === "leave");
  a.send("chat", { text: "while you were away" });
  await a.next((f) => f.type === "chat" && f.data.text === "while you were away");
  const b2 = await client(`/api/rooms/lobby?name=bob&resume=${encodeURIComponent(token)}&since=${since}`);
  const h2 = await b2.next(is("$hello"));
  assert.equal(h2.data.resumed, true); assert.equal(h2.data.id, hb.data.id); assert.equal(h2.data.gap, false);
  assert.equal((await b2.next(is("chat"))).data.text, "while you were away");
  // forged token is not honoured (fresh identity)
  const b3 = await client(`/api/rooms/lobby?name=mallory&resume=${encodeURIComponent(hb.data.id + ".deadbeef")}`);
  const h3 = await b3.next(is("$hello")); assert.equal(h3.data.resumed, false); assert.notEqual(h3.data.id, hb.data.id);
  for (const c of [a, b2, b3, other]) c.ws.close();

  // 3. the framework-free client against the real server: connect, presence, send, receive, close
  const { connectChannel } = await import(join(root, "packages/cf-lite/dist/client-realtime.js"));
  const ch = connectChannel(`${http}/api/rooms/clientroom`, { params: { name: "cc" }, pingMs: 0 });
  const got = await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("client timeout")), 8000); ch.on("chat", (d) => { clearTimeout(t); res(d); }); ch.on("$hello", () => ch.send("chat", { text: "via client" })); });
  assert.deepEqual(got, { name: "cc", text: "via client" });
  assert.equal(ch.status, "open"); assert.ok(ch.lastSeq >= 1); ch.close(); assert.equal(ch.status, "closed");

  // 4. REAL hibernation: idle past workerd's ~10s threshold -> instance rebuilt, sockets + SQLite state intact
  const p = await client("/api/probe/zz"); await p.next(is("$hello"));
  p.send("touch"); await p.next(is("touched"));
  p.send("whoami"); const before = await p.next(is("whoami"));
  assert.equal(before.data.rows, 1);
  let after;
  for (let i = 0; i < 4 && !after; i++) { // allow up to ~60s for the eviction to happen
    await sleep(15000);
    p.send("whoami"); const w = await p.next(is("whoami"), 10000);
    if (w.data.instance !== before.data.instance) after = w;
  }
  assert.ok(after, "the Durable Object never hibernated (instance id unchanged)");
  assert.equal(after.data.rows, 1, "SQLite state survived");
  p.ws.close();
  console.log("realtime e2e OK");
} finally {
  stop();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);

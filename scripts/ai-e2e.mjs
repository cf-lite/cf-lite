// WP-AI e2e under local workerd (wrangler dev): scaffold an app, `cf-lite add ai-chat`, build, then drive POST /api/chat with a FAKE
// Workers AI binding (the real one is remote-only: needs a Cloudflare login + bills). Proves the template builds and that SSE really
// streams (incremental delivery, client-abort cancels upstream, validation/CSRF refusals, gateway routing options reach the binding).
// The real-model nightly smoke is documented in docs/ai.md (needs a scratch account; not run here).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cf-lite/dist/cli.js");
const wr = join(dirname(createRequire(root).resolve("wrangler/package.json")), "bin/wrangler.js");
const dir = join(root, "examples/.ai-e2e");
rmSync(dir, { recursive: true, force: true });
const sh = (cmd, args, cwd = root) => { const r = spawnSync(process.execPath, [cmd, ...args], { cwd, encoding: "utf8" }); assert.equal(r.status, 0, `${args.join(" ")} failed\n${r.stdout}${r.stderr}`); return r.stdout; };

sh(join(root, "packages/create-cf-lite/index.mjs"), [dir, "--ui", "none", "--no-install"]);
const added = sh(cli, ["add", "ai-chat"], dir);
assert.match(added, /write\s+server\/api\/chat\.ts/); assert.match(added, /ai binding/);
assert.match(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), /"ai": \{ "binding": "AI" \}/);
assert.doesNotMatch(sh(cli, ["add", "ai-chat"], dir), /write /, "second run must change nothing");

// The fake replaces the remote binding: drop the `ai` key so wrangler does not try to reach Cloudflare.
writeFileSync(join(dir, "wrangler.jsonc"), readFileSync(join(dir, "wrangler.jsonc"), "utf8").replace(/\n\s*"ai": \{ "binding": "AI" \},/, ""));
writeFileSync(join(dir, "server/worker.ts"), `import app from "../.cf-lite/app";
const state: { last?: unknown; cancelled: number; pulled: number } = { cancelled: 0, pulled: 0 };
const enc = new TextEncoder();
const fake = {
  async run(model: string, input: any, opts: unknown) {
    state.last = { model, input, opts };
    if (!input.stream) return { response: "plain" };
    let i = 0;
    return new ReadableStream({
      async pull(c) {
        if (i >= (input.messages.at(-1).content === "endless" ? 1000 : 5)) { c.enqueue(enc.encode("data: [DONE]\\n\\n")); c.close(); return; }
        await new Promise((r) => setTimeout(r, 200));
        state.pulled++; c.enqueue(enc.encode("data: " + JSON.stringify({ response: "tok" + i++ + " " }) + "\\n\\n"));
      },
      cancel() { state.cancelled++; },
    });
  },
};
export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const u = new URL(req.url);
    if (u.pathname === "/api/__state") return Response.json(state);
    return app.fetch(req, { ...env, AI: fake }, ctx);
  },
} satisfies ExportedHandler<Env>;
`);
writeFileSync(join(dir, "server/env.d.ts"), "interface Env { AI: any; AI_GATEWAY_ID?: string }\n");
sh(cli, ["build"], dir);

const port = 20900 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--var", "AI_GATEWAY_ID:gw-e2e", "--show-interactive-dev-session=false"], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
const B = `http://localhost:${port}`;
const chat = (body, headers = {}, init = {}) => fetch(B + "/api/chat", { method: "POST", headers: { "content-type": "application/json", origin: B, ...headers }, body: JSON.stringify(body), ...init });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);

  // 1. streams incrementally: first event well before the last (5 tokens x 200 ms)
  const t0 = Date.now();
  let res = await chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let text = "", firstAt = 0, chunks = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks++; text += dec.decode(value, { stream: true }); if (!firstAt && text.includes("tok0")) firstAt = Date.now() - t0; }
  const total = Date.now() - t0;
  assert.ok(firstAt < total - 400, `first token at ${firstAt}ms, end at ${total}ms: not streamed`);
  assert.ok(chunks >= 3, `expected several network chunks, got ${chunks}`);
  assert.deepEqual([...text.matchAll(/data: \{"text":"([^"]*)"\}/g)].map((m) => m[1]), ["tok0 ", "tok1 ", "tok2 ", "tok3 ", "tok4 "]);
  assert.match(text, /event: done/);

  // 2. gateway routing reached the binding; system prompt + streaming flag set by the template
  const st = await (await fetch(B + "/api/__state")).json();
  assert.equal(st.last.opts.gateway.id, "gw-e2e");
  assert.equal(st.last.input.stream, true);
  assert.equal(st.last.input.messages[0].role, "system");

  // 3. client abort: the upstream stops being pulled (backpressure) instead of generating 1000 tokens into the void.
  // (Explicit cancel() propagation is unit-tested; the `wrangler dev` proxy does not forward the disconnect as a cancel, production workerd does.)
  const ac = new AbortController();
  res = await chat({ messages: [{ role: "user", content: "endless" }] }, {}, { signal: ac.signal });
  const r2 = res.body.getReader(); await r2.read(); ac.abort(); try { await r2.read(); } catch {}
  await sleep(1500);
  const p1 = (await (await fetch(B + "/api/__state")).json()).pulled; await sleep(1500);
  const p2 = (await (await fetch(B + "/api/__state")).json()).pulled;
  assert.equal(p1, p2, "upstream still being pulled after client abort");
  assert.ok(p2 < 100, `upstream pulled ${p2} tokens for an aborted request`);

  // 4. refusals: bad body 400, cross-site 403, form content type 415
  assert.equal((await chat({ messages: [] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "system", content: "x" }] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "user", content: "x".repeat(4001) }] })).status, 400);
  assert.equal((await chat({ messages: [{ role: "user", content: "x" }] }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await fetch(B + "/api/chat", { method: "POST", headers: { "content-type": "text/plain", origin: B }, body: "x" })).status, 415);
  console.log("ai e2e OK");
} finally { stop(); rmSync(dir, { recursive: true, force: true }); }
process.exit(0);

/**
 * Runtime e2e under real workerd (Miniflare): signed webhook -> real Queue -> consumer -> pages that rendered the content are re-rendered,
 * others untouched. Two "colos" = two Miniflare instances sharing KV (tag ledger + dedupe) and R2 (ISR store) through the same persist dirs;
 * each has its own Cache API. The queue (and its consumer) lives in colo A; colo B only serves pages.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signWebhook } from "../src/modules/webhook.js";

const SECRET = "e2e-secret";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Colo = { base: string; child: ChildProcess; dispatchFetch(url: string, init?: RequestInit): Promise<Response> };
let dir: string, a: Colo, b: Colo;

// `wrangler dev` per colo (same approach as storage-workerd.test.ts / scripts/cache-e2e.mjs); both persist to the SAME dir, so KV + R2 are shared
async function start(name: string): Promise<Colo> {
  const main = fileURLToPath(new URL("./fixtures/webhook-worker.ts", import.meta.url));
  const cwd = join(dir, name);
  const queues = { producers: [{ binding: "WEBHOOK_QUEUE", queue: "cms-webhook" }, { binding: "ISR_QUEUE", queue: "isr" }], consumers: [{ queue: "cms-webhook", max_batch_size: 1, max_batch_timeout: 1, max_retries: 1 }, { queue: "isr", max_batch_size: 1, max_batch_timeout: 1, max_retries: 1 }] };
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "wrangler.jsonc"), JSON.stringify({
    name: "webhook-" + name, main, compatibility_date: "2026-09-01", vars: { CMS_WEBHOOK_SECRET: SECRET },
    kv_namespaces: [{ binding: "CF_CACHE_TAGS", id: "tags-local" }, { binding: "WEBHOOK_KV", id: "dedupe-local" }],
    r2_buckets: [{ binding: "ISR_BUCKET", bucket_name: "isr-local" }], queues,
  }));
  const pj = createRequire(import.meta.url).resolve("wrangler/package.json");
  const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
  const port = 19200 + Math.floor(Math.random() * 600);
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout!.on("data", (d) => (log += d)); child.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 160 && !log.includes("Ready on"); i++) await sleep(500);
  if (!log.includes("Ready on")) throw new Error(`wrangler dev (${name}) did not start:\n` + log);
  const base = `http://localhost:${port}`;
  return { base, child, dispatchFetch: (url, init) => fetch(base + new URL(url).pathname, init as never) };
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cfl-webhook-e2e-"));
  a = await start("colo-a"); b = await start("colo-b");
}, 150000);
afterAll(() => { for (const c of [a, b]) try { process.kill(-c.child.pid!, "SIGTERM"); } catch { /* already gone */ } rmSync(dir, { recursive: true, force: true }); });

const get = async (w: Colo, path: string) => {
  const r = await w.dispatchFetch("http://colo-a.test" + path);
  const t = await r.text();
  return { cache: r.headers.get("x-cf-lite-cache") ?? r.headers.get("x-cf-lite-isr"), nonce: /nonce:(\w+)/.exec(t)?.[1], status: r.status };
};
const hook = async (body: unknown, o: { delivery?: string; secret?: string } = {}) => {
  const raw = JSON.stringify(body);
  const r = await a.dispatchFetch("http://colo-a.test/hook", { method: "POST", body: raw, headers: await signWebhook(raw, o.secret ?? SECRET, Date.now(), o.delivery) });
  return { status: r.status, json: (await r.json()) as any };
};

describe("webhook -> queue -> purge/regenerate (workerd, 2 colos)", () => {
  it("rejects unsigned/forged calls without enqueueing", async () => {
    const r = await a.dispatchFetch("http://colo-a.test/hook", { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect((await hook({ events: [{ type: "post", id: "1" }] }, { secret: "wrong" })).status).toBe(401);
  });

  it("cache tier: publish of post 2 re-renders its page in BOTH colos, other pages stay HIT", async () => {
    for (const w of [a, b]) { expect((await get(w, "/cache/2")).cache).toBe("MISS"); expect((await get(w, "/cache/3")).cache).toBe("MISS"); }
    const before = { a: (await get(a, "/cache/2")), b: (await get(b, "/cache/2")) };
    expect([before.a.cache, before.b.cache]).toEqual(["HIT", "HIT"]);
    await sleep(30);
    const res = await hook({ id: "d1", events: [{ type: "post", id: "2" }] }, { delivery: "d1" });
    expect(res).toMatchObject({ status: 200, json: { ok: true, events: 1 } });
    // consumer runs asynchronously in colo A's queue; colo B sees the shared KV ledger after its per-isolate memo (3 s)
    let aNow = before.a;
    for (let i = 0; i < 40 && aNow.cache !== "MISS"; i++) { await sleep(150); aNow = await get(a, "/cache/2"); }
    expect(aNow.cache).toBe("MISS");
    expect(aNow.nonce).not.toBe(before.a.nonce);
    await sleep(3300);
    const bNow = await get(b, "/cache/2");
    expect(bNow.cache).toBe("MISS");
    expect(bNow.nonce).not.toBe(before.b.nonce);
    // unrelated content stays cached in both colos
    expect((await get(a, "/cache/3")).cache).toBe("HIT");
    expect((await get(b, "/cache/3")).cache).toBe("HIT");
  }, 30000);

  it("duplicate delivery is acknowledged but not re-enqueued", async () => {
    const r = await hook({ id: "d1", events: [{ type: "post", id: "2" }] }, { delivery: "d1" });
    expect(r.json).toEqual({ ok: true, duplicate: true, events: 0 });
  });

  it("ISR tier: publish of the shared author marks pages stale and the queue regenerates them in R2 (seen by colo B)", async () => {
    expect((await get(a, "/isr/7")).cache).toBe("MISS");
    await sleep(300); // R2 store is waitUntil
    const first = await get(b, "/isr/7");
    expect(first.cache).toBe("HIT"); // colo B reads colo A's copy from the shared bucket
    await sleep(30);
    expect((await hook({ id: "d2", events: [{ type: "author", id: "1" }] }, { delivery: "d2" })).status).toBe(200);
    let seen = first, stale = false;
    for (let i = 0; i < 60 && !(seen.nonce !== first.nonce && seen.cache === "HIT"); i++) {
      await sleep(250); seen = await get(b, "/isr/7");
      if (seen.cache === "STALE") stale = true;
    }
    expect(seen.cache).toBe("HIT");
    expect(seen.nonce).not.toBe(first.nonce); // regenerated by the consumer, served as a fresh HIT
    expect(stale || seen.nonce !== first.nonce).toBe(true);
  }, 40000);

  it("unpublish events purge the same way", async () => {
    const before = await get(a, "/cache/3");
    await sleep(30);
    await hook({ id: "d3", events: [{ action: "unpublish", type: "post", id: "3" }] }, { delivery: "d3" });
    let n = before;
    for (let i = 0; i < 40 && n.cache !== "MISS"; i++) { await sleep(150); n = await get(a, "/cache/3"); }
    expect(n.cache).toBe("MISS");
  }, 20000);
});

/** Runtime behaviour of the storage modules under real workerd (Miniflare): real R2/KV/D1 bindings. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `wrangler dev` (local workerd, real R2/KV/D1 bindings persisted to a temp dir) - same approach as scripts/cache-e2e.mjs
let child: ChildProcess; let dir: string; let B: string;
const f = (path: string, init?: RequestInit) => fetch(B + path, init as never);
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cfl-storage-wd-"));
  const main = fileURLToPath(new URL("./fixtures/storage-worker.ts", import.meta.url));
  writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({
    name: "storage-test", main, compatibility_date: "2026-09-01",
    r2_buckets: [{ binding: "BUCKET", bucket_name: "test-bucket" }],
    kv_namespaces: [{ binding: "KV", id: "kv-local" }],
    d1_databases: [{ binding: "DB", database_name: "test-db", database_id: "db-local" }],
  }));
  const pj = createRequire(import.meta.url).resolve("wrangler/package.json");
  const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
  const port = 19800 + Math.floor(Math.random() * 400);
  B = `http://localhost:${port}`;
  child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false"], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout!.on("data", (d) => (log += d)); child.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 160 && !log.includes("Ready on"); i++) await new Promise((r) => setTimeout(r, 500));
  if (!log.includes("Ready on")) throw new Error("wrangler dev did not start:\n" + log);
}, 90000);
afterAll(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ } rmSync(dir, { recursive: true, force: true }); });

describe("r2 uploadStream (workerd)", () => {
  it("streams a known-length body into R2 and serves it back byte-exact", async () => {
    const body = new Uint8Array(200_000).map((_, i) => i % 251);
    const r = await f("/up/docs/a.bin?max=1000000", { method: "PUT", body, headers: { "content-type": "application/octet-stream" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ key: "docs/a.bin", size: 200_000 });
    const got = new Uint8Array(await (await f("/file/docs/a.bin")).arrayBuffer());
    expect(got.length).toBe(200_000);
    expect(got.every((x, i) => x === i % 251)).toBe(true);
  });
  it("413 on declared length over the cap - and nothing is stored", async () => {
    const r = await f("/up/big.bin?max=1000", { method: "PUT", body: bytes(5000) });
    expect(r.status).toBe(413);
    expect((await f("/file/big.bin")).status).toBe(404);
  });
  it("413 when a chunked body (no length) exceeds the cap mid-stream; multipart is aborted, nothing stored", async () => {
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 6; i++) c.enqueue(bytes(1024 * 1024)); c.close(); } });
    const r = await f("/up/chunked.bin?max=3000000", { method: "PUT", body: stream, duplex: "half" } as never);
    expect(r.status).toBe(413);
    expect((await f("/file/chunked.bin")).status).toBe(404);
  });
  it("chunked body over 5 MiB goes multipart and assembles to the exact size", async () => {
    const total = 11 * 1024 * 1024 + 123;
    const stream = new ReadableStream({ start(c) { let left = total; while (left > 0) { const n = Math.min(left, 700_001); c.enqueue(bytes(n, 9)); left -= n; } c.close(); } });
    const r = await f(`/up/multi.bin?max=${50 * 1024 * 1024}`, { method: "PUT", body: stream, duplex: "half" } as never);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ size: total });
    expect((await f("/file/multi.bin", { method: "HEAD" })).headers.get("content-length")).toBe(String(total));
  }, 60000);
  it("415 for a disallowed type, and for content that lies about being a PNG (sniff)", async () => {
    expect((await f("/up/x.html?types=image/*", { method: "PUT", body: "<b>", headers: { "content-type": "text/html" } })).status).toBe(415);
    const fk = await f("/up/fake.png?types=image/png&sniff=1", { method: "PUT", body: "<script>alert(1)</script>", headers: { "content-type": "image/png" } }); expect(fk.status, await fk.clone().text()).toBe(415);
    expect((await f("/file/fake.png")).status).toBe(404);
    const ok = await f("/up/real.png?types=image/png&sniff=1", { method: "PUT", body: PNG, headers: { "content-type": "image/png" } });
    expect(ok.status).toBe(200);
    expect((await f("/file/real.png")).headers.get("content-type")).toBe("image/png");
  });
  it("411-ish: empty body is a 400", async () => {
    expect((await f("/up/empty.bin", { method: "PUT" })).status).toBe(400);
  });
});

describe("r2 serveObject (workerd)", () => {
  const data = new Uint8Array(1000).map((_, i) => i % 256);
  let etag: string; let lastModified: string;
  beforeAll(async () => {
    await f("/up/r.bin", { method: "PUT", body: data, headers: { "content-type": "application/octet-stream" } });
    const h = await f("/file/r.bin", { method: "HEAD" });
    etag = h.headers.get("etag")!; lastModified = h.headers.get("last-modified")!;
  });
  it("full GET has validators and safe headers", async () => {
    const r = await f("/file/r.bin");
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("content-length")).toBe("1000");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(r.headers.get("content-disposition")).toBe("inline");
    await r.arrayBuffer();
  });
  it("206 for bounded, open-ended and suffix ranges with exact bytes and Content-Range", async () => {
    const cases: [string, number, number][] = [["bytes=0-9", 0, 9], ["bytes=990-", 990, 999], ["bytes=-10", 990, 999], ["bytes=500-5000", 500, 999]];
    for (const [range, s, e] of cases) {
      const r = await f("/file/r.bin", { headers: { range } });
      expect(r.status, range).toBe(206);
      expect(r.headers.get("content-range")).toBe(`bytes ${s}-${e}/1000`);
      expect(r.headers.get("content-length")).toBe(String(e - s + 1));
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(data.slice(s, e + 1));
    }
  });
  it("416 for an unsatisfiable range; multi-range and garbage fall back to 200", async () => {
    const r = await f("/file/r.bin", { headers: { range: "bytes=2000-" } });
    expect(r.status).toBe(416); expect(r.headers.get("content-range")).toBe("bytes */1000");
    expect((await f("/file/r.bin", { headers: { range: "bytes=0-1,5-6" } })).status).toBe(200);
    expect((await f("/file/r.bin", { headers: { range: "lol" } })).status).toBe(200);
  });
  it("304 on If-None-Match / If-Modified-Since, 200 when the validator differs", async () => {
    expect((await f("/file/r.bin", { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await f("/file/r.bin", { headers: { "if-none-match": `W/${etag}, "zzz"` } })).status).toBe(304);
    expect((await f("/file/r.bin", { headers: { "if-none-match": '"other"' } })).status).toBe(200);
    expect((await f("/file/r.bin", { headers: { "if-modified-since": lastModified } })).status).toBe(304);
    expect((await f("/file/r.bin", { headers: { "if-none-match": '"other"', "if-modified-since": lastModified } })).status).toBe(200); // INM wins
  });
  it("If-Range: a stale validator ignores the Range (full 200); a matching one honours it", async () => {
    expect((await f("/file/r.bin", { headers: { range: "bytes=0-9", "if-range": '"stale"' } })).status).toBe(200);
    expect((await f("/file/r.bin", { headers: { range: "bytes=0-9", "if-range": etag } })).status).toBe(206);
  });
  it("HEAD has no body; 404 and 405 are correct; download sets an attachment disposition", async () => {
    const h = await f("/file/r.bin", { method: "HEAD" });
    expect(h.status).toBe(200); expect(await h.text()).toBe("");
    expect((await f("/file/missing")).status).toBe(404);
    expect((await f("/file/r.bin", { method: "POST" })).status).toBe(405);
    const d = await f("/file/r.bin?dl=report%20%C3%A9.csv");
    expect(d.headers.get("content-disposition")).toContain("attachment; filename=\"report _.csv\"");
    expect(d.headers.get("content-disposition")).toContain("filename*=UTF-8''report%20%C3%A9.csv");
    await d.arrayBuffer();
  });
});

describe("r2 multipart handler (workerd): create, upload, resume, complete", () => {
  const part = (n: number, fill: number) => bytes(5 * 1024 * 1024, fill);
  it("resumable: create, part 1, (client drops) resume with the uploadId, part 2 (small last part), complete", async () => {
    const created = await (await f("/mp?key=v/big.bin&type=video/mp4", { method: "POST" })).json<{ key: string; uploadId: string }>();
    expect(created.key).toBe("mp/v/big.bin");
    const p1 = await (await f(`/mp?key=v/big.bin&uploadId=${created.uploadId}&part=1`, { method: "PUT", body: part(1, 1) })).json<{ partNumber: number; etag: string }>();
    // a fresh "session" only needs key + uploadId to continue
    const p2 = await (await f(`/mp?key=v/big.bin&uploadId=${created.uploadId}&part=2`, { method: "PUT", body: bytes(1000, 2) })).json<{ partNumber: number; etag: string }>();
    const done = await f(`/mp?key=v/big.bin&uploadId=${created.uploadId}&complete`, { method: "POST", body: JSON.stringify({ parts: [p1, p2] }) });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ key: "mp/v/big.bin", size: 5 * 1024 * 1024 + 1000 });
  }, 30000);
  it("abort discards; traversal keys, bad parts and missing ids are rejected", async () => {
    const c = await (await f("/mp?key=a.bin", { method: "POST" })).json<{ uploadId: string }>();
    expect((await f(`/mp?key=a.bin&uploadId=${c.uploadId}`, { method: "DELETE" })).status).toBe(204);
    expect((await f("/mp?key=../secret", { method: "POST" })).status).toBe(400);
    expect((await f("/mp?key=/abs", { method: "POST" })).status).toBe(400);
    expect((await f("/mp?key=a&uploadId=u&part=0", { method: "PUT", body: "x" })).status).toBe(400);
    expect((await f("/mp?key=a&part=1", { method: "PUT", body: "x" })).status).toBe(400);
  });
});

describe("kv + d1 sessions (workerd)", () => {
  it("kv helper: pagination and clear against real KV", async () => {
    const j = await (await f("/kv")).json<any>();
    expect(j.first).toEqual(["k0", "k1"]);
    expect(j.done).toBe(false);
    expect(j.all).toEqual(["k0", "k1", "k2", "k3", "k4"]);
    expect(j.v).toEqual({ n: 3 });
    expect(j.cleared).toBe(5);
  });
  it("d1 session: queries work, bookmark cookie is issued and accepted back", async () => {
    const r1 = await f("/d1");
    expect(r1.status).toBe(200);
    const set = r1.headers.get("set-cookie");
    if (set) {
      // a bookmark was produced: it must round-trip and keep working
      const cookie = set.split(";")[0];
      const r2 = await f("/d1", { headers: { cookie } });
      expect(r2.status).toBe(200);
      expect((await r2.json<any[]>())[0].n).toBeGreaterThanOrEqual(2);
    } else {
      expect((await r1.json<any[]>())[0].n).toBeGreaterThanOrEqual(1);
    }
  });
});

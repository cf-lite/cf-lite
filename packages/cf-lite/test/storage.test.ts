import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToArray, parseJsonc, setIfMissing } from "../src/wrangler-edit.js";
import { addStorage, CliError, nextMigrationNumber, planDb, runDb } from "../src/cli-db.js";
import { kv } from "../src/modules/kv.js";
import { contentDisposition, parseRange, presignUrl, sigV4Presign, sniffType, typeAllowed } from "../src/modules/r2.js";
import { hyperdrive, withHyperdrive } from "../src/modules/hyperdrive.js";
import { D1_BOOKMARK_COOKIE, d1Session } from "../src/modules/d1.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cfl-storage-"));
const JSONC = `{
  // the app
  "name": "demo", /* block */
  "main": "server/worker.ts",
  "d1_databases": [
    { "binding": "DB", "database_name": "demo-db" }, // keep me
  ],
  "vars": { "A": "x//y" }
}
`;

describe("wrangler-edit", () => {
  it("parses JSONC incl. comments inside strings and trailing commas", () => {
    expect(parseJsonc(JSONC).vars.A).toBe("x//y");
    expect(parseJsonc(JSONC).d1_databases).toHaveLength(1);
  });
  it("appends to an existing array, preserving comments, and stays valid", () => {
    const r = addToArray(JSONC, "d1_databases", { binding: "DB2", database_name: "two" }, "binding");
    expect(r.changed).toBe(true);
    expect(r.text).toContain("// keep me");
    expect(r.text).toContain("// the app");
    expect(parseJsonc(r.text).d1_databases.map((d: any) => d.binding)).toEqual(["DB", "DB2"]);
  });
  it("is idempotent on the id key", () => {
    const r = addToArray(JSONC, "d1_databases", { binding: "DB", database_name: "zzz" }, "binding");
    expect(r).toEqual({ text: JSONC, changed: false });
  });
  it("creates a missing array key, with or without a trailing comma on the last entry", () => {
    for (const src of [`{\n  "name": "a"\n}\n`, `{\n  "name": "a",\n}\n`, `{}`, `{ "name": "a" } // end\n`]) {
      const r = addToArray(src, "kv_namespaces", { binding: "KV" }, "binding");
      expect(parseJsonc(r.text).kv_namespaces).toEqual([{ binding: "KV" }]);
    }
  });
  it("handles an empty array and arrays of other keys with the same name inside nested values", () => {
    const src = `{ "name": "a", "env": { "p": { "kv_namespaces": [] } }, "kv_namespaces": [] }`;
    const r = addToArray(src, "kv_namespaces", { binding: "K" }, "binding");
    const cfg = parseJsonc(r.text);
    expect(cfg.kv_namespaces).toEqual([{ binding: "K" }]);
    expect(cfg.env.p.kv_namespaces).toEqual([]); // nested one untouched
  });
  it("setIfMissing only adds absent keys", () => {
    expect(parseJsonc(setIfMissing(JSONC, "migrations_dir", "m").text).migrations_dir).toBe("m");
    expect(setIfMissing(JSONC, "name", "other").changed).toBe(false);
  });
});

function app(cfg = JSONC) {
  const d = tmp();
  writeFileSync(join(d, "wrangler.jsonc"), cfg);
  return d;
}

describe("cf-lite db", () => {
  it("numbers migrations after the highest existing one", () => {
    expect(nextMigrationNumber([])).toBe("0001");
    expect(nextMigrationNumber(["0001_a.sql", "0007_b.sql", "readme.md"])).toBe("0008");
  });
  it("`db new` plans the next file and never overwrites", () => {
    const d = app();
    mkdirSync(join(d, "migrations"));
    writeFileSync(join(d, "migrations/0001_init.sql"), "select 1;");
    const log: string[] = [];
    expect(runDb(d, ["new", "Add Posts!"], () => 0, (m) => log.push(m))).toBe(0);
    expect(existsSync(join(d, "migrations/0002_add_posts.sql"))).toBe(true);
    expect(() => planDb(d, ["new"])).toThrow(CliError);
  });
  it("`apply` is local by default and targets the database name", () => {
    const d = app();
    expect(planDb(d, ["apply"])).toEqual({ action: "wrangler", args: ["d1", "migrations", "apply", "demo-db", "--local"], remote: false });
    expect(planDb(d, ["status", "--persist-to", "/x"])).toMatchObject({ args: ["d1", "migrations", "list", "demo-db", "--local", "--persist-to", "/x"] });
  });
  it("refuses remote apply without --yes, allows status --remote, and never reaches wrangler when refused", () => {
    const d = app();
    const spawn = vi.fn(() => 0);
    expect(() => runDb(d, ["apply", "--remote"], spawn)).toThrow(/REMOTE.*--yes/s);
    expect(spawn).not.toHaveBeenCalled();
    expect(planDb(d, ["status", "--remote"])).toMatchObject({ remote: true });
    expect(planDb(d, ["apply", "--remote", "--yes"])).toMatchObject({ args: expect.arrayContaining(["--remote"]) });
  });
  it("picks among several databases and explains when ambiguous", () => {
    const d = app(`{"name":"a","d1_databases":[{"binding":"DB","database_name":"one"},{"binding":"LOGS","database_name":"two"}]}`);
    expect(() => planDb(d, ["apply"])).toThrow(/--db/);
    expect(planDb(d, ["apply", "--db", "LOGS"])).toMatchObject({ args: expect.arrayContaining(["two"]) });
    expect(() => planDb(d, ["apply", "--db", "nope"])).toThrow(/no D1 database/);
  });
  it("honours migrations_dir and --env scoped databases; errors without config/databases", () => {
    const d = app(`{"name":"a","d1_databases":[{"binding":"DB","database_name":"one","migrations_dir":"db/m"}],"env":{"prod":{"d1_databases":[{"binding":"DB","database_name":"prod-db"}]}}}`);
    expect((planDb(d, ["new", "x"]) as any).file).toContain("db/m/0001_x.sql");
    expect(planDb(d, ["apply", "--env", "prod"])).toMatchObject({ args: expect.arrayContaining(["prod-db", "--env", "prod"]) });
    expect(() => planDb(tmp(), ["apply"])).toThrow(/wrangler/);
    expect(() => planDb(app(`{"name":"a"}`), ["apply"])).toThrow(/cf-lite add d1/);
    expect(() => planDb(d, ["bogus"])).toThrow(/usage/);
  });
});

describe("cf-lite add d1|kv|r2|hyperdrive", () => {
  it("adds each binding, idempotently, without touching comments", () => {
    const d = app();
    for (const k of ["d1", "kv", "r2", "hyperdrive"] as const) expect(addStorage(d, k, k === "d1" ? { binding: "DB2" } : {}).changed).toBe(true);
    const text = readFileSync(join(d, "wrangler.jsonc"), "utf8");
    expect(text).toContain("// keep me");
    const cfg = parseJsonc(text);
    expect(cfg.d1_databases.map((x: any) => x.binding)).toEqual(["DB", "DB2"]);
    expect(cfg.kv_namespaces).toEqual([{ binding: "KV" }]);
    expect(cfg.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "demo-uploads" }]);
    expect(cfg.hyperdrive[0].binding).toBe("HYPERDRIVE");
    for (const k of ["d1", "kv", "r2", "hyperdrive"] as const) expect(addStorage(d, k, k === "d1" ? { binding: "DB2" } : {}).changed).toBe(false);
    expect(readFileSync(join(d, "wrangler.jsonc"), "utf8")).toBe(text);
  });
  it("rejects bad binding names and missing config", () => {
    expect(() => addStorage(app(), "kv", { binding: "my-kv" })).toThrow(/UPPER_SNAKE/);
    expect(() => addStorage(tmp(), "kv")).toThrow(CliError);
  });
});

describe("kv helper", () => {
  function fakeKv() {
    const m = new Map<string, { v: string; o: any }>();
    return {
      m,
      get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!.v) : null),
      getWithMetadata: async (k: string) => ({ value: m.has(k) ? JSON.parse(m.get(k)!.v) : null, metadata: m.get(k)?.o.metadata ?? null }),
      put: async (k: string, v: string, o: any) => void m.set(k, { v, o }),
      delete: async (k: string) => void m.delete(k),
      list: async ({ prefix = "", limit = 1000, cursor }: any) => {
        const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
        const from = cursor ? Number(cursor) : 0;
        const page = all.slice(from, from + limit);
        const done = from + limit >= all.length;
        return { keys: page.map((name) => ({ name })), list_complete: done, cursor: String(from + limit) };
      },
    } as unknown as KVNamespace & { m: Map<string, { v: string; o: any }> };
  }
  it("round-trips JSON, prefixes keys, clamps TTL to KV's 60 s floor", async () => {
    const ns = fakeKv(); const s = kv<{ n: number }, { by: string }>(ns, { prefix: "u:", ttl: 5 });
    await s.put("a", { n: 1 }, { metadata: { by: "me" } });
    expect(ns.m.get("u:a")!.o).toEqual({ expirationTtl: 60, metadata: { by: "me" } });
    expect(await s.get("a")).toEqual({ n: 1 });
    expect(await s.getWithMetadata("a")).toEqual({ value: { n: 1 }, metadata: { by: "me" } });
    await s.put("b", { n: 2 }, { ttl: 3600 });
    expect(ns.m.get("u:b")!.o.expirationTtl).toBe(3600);
    await s.put("c", { n: 3 }, { expiresAt: 1 });
    expect(ns.m.get("u:c")!.o.expiration).toBeGreaterThan(Date.now() / 1000);
  });
  it("paginates and clears by prefix", async () => {
    const ns = fakeKv(); const s = kv<number>(ns, { prefix: "p:" });
    for (let i = 0; i < 7; i++) await s.put("k" + i, i);
    await ns.put("other", "1", {});
    const p1 = await s.list({ limit: 3 });
    expect(p1.keys.map((x) => x.key)).toEqual(["k0", "k1", "k2"]); expect(p1.done).toBe(false);
    const all: string[] = []; for await (const k of s.keys({ pageSize: 2 })) all.push(k);
    expect(all).toHaveLength(7);
    expect(await s.clear()).toBe(7);
    expect([...ns.m.keys()]).toEqual(["other"]);
  });
});

describe("hyperdrive helper", () => {
  it("closes the client via waitUntil on success and on error, exactly once", async () => {
    for (const fail of [false, true]) {
      const end = vi.fn(async () => {}); const waits: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
      const run = withHyperdrive({ connectionString: "postgres://x" }, ctx, (url) => ({ url, end }), (c) => { if (fail) throw new Error("query failed"); return c.url; });
      if (fail) await expect(run).rejects.toThrow("query failed"); else expect(await run).toBe("postgres://x");
      await Promise.all(waits);
      expect(end).toHaveBeenCalledTimes(1);
    }
  });
  it("a failing close never masks the result", async () => {
    const waits: Promise<unknown>[] = [];
    const r = await withHyperdrive({ connectionString: "u" }, { waitUntil: (p) => void waits.push(p) }, () => ({ end: () => { throw new Error("boom"); } }), () => 42);
    await Promise.all(waits); expect(r).toBe(42);
  });
  it("manual form closes once; missing connection string is an actionable error", async () => {
    const end = vi.fn(); const waits: Promise<unknown>[] = [];
    const h = await hyperdrive({ connectionString: "u" }, { waitUntil: (p) => void waits.push(p) }, () => ({ end }));
    h.close(); h.close(); await Promise.all(waits); expect(end).toHaveBeenCalledTimes(1);
    await expect(withHyperdrive({ connectionString: "" }, { waitUntil() {} }, () => ({ end() {} }), () => 1)).rejects.toThrow(/CLOUDFLARE_HYPERDRIVE_LOCAL/);
  });
});

describe("d1Session", () => {
  const mk = (bookmark: string | null) => {
    const withSession = vi.fn(() => ({ getBookmark: () => bookmark }) as unknown as D1DatabaseSession);
    return { db: { withSession } as unknown as D1Database, withSession };
  };
  it("starts from the cookie bookmark and commits the new one", async () => {
    const { db, withSession } = mk("bm-2");
    const s = d1Session(db, new Request("https://x/", { headers: { cookie: `a=1; ${D1_BOOKMARK_COOKIE}=bm-1` } }));
    expect(withSession).toHaveBeenCalledWith("bm-1");
    const res = s.commit(new Response("ok"));
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${D1_BOOKMARK_COOKIE}=bm-2; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$`));
    expect(await res.text()).toBe("ok");
  });
  it("ignores hostile bookmarks, defaults to first-unconstrained, skips the cookie when unchanged", () => {
    const { db, withSession } = mk("bm-1");
    const s = d1Session(db, new Request("https://x/", { headers: { cookie: `${D1_BOOKMARK_COOKIE}=bad/bookmark;x`, "x-d1-bookmark": "a b" } }));
    expect(withSession).toHaveBeenCalledWith("first-unconstrained");
    expect(s.bookmark).toBeUndefined();
    const same = d1Session(mk("bm-1").db, new Request("https://x/", { headers: { "x-d1-bookmark": "bm-1" } }));
    expect(same.commit(new Response("")).headers.has("set-cookie")).toBe(false);
    expect(d1Session(mk("z").db, new Request("https://x/"), { constraint: "first-primary" }).bookmark).toBeUndefined();
  });
});

describe("r2 pure helpers", () => {
  it("presign matches the AWS SigV4 documentation vector", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await sigV4Presign({
      method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3", expiresIn: 86400, date: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
  it("R2 presign: path-style URL, encoded key, pinned content-type is signed, bounds enforced", async () => {
    const cfg = { accountId: "acct", accessKeyId: "AK", secretAccessKey: "SK", bucket: "b" };
    const u = new URL(await presignUrl(cfg, "PUT", "dir/my file+é.png", { contentType: "image/png", date: new Date("2026-01-01T00:00:00Z") }));
    expect(u.origin).toBe("https://acct.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/b/dir/my%20file%2B%C3%A9.png");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(u.searchParams.get("X-Amz-Credential")).toBe("AK/20260101/auto/s3/aws4_request");
    const other = new URL(await presignUrl(cfg, "PUT", "dir/my file+é.png", { contentType: "image/jpeg", date: new Date("2026-01-01T00:00:00Z") }));
    expect(other.searchParams.get("X-Amz-Signature")).not.toBe(u.searchParams.get("X-Amz-Signature"));
    await expect(presignUrl(cfg, "GET", "k", { expiresIn: 0 })).rejects.toThrow(/expiresIn/);
    await expect(presignUrl(cfg, "GET", "k", { expiresIn: 604801 })).rejects.toThrow(/expiresIn/);
    expect(() => presignUrl(cfg, "GET", "/abs")).toThrow(/relative/);
  });
  it("parseRange: bounded, open-ended, suffix, clamped, invalid, ignorable", () => {
    expect(parseRange("bytes=0-4", 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=-100", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=5-999", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("invalid");
    expect(parseRange("bytes=6-2", 10)).toBe("invalid");
    expect(parseRange("bytes=-0", 10)).toBe("invalid");
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange(null, 10)).toBeNull();
  });
  it("contentDisposition cannot be broken out of", () => {
    expect(contentDisposition("inline")).toBe("inline");
    const v = contentDisposition("attachment", 'a"\r\nSet-Cookie: x=1/../é.txt');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v).toContain('filename="a_Set-Cookie: x=1_..__.txt"');
    expect(v).toContain("filename*=UTF-8''");
  });
  it("type allow-list and magic sniffing", () => {
    expect(typeAllowed("image/png; charset=x", ["image/*"])).toBe(true);
    expect(typeAllowed("application/pdf", ["image/*", "application/pdf"])).toBe(true);
    expect(typeAllowed("text/html", ["image/*"])).toBe(false);
    expect(typeAllowed(null, ["image/*"])).toBe(false);
    expect(typeAllowed("anything/x")).toBe(true);
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffType(new TextEncoder().encode("<html>"))).toBeUndefined();
  });
});

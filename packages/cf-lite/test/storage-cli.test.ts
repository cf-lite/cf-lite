/** `cf-lite db` against the real wrangler (local D1 only - remote is never touched by tests). */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHmac, createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDb } from "../src/cli-db.js";
import { presignUrl } from "../src/modules/r2.js";

const pj = createRequire(import.meta.url).resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);

function wrangler(cwd: string) {
  let out = "";
  const code = (args: string[]) => { const r = spawnSync(process.execPath, [wr, ...args], { cwd, encoding: "utf8" }); out = r.stdout + r.stderr; return r.status ?? 1; };
  return { code, out: () => out };
}

describe("cf-lite db apply/status (real wrangler, local D1)", () => {
  it("new -> apply creates tables once; a second apply is a no-op; a later migration applies alone; remote is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfl-db-"));
    writeFileSync(join(dir, "wrangler.jsonc"), `{ "name": "t", "compatibility_date": "2026-09-01", "d1_databases": [{ "binding": "DB", "database_name": "t-db", "database_id": "local" }] }`);
    const w = wrangler(dir);
    const persist = ["--persist-to", join(dir, "state")];
    const silent = () => {};
    expect(runDb(dir, ["new", "init"], w.code, silent)).toBe(0);
    const m1 = join(dir, "migrations/0001_init.sql");
    writeFileSync(m1, "create table posts (id integer primary key, title text not null);");

    expect(runDb(dir, ["apply", ...persist], w.code, silent)).toBe(0);
    expect(w.out()).toMatch(/0001_init\.sql/);

    expect(runDb(dir, ["apply", ...persist], w.code, silent)).toBe(0);
    expect(w.out()).toMatch(/No migrations to apply/i);

    expect(runDb(dir, ["new", "add comments"], w.code, silent)).toBe(0);
    writeFileSync(join(dir, "migrations/0002_add_comments.sql"), "create table comments (id integer primary key, post_id integer references posts(id));");
    expect(runDb(dir, ["status", ...persist], w.code, silent)).toBe(0);
    expect(w.out()).toMatch(/0002_add_comments\.sql/);
    expect(runDb(dir, ["apply", ...persist], w.code, silent)).toBe(0);
    expect(w.out()).toMatch(/0002_add_comments\.sql/);
    expect(w.out()).not.toMatch(/0001_init\.sql/);

    expect(() => runDb(dir, ["apply", "--remote"], () => { throw new Error("must not spawn"); }, silent)).toThrow(/--yes/);
  }, 120000);
});

// An independent S3-style verifier (node:crypto, written separately from the signer) proves the presigned URL is
// accepted by a server that recomputes the signature from the request as it arrives - the same thing R2 does.
describe("presigned URL round-trip against a local S3-style verifier", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const hm = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  function verify(method: string, rawUrl: string, host: string, headers: Record<string, string | string[] | undefined>, secret: string): "ok" | string {
    const u = new URL(rawUrl, "http://x");
    const q = u.searchParams;
    const given = q.get("X-Amz-Signature"); q.delete("X-Amz-Signature");
    const date = q.get("X-Amz-Date")!; const [ak, day, region, service] = q.get("X-Amz-Credential")!.split("/");
    const expires = Number(q.get("X-Amz-Expires"));
    const t = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15));
    if (Date.now() > t + expires * 1000) return "expired";
    const signed = q.get("X-Amz-SignedHeaders")!.split(";");
    const canonHeaders = signed.map((h) => `${h}:${h === "host" ? host : String(headers[h]).trim()}\n`).join("");
    const query = [...q].map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join("&");
    const canonical = [method, u.pathname, query, canonHeaders, signed.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
    const sts = ["AWS4-HMAC-SHA256", date, `${day}/${region}/${service}/aws4_request`, sha(canonical)].join("\n");
    const key = hm(hm(hm(hm("AWS4" + secret, day), region), service), "aws4_request");
    return ak && createHmac("sha256", key).update(sts).digest("hex") === given ? "ok" : "SignatureDoesNotMatch";
  }
  it("accepts untampered GET/PUT, rejects tampered path/query/header/expiry", async () => {
    const store = new Map<string, string>();
    const srv = createServer((req, res) => {
      const r = verify(req.method!, req.url!, req.headers.host!, req.headers, "SECRET");
      if (r !== "ok") { res.statusCode = 403; return res.end(r); }
      const path = new URL(req.url!, "http://x").pathname;
      if (req.method === "PUT") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { store.set(path, b); res.end("stored"); }); return; }
      res.end(store.get(path) ?? "");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const endpoint = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
      const cfg = { accountId: "a", accessKeyId: "AK", secretAccessKey: "SECRET", bucket: "bkt", endpoint };
      const key = "uploads/some dir/fil+e é.txt";
      const put = await presignUrl(cfg, "PUT", key, { contentType: "text/plain" });
      expect((await fetch(put, { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } })).status).toBe(200);
      expect((await fetch(put, { method: "PUT", body: "hello", headers: { "content-type": "text/html" } })).status).toBe(403); // pinned type
      const get = await presignUrl(cfg, "GET", key);
      expect(await (await fetch(get)).text()).toBe("hello");
      expect((await fetch(get.replace("some%20dir", "other"))).status).toBe(403);
      expect((await fetch(get + "&extra=1")).status).toBe(403);
      expect((await fetch(get.replace(/X-Amz-Expires=\d+/, "X-Amz-Expires=99999"))).status).toBe(403);
      expect((await fetch(await presignUrl(cfg, "GET", key, { date: new Date(Date.now() - 3600_000), expiresIn: 60 }))).status).toBe(403);
      expect((await fetch(get, { method: "PUT", body: "x" })).status).toBe(403); // a GET URL cannot PUT
    } finally { srv.close(); }
  });
});

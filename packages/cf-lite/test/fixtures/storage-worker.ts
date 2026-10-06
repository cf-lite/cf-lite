/// <reference types="@cloudflare/workers-types" />
import { multipartHandler, presignUrl, serveObject, uploadStream, UploadError } from "../../src/modules/r2.js";
import { kv } from "../../src/modules/kv.js";
import { d1, d1Session } from "../../src/modules/d1.js";

interface Env { BUCKET: R2Bucket; KV: KVNamespace; DB: D1Database }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const u = new URL(req.url);
    const key = decodeURIComponent(u.pathname.replace(/^\/(file|up)\//, ""));
    try {
      if (u.pathname.startsWith("/up/")) {
        const r = await uploadStream(env.BUCKET, key, req, { maxBytes: Number(u.searchParams.get("max") ?? 1024 * 1024), allowTypes: u.searchParams.get("types")?.split(","), sniff: u.searchParams.has("sniff") });
        return Response.json(r);
      }
      if (u.pathname.startsWith("/file/")) return serveObject(env.BUCKET, req, key, { download: u.searchParams.get("dl") ?? undefined });
      if (u.pathname === "/mp") return multipartHandler(env.BUCKET, { prefix: "mp/", maxBytes: 20 * 1024 * 1024 })(req);
      if (u.pathname === "/presign") return new Response(await presignUrl({ accountId: "a", accessKeyId: "AK", secretAccessKey: "SK", bucket: "b" }, "GET", "k"));
      if (u.pathname === "/kv") {
        const s = kv<{ n: number }>(env.KV, { prefix: "t:" });
        for (let i = 0; i < 5; i++) await s.put("k" + i, { n: i });
        const page = await s.list({ limit: 2 });
        const all: string[] = []; for await (const k of s.keys({ pageSize: 2 })) all.push(k);
        return Response.json({ first: page.keys.map((k) => k.key), done: page.done, all, v: await s.get("k3"), cleared: await s.clear() });
      }
      if (u.pathname === "/d1") {
        const s = d1Session(env.DB, req);
        const q = d1(s.db);
        await env.DB.exec("create table if not exists t (id integer primary key, v text)");
        await d1(env.DB).run("insert into t (v) values (?)", "x");
        const rows = await q.all("select count(*) as n from t");
        return s.commit(Response.json(rows));
      }
      return new Response("nope", { status: 404 });
    } catch (e) {
      if (e instanceof UploadError) return e.toResponse();
      return new Response(String((e as Error).stack ?? e), { status: 500 });
    }
  },
};

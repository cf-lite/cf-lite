import { Hono } from "hono";
import { d1, d1Session } from "cf-lite/modules/d1";
import { kv } from "cf-lite/modules/kv";
import { multipartHandler, presignUrl, serveObject, UploadError, uploadStream } from "cf-lite/modules/r2";

const limits = (env: Env) => ({ maxBytes: Number(env.MAX_UPLOAD_BYTES) || 5 * 1024 * 1024, allowTypes: ["image/*", "application/pdf", "text/plain"], sniff: true });
const keyOf = (name: string) => name.replace(/[^\w.-]+/g, "_").slice(0, 100);

export default new Hono<{ Bindings: Env }>()
  // list: read through a D1 Session so a visitor sees their own writes even on a read replica
  .get("/", async (c) => {
    const s = d1Session(c.env.DB, c.req.raw);
    const rows = await d1(s.db).all("select key, size, content_type, created_at from files order by created_at desc limit 50");
    return s.commit(c.json(rows));
  })
  // upload: streamed through the Worker, size/type enforced while streaming
  .put("/:name", async (c) => {
    const key = `u/${keyOf(c.req.param("name"))}`;
    try {
      const r = await uploadStream(c.env.BUCKET, key, c.req.raw, limits(c.env));
      await d1(c.env.DB).run("insert or replace into files (key, size, content_type, etag) values (?, ?, ?, ?)", r.key, r.size, r.contentType, r.etag);
      const hits = kv<number>(c.env.KV, { prefix: "stats:" });
      await hits.put("uploads", ((await hits.get("uploads")) ?? 0) + 1);
      return c.json(r, 201);
    } catch (e) {
      if (e instanceof UploadError) return e.toResponse();
      throw e;
    }
  })
  // download: Range / ETag / 304 handled by serveObject
  .get("/:name/raw", (c) => serveObject(c.env.BUCKET, c.req.raw, `u/${keyOf(c.req.param("name"))}`, { cacheControl: "private, max-age=60" }))
  // browser-direct upload: hand out a short-lived presigned PUT URL (needs the R2_* secrets)
  .post("/:name/presign", async (c) => {
    const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET_NAME: bucket } = c.env;
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return c.text("presigned URLs are not configured (set the R2_* secrets)", 501);
    const contentType = c.req.query("type") ?? "application/octet-stream";
    const url = await presignUrl({ accountId, accessKeyId, secretAccessKey, bucket }, "PUT", `direct/${keyOf(c.req.param("name"))}`, { contentType, expiresIn: 300 });
    return c.json({ url, headers: { "content-type": contentType } });
  })
  // large files: resumable multipart under big/
  .all("/multipart/*", (c) => multipartHandler(c.env.BUCKET, { prefix: "big/", maxBytes: 500 * 1024 * 1024 })(c.req.raw));

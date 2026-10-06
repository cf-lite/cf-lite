import { beforeAll, describe, expect, it } from "vitest";
import { multipartHandler, serveObject, uploadStream, UploadError } from "../src/modules/r2.js";
import { fakeBucket, installFixedLengthStream } from "./r2-helpers.js";

beforeAll(installFixedLengthStream);

describe("uploadStream", () => {
  it("rejects disallowed type before reading the body", async () => {
    const { bucket } = fakeBucket();
    await expect(uploadStream(bucket, "k", new Request("https://x/", { method: "POST", headers: { "content-type": "text/html" }, body: "x" }), { maxBytes: 10, allowTypes: ["image/*"] })).rejects.toMatchObject({ status: 415 });
  });
  it("rejects empty body and content-length: 0", async () => {
    const { bucket } = fakeBucket();
    await expect(uploadStream(bucket, "k", { body: null, headers: new Headers() }, { maxBytes: 10 })).rejects.toMatchObject({ status: 400 });
    await expect(uploadStream(bucket, "k", { body: new Blob(["x"]).stream(), headers: new Headers({ "content-length": "0" }) }, { maxBytes: 10 })).rejects.toMatchObject({ status: 400 });
  });
  it("declared length over the cap is refused (413) without touching R2", async () => {
    const { bucket, objects } = fakeBucket();
    await expect(uploadStream(bucket, "k", { body: new Blob(["xx"]).stream(), headers: new Headers({ "content-length": "99" }) }, { maxBytes: 10 })).rejects.toMatchObject({ status: 413 });
    expect(objects.size).toBe(0);
  });
  it("a client lying about Content-Length (more bytes than the cap) trips the stream limit", async () => {
    const { bucket, objects } = fakeBucket();
    const err = await uploadStream(bucket, "k", { body: new Blob(["x".repeat(50)]).stream(), headers: new Headers({ "content-length": "5" }) }, { maxBytes: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.status).toBe(413);
    expect(objects.has("k")).toBe(false);
  });
  it("stores a body with a valid Content-Length", async () => {
    const { bucket, objects } = fakeBucket();
    const r = await uploadStream(bucket, "a/b", { body: new Blob(["hello"]).stream(), headers: new Headers({ "content-length": "5", "content-type": "text/plain; charset=utf-8" }) }, { maxBytes: 10, customMetadata: { u: "1" } });
    expect(r).toMatchObject({ key: "a/b", size: 5, contentType: "text/plain" });
    expect(objects.get("a/b")!.customMetadata).toEqual({ u: "1" });
  });
  it("sniff: declared png whose bytes are not a png is refused (415), real png accepted", async () => {
    const { bucket } = fakeBucket();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const ok = await uploadStream(bucket, "p", { body: new Blob([png]).stream(), headers: new Headers({ "content-length": String(png.length), "content-type": "image/png" }) }, { maxBytes: 100, sniff: true });
    expect(ok.size).toBe(png.length);
    const bad = new Blob(["<html>not a png at all, sorry</html>"]);
    await expect(uploadStream(bucket, "q", { body: bad.stream(), headers: new Headers({ "content-length": String(bad.size), "content-type": "image/png" }) }, { maxBytes: 100, sniff: true })).rejects.toMatchObject({ status: 415 });
    // short body (< 12 bytes) is checked at flush
    const tiny = new Blob(["hi"]);
    await expect(uploadStream(bucket, "r", { body: tiny.stream(), headers: new Headers({ "content-length": "2", "content-type": "application/pdf" }) }, { maxBytes: 100, sniff: true })).rejects.toMatchObject({ status: 415 });
  });
  it("no Content-Length -> multipart path splits into parts and completes", async () => {
    const { bucket, objects } = fakeBucket();
    const MiB = 1024 * 1024;
    const data = new Uint8Array(11 * MiB).fill(7);
    const r = await uploadStream(bucket, "big", { body: new Blob([data]).stream(), headers: new Headers({ "content-type": "application/octet-stream" }) }, { maxBytes: 20 * MiB, partSize: 5 * MiB });
    expect(r.size).toBe(11 * MiB);
    expect(objects.get("big")!.size).toBe(11 * MiB);
    expect(bucket.partCounts.at(-1)).toBe(3); // 5 + 5 + 1 MiB
  });
  it("multipart path: cap exceeded aborts the upload and stores nothing", async () => {
    const { bucket, objects } = fakeBucket();
    const MiB = 1024 * 1024;
    const err = await uploadStream(bucket, "big", { body: new Blob([new Uint8Array(7 * MiB)]).stream(), headers: new Headers() }, { maxBytes: 6 * MiB, partSize: 5 * MiB }).catch((e) => e);
    expect(err.status).toBe(413);
    expect(objects.size).toBe(0);
    expect(bucket.aborted).toBe(1);
  });
});

describe("multipartHandler", () => {
  const H = (o = {}) => { const f = fakeBucket(); return { ...f, h: multipartHandler(f.bucket, { prefix: "up/", ...o }) }; };
  const u = (q: string) => "https://x/api/upload?" + q;
  it("authorize runs first and can deny", async () => {
    const { h } = H({ authorize: () => new Response("no", { status: 401 }) });
    expect((await h(new Request(u("key=a"), { method: "POST" }))).status).toBe(401);
  });
  it("rejects path traversal / absolute / NUL / missing keys", async () => {
    const { h } = H();
    for (const k of ["../x", "a/../b", "/abs", "a/./b", "a%00b", ""]) expect((await h(new Request(u("key=" + k), { method: "POST" }))).status, k).toBe(400);
    expect((await h(new Request(u(""), { method: "POST" }))).status).toBe(400);
  });
  it("create honours allowTypes and prefixes the key", async () => {
    const { h } = H({ allowTypes: ["image/*"] });
    expect((await h(new Request(u("key=a&type=text/html"), { method: "POST" }))).status).toBe(415);
    const r = await h(new Request(u("key=a&type=image/png"), { method: "POST" }));
    expect(await r.json()).toMatchObject({ key: "up/a" });
  });
  it("part / complete / abort validation", async () => {
    const { h, bucket, objects } = H({ maxPartBytes: 10, maxBytes: 8 });
    const { uploadId } = (await (await h(new Request(u("key=a"), { method: "POST" }))).json()) as { uploadId: string };
    const put = (q: string, body: string | null, len?: string) => h(new Request(u(q), { method: "PUT", body, headers: len ? { "content-length": len } : undefined }));
    expect((await put("key=a&part=1", "x")).status).toBe(400); // uploadId required
    for (const p of ["0", "10001", "1.5", "abc"]) expect((await put(`key=a&uploadId=${uploadId}&part=${p}`, "x", "1")).status, p).toBe(400);
    expect((await put(`key=a&uploadId=${uploadId}&part=1`, "x".repeat(11), "11")).status).toBe(413);
    expect((await put(`key=a&uploadId=${uploadId}&part=1`, null)).status).toBe(411);
    const p1 = await (await put(`key=a&uploadId=${uploadId}&part=1`, "x".repeat(9), "9")).json();
    const complete = (parts: unknown) => h(new Request(u(`key=a&uploadId=${uploadId}&complete`), { method: "POST", body: JSON.stringify({ parts }) }));
    expect((await complete([])).status).toBe(400);
    expect((await complete("nope")).status).toBe(400);
    // assembled object over maxBytes is deleted again
    expect((await complete([p1])).status).toBe(413);
    expect(objects.has("up/a")).toBe(false);
    expect(bucket.deleted).toContain("up/a");
    expect((await h(new Request(u(`key=a&uploadId=${uploadId}`), { method: "DELETE" }))).status).toBe(204);
    expect((await h(new Request(u(`key=a&uploadId=${uploadId}`), { method: "PATCH" }))).status).toBe(405);
  });
  it("R2 errors become 400, not a throw", async () => {
    const { h } = H();
    expect((await h(new Request(u("key=a&uploadId=ghost"), { method: "POST", body: "{bad json", headers: {} }))).status).toBe(405);
    expect((await h(new Request(u("key=a&uploadId=ghost&complete"), { method: "POST", body: "{bad json" }))).status).toBe(400);
  });
});

describe("serveObject", () => {
  const seed = async () => { const f = fakeBucket(); await f.bucket.put("f/doc.txt", new Blob(["0123456789"]).stream(), { httpMetadata: { contentType: "text/plain" } }); return f; };
  const get = (b: R2Bucket, h: Record<string, string> = {}, method = "GET", key = "f/doc.txt", o = {}) => serveObject(b, new Request("https://x/f", { method, headers: h }), key, o);
  it("404 / 405", async () => {
    const { bucket } = await seed();
    expect((await get(bucket, {}, "GET", "nope")).status).toBe(404);
    const r = await get(bucket, {}, "POST");
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });
  it("200 with nosniff, etag, length; HEAD has no body", async () => {
    const { bucket } = await seed();
    const r = await get(bucket);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-length")).toBe("10");
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await r.text()).toBe("0123456789");
    const hd = await get(bucket, {}, "HEAD");
    expect(hd.status).toBe(200);
    expect(hd.headers.get("content-length")).toBe("10");
    expect(await hd.text()).toBe("");
  });
  it("conditional: If-None-Match (weak, list, *) and If-Modified-Since; INM wins over IMS", async () => {
    const { bucket } = await seed();
    const etag = (await get(bucket)).headers.get("etag")!;
    expect((await get(bucket, { "if-none-match": "W/" + etag })).status).toBe(304);
    expect((await get(bucket, { "if-none-match": `"zzz", ${etag}` })).status).toBe(304);
    expect((await get(bucket, { "if-none-match": "*" })).status).toBe(304);
    expect((await get(bucket, { "if-none-match": '"other"' })).status).toBe(200);
    const future = new Date(Date.now() + 86400e3).toUTCString();
    expect((await get(bucket, { "if-modified-since": future })).status).toBe(304);
    expect((await get(bucket, { "if-modified-since": "garbage" })).status).toBe(200);
    expect((await get(bucket, { "if-none-match": '"other"', "if-modified-since": future })).status).toBe(200);
  });
  it("Range: 206, suffix, open-ended, 416, If-Range mismatch serves full", async () => {
    const { bucket } = await seed();
    const r = await get(bucket, { range: "bytes=2-4" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await r.text()).toBe("234");
    expect(await (await get(bucket, { range: "bytes=-3" })).text()).toBe("789");
    expect(await (await get(bucket, { range: "bytes=8-" })).text()).toBe("89");
    const bad = await get(bucket, { range: "bytes=50-60" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */10");
    const full = await get(bucket, { range: "bytes=2-4", "if-range": '"stale"' });
    expect(full.status).toBe(200);
    const etag = (await get(bucket)).headers.get("etag")!;
    expect((await get(bucket, { range: "bytes=2-4", "if-range": etag })).status).toBe(206);
  });
  it("precondition failure (object replaced between head and get) -> 412", async () => {
    const f = await seed();
    const realGet = f.bucket.get.bind(f.bucket);
    f.bucket.get = (async (k: string, o?: unknown) => { void realGet; void o; void k; return { etag: "x" } as never; }) as never; // no body = precondition failed
    expect((await get(f.bucket)).status).toBe(412);
    expect((await get(f.bucket, { range: "bytes=0-1" })).status).toBe(412);
  });
  it("download forces attachment with a header-injection-safe filename", async () => {
    const { bucket } = await seed();
    const r = await get(bucket, {}, "GET", "f/doc.txt", { download: 'a"\r\nx: y/é.txt', cacheControl: "private, no-store", headers: { "x-extra": "1" } });
    const cd = r.headers.get("content-disposition")!;
    expect(cd.startsWith("attachment; filename=")).toBe(true);
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd.split("filename*")[0]).not.toMatch(/"[^;]*"[^;]*"[^;]*"/); // the quote was neutralised
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("x-extra")).toBe("1");
    expect((await get(bucket, {}, "GET", "f/doc.txt", { download: true })).headers.get("content-disposition")).toContain('filename="doc.txt"');
  });
});

describe("saveUpload (actions)", () => {
  it("wraps a File into R2 and refuses empty / wrong-type files", async () => {
    const { bucket, objects } = fakeBucket();
    const { saveUpload } = await import("../src/modules/actions.js");
    const r = await saveUpload(bucket, new File(["hello"], "h.txt", { type: "text/plain" }), "k", { allowTypes: ["text/plain"] });
    expect(r.size).toBe(5);
    expect(objects.get("k")!.customMetadata).toMatchObject({ filename: "h.txt" });
    await expect(saveUpload(bucket, new File([], "e.txt"), "k")).rejects.toMatchObject({ status: 400 });
    await expect(saveUpload(bucket, "not a file", "k")).rejects.toMatchObject({ status: 400 });
    await expect(saveUpload(bucket, new File(["x"], "x.exe", { type: "application/x-msdownload" }), "k", { allowTypes: ["image/*"] })).rejects.toMatchObject({ status: 415 });
  });
});

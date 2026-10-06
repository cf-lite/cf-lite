/**
 * OPTIONAL module: R2 helpers a real app needs.
 *  (a) `uploadStream`   - proxy-streamed upload through the Worker with size/type limits, nothing buffered beyond one part
 *  (b) `presignUrl`     - SigV4 presigned GET/PUT URLs via the S3 API (needs R2 API-token secrets; no SDK)
 *  (c) `multipart*`     - resumable multipart helpers + a ready request handler
 *  (d) `serveObject`    - GET/HEAD with Range, conditional requests, ETag, Cache-Control, Content-Disposition
 */

// ---------------------------------------------------------------- (a) limits + streamed upload
export class UploadError extends Error {
  constructor(public status: 400 | 411 | 413 | 415, message: string) { super(message); }
  toResponse() { return new Response(this.message, { status: this.status }); }
}
export interface UploadLimits {
  /** Hard cap in bytes; enforced on the declared length AND on the bytes actually streamed. */
  maxBytes: number;
  /** Allowed content types: exact (`application/pdf`) or wildcard (`image/*`). Omit to allow anything. */
  allowTypes?: string[];
  /** Also check the first bytes against the declared type (png/jpeg/gif/webp/pdf/zip). Default false. */
  sniff?: boolean;
}
const MAGIC: [string, number[]][] = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]], ["image/jpeg", [0xff, 0xd8, 0xff]], ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]], ["application/zip", [0x50, 0x4b, 0x03, 0x04]],
];
const isWebp = (b: Uint8Array) => b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP";
export function sniffType(head: Uint8Array): string | undefined {
  if (isWebp(head)) return "image/webp";
  return MAGIC.find(([, sig]) => sig.every((x, i) => head[i] === x))?.[0];
}
export function typeAllowed(type: string | null | undefined, allow?: string[]): boolean {
  if (!allow) return true;
  const t = (type ?? "").split(";")[0].trim().toLowerCase();
  return allow.some((a) => { a = a.toLowerCase(); return a.endsWith("/*") ? t.startsWith(a.slice(0, -1)) : t === a; });
}

export interface UploadOptions extends UploadLimits {
  contentType?: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HTTPMetadata;
  /** Part size when the length is unknown up front (default 8 MiB, min 5 MiB). */
  partSize?: number;
}
export interface UploadResult { key: string; size: number; etag: string; contentType: string }

/** Wraps a stream, counting bytes and failing with 413 the moment `max` is exceeded. Also does magic-byte sniffing. */
function limitStream(max: number, trip: { err?: UploadError }, sniffAs?: string) {
  const fail = (status: 413 | 415, msg: string): never => { trip.err = new UploadError(status, msg); throw trip.err; };
  let n = 0; let head = new Uint8Array(0); let checked = !sniffAs;
  const check = () => { checked = true; if (sniffType(head) !== sniffAs) fail(415, `content does not look like ${sniffAs}`); };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      n += chunk.byteLength;
      if (n > max) fail(413, `body exceeds ${max} bytes`);
      if (!checked) {
        const merged = new Uint8Array(Math.min(16, head.length + chunk.length));
        merged.set(head); merged.set(chunk.subarray(0, merged.length - head.length), head.length); head = merged;
        if (head.length >= 12) check();
      }
      ctl.enqueue(chunk);
    },
    flush() { if (!checked) check(); },
  });
}

/**
 * Stream a request body into R2. With a Content-Length the body is piped straight through (constant memory);
 * without one it is split into multipart parts (chunked uploads). Throws `UploadError` (has `.toResponse()`).
 */
export async function uploadStream(bucket: R2Bucket, key: string, req: Request | { body: ReadableStream | null; headers: Headers }, opts: UploadOptions): Promise<UploadResult> {
  const type = (opts.contentType ?? req.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  // rejections happen before reading a byte; do NOT cancel the request body here, that aborts the connection instead of answering
  if (!typeAllowed(type, opts.allowTypes)) throw new UploadError(415, `content type ${type} not allowed`);
  if (!req.body || req.headers.get("content-length") === "0") throw new UploadError(400, "empty body");
  const declared = req.headers.get("content-length");
  const len = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
  if (len !== undefined && len > opts.maxBytes) throw new UploadError(413, `body exceeds ${opts.maxBytes} bytes`);
  const trip: { err?: UploadError } = {};
  const sniffAs = opts.sniff && (type === "image/webp" || MAGIC.some(([t]) => t === type)) ? type : undefined;
  const limited = req.body.pipeThrough(limitStream(opts.maxBytes, trip, sniffAs));
  const meta = { httpMetadata: { contentType: type, ...opts.httpMetadata }, customMetadata: opts.customMetadata };
  try {
    if (len !== undefined) {
      const fixed = new FixedLengthStream(len);
      const pipe = limited.pipeTo(fixed.writable);
      pipe.catch(() => {}); // if put() rejects first we never reach `await pipe`; the error is recovered from `trip` below (no unhandled rejection)
      const obj = await bucket.put(key, fixed.readable, meta);
      await pipe;
      return { key, size: obj.size, etag: obj.httpEtag, contentType: type };
    }
    return await streamMultipart(bucket, key, limited, meta, Math.max(5 * MiB, opts.partSize ?? 8 * MiB), type);
  } catch (e) {
    // R2 re-wraps errors from the body stream, so the original UploadError is recovered from the closure
    throw trip.err ?? e;
  }
}
const MiB = 1024 * 1024;
async function streamMultipart(bucket: R2Bucket, key: string, body: ReadableStream<Uint8Array>, meta: R2PutOptions, partSize: number, type: string): Promise<UploadResult> {
  const mp = await bucket.createMultipartUpload(key, meta);
  const parts: R2UploadedPart[] = [];
  let size = 0; let buf = new Uint8Array(partSize); let fill = 0;
  try {
    const flush = async (last: boolean) => {
      if (fill === 0 && !(last && parts.length === 0)) return;
      parts.push(await mp.uploadPart(parts.length + 1, buf.slice(0, fill)));
      size += fill; fill = 0;
    };
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.byteLength) {
        const take = Math.min(partSize - fill, value.byteLength - off);
        buf.set(value.subarray(off, off + take), fill); fill += take; off += take;
        if (fill === partSize) await flush(false);
      }
    }
    await flush(true);
    const obj = await mp.complete(parts);
    return { key, size, etag: obj.httpEtag, contentType: type };
  } catch (e) {
    await mp.abort().catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------- (b) SigV4 presigned URLs
export interface SigV4Input {
  method: string;
  url: string | URL;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
  /** Seconds the URL stays valid (1..604800). */
  expiresIn: number;
  /** Signing time (tests). */
  date?: Date;
  /** Extra headers that must be sent with the request and are therefore signed (e.g. `content-type`). */
  headers?: Record<string, string>;
}
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmac(key: ArrayBuffer | string, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** AWS Signature V4 query-string presign (S3 style: payload `UNSIGNED-PAYLOAD`, path not double-encoded). */
export async function sigV4Presign(i: SigV4Input): Promise<string> {
  if (!(i.expiresIn >= 1 && i.expiresIn <= 604800)) throw new Error("presign: expiresIn must be 1..604800 seconds");
  const url = new URL(i.url);
  const region = i.region ?? "auto"; const service = i.service ?? "s3";
  const amz = (i.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20130524T000000Z
  const day = amz.slice(0, 8);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const headers: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const q = new Map<string, string>([...url.searchParams]);
  q.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  q.set("X-Amz-Credential", `${i.accessKeyId}/${scope}`);
  q.set("X-Amz-Date", amz);
  q.set("X-Amz-Expires", String(Math.floor(i.expiresIn)));
  q.set("X-Amz-SignedHeaders", names.join(";"));
  const query = [...q].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const path = url.pathname.split("/").map((s) => rfc3986(decodeURIComponent(s))).join("/");
  const canonical = [i.method.toUpperCase(), path, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, await sha256(canonical)].join("\n");
  let k = await hmac("AWS4" + i.secretAccessKey, day);
  for (const part of [region, service, "aws4_request"]) k = await hmac(k, part);
  const sig = hex(await hmac(k, toSign));
  return `${url.origin}${path}?${query}&X-Amz-Signature=${sig}`;
}

export interface R2PresignConfig { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; /** custom S3 endpoint (tests, jurisdictions: `eu`) */ endpoint?: string }
/** Presigned URL for one object. PUT URLs may pin `contentType` (the client must then send exactly that header). */
export function presignUrl(cfg: R2PresignConfig, method: "GET" | "PUT" | "HEAD" | "DELETE", key: string, o: { expiresIn?: number; contentType?: string; date?: Date } = {}) {
  if (!key || key.startsWith("/")) throw new Error("presign: key must be non-empty and relative");
  const base = cfg.endpoint ?? `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  const url = `${base.replace(/\/$/, "")}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return sigV4Presign({
    method, url, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey,
    expiresIn: o.expiresIn ?? 900, date: o.date, headers: o.contentType ? { "content-type": o.contentType } : undefined,
  });
}

// ---------------------------------------------------------------- (c) multipart / resumable
/** Start a multipart upload; returns the ids the client needs to resume later. */
export async function multipartCreate(bucket: R2Bucket, key: string, meta?: R2PutOptions) {
  const mp = await bucket.createMultipartUpload(key, meta);
  return { key: mp.key, uploadId: mp.uploadId };
}
export const multipartResume = (bucket: R2Bucket, key: string, uploadId: string) => bucket.resumeMultipartUpload(key, uploadId);
export async function multipartPart(bucket: R2Bucket, key: string, uploadId: string, partNumber: number, body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob) {
  return bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
}
export async function multipartComplete(bucket: R2Bucket, key: string, uploadId: string, parts: R2UploadedPart[]) {
  return bucket.resumeMultipartUpload(key, uploadId).complete(parts);
}
export const multipartAbort = (bucket: R2Bucket, key: string, uploadId: string) => bucket.resumeMultipartUpload(key, uploadId).abort();

export interface MultipartHandlerOptions {
  /** Key prefix every upload lives under (clients cannot escape it). */
  prefix?: string;
  maxPartBytes?: number;
  /** Total cap across parts, enforced at complete (size of the assembled object). */
  maxBytes?: number;
  allowTypes?: string[];
  /** Return a Response to reject (auth). Runs before anything touches R2. */
  authorize?: (req: Request) => Response | void | Promise<Response | void>;
}
const safeKey = (prefix: string, key: string | null) => {
  if (!key || key.includes("\0") || key.split("/").some((s) => s === ".." || s === ".") || key.startsWith("/")) return null;
  return prefix + key;
};
/**
 * One handler for the four multipart calls, meant to be mounted at a path such as `/api/upload`:
 *   POST   ?key=k&type=image/png      -> {key, uploadId}
 *   PUT    ?key=k&uploadId=u&part=n   (body = part bytes) -> {partNumber, etag}
 *   POST   ?key=k&uploadId=u&complete (body JSON {parts:[{partNumber,etag}]}) -> {key,size,etag}
 *   DELETE ?key=k&uploadId=u          -> 204
 * Resuming = keep the uploadId, upload the missing parts, complete.
 */
export function multipartHandler(bucket: R2Bucket, o: MultipartHandlerOptions = {}) {
  const prefix = o.prefix ?? ""; const maxPart = o.maxPartBytes ?? 100 * MiB;
  return async (req: Request): Promise<Response> => {
    const denied = await o.authorize?.(req); if (denied) return denied;
    const u = new URL(req.url); const q = u.searchParams;
    const key = safeKey(prefix, q.get("key"));
    if (!key) return new Response("bad key", { status: 400 });
    const uploadId = q.get("uploadId");
    try {
      if (req.method === "POST" && !uploadId) {
        const type = (q.get("type") ?? "application/octet-stream").toLowerCase();
        if (!typeAllowed(type, o.allowTypes)) return new Response("type not allowed", { status: 415 });
        return Response.json(await multipartCreate(bucket, key, { httpMetadata: { contentType: type } }));
      }
      if (!uploadId) return new Response("uploadId required", { status: 400 });
      if (req.method === "PUT") {
        const n = Number(q.get("part"));
        if (!Number.isInteger(n) || n < 1 || n > 10000) return new Response("bad part", { status: 400 });
        const len = Number(req.headers.get("content-length"));
        if (!req.body || !Number.isFinite(len) || len <= 0) return new Response("Content-Length required", { status: 411 });
        if (len > maxPart) return new Response("part too large", { status: 413 });
        const p = await multipartPart(bucket, key, uploadId, n, req.body);
        return Response.json({ partNumber: p.partNumber, etag: p.etag });
      }
      if (req.method === "POST" && q.has("complete")) {
        const { parts } = (await req.json()) as { parts: R2UploadedPart[] };
        if (!Array.isArray(parts) || !parts.length) return new Response("parts required", { status: 400 });
        const obj = await multipartComplete(bucket, key, uploadId, parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })));
        if (o.maxBytes !== undefined && obj.size > o.maxBytes) { await bucket.delete(key); return new Response("object too large", { status: 413 }); }
        return Response.json({ key: obj.key, size: obj.size, etag: obj.httpEtag });
      }
      if (req.method === "DELETE") { await multipartAbort(bucket, key, uploadId); return new Response(null, { status: 204 }); }
      return new Response("method not allowed", { status: 405 });
    } catch (e) {
      return new Response(String((e as Error).message ?? e), { status: 400 });
    }
  };
}

// ---------------------------------------------------------------- (d) serve objects: range / conditional / headers
export interface ServeOptions {
  /** Default `public, max-age=3600`. Use `private, no-store` for user files. */
  cacheControl?: string;
  /** Force download with this file name (`Content-Disposition: attachment`); `true` = derive from key. `inline` otherwise. */
  download?: string | boolean;
  /** Extra response headers (CORS etc). */
  headers?: Record<string, string>;
}
/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback; control chars and quotes cannot break out of the header. */
export function contentDisposition(kind: "inline" | "attachment", filename?: string): string {
  if (!filename) return kind;
  const clean = filename.replace(/[\r\n\0]/g, "").replace(/[\\/]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["%]/g, "_");
  const star = encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${star}`;
}
/** Single-range parse. `null` = no/ignorable Range header; `"invalid"` = unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // malformed or multi-range: serve the whole thing (allowed by RFC 9110)
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") { const n = Number(b); if (n === 0) return "invalid"; return { start: Math.max(0, size - n), end: size - 1 }; }
  const start = Number(a); const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/** GET/HEAD an R2 object with correct `ETag`, `Accept-Ranges`, 206/416, `If-None-Match`/`If-Modified-Since` (304). 404 when missing. */
export async function serveObject(bucket: R2Bucket, req: Request, key: string, o: ServeOptions = {}): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const head = await bucket.head(key);
  if (!head) return new Response("Not Found", { status: 404 });
  const h = new Headers(o.headers);
  head.writeHttpMetadata(h);
  h.set("etag", head.httpEtag);
  h.set("accept-ranges", "bytes");
  h.set("last-modified", head.uploaded.toUTCString());
  h.set("cache-control", o.cacheControl ?? h.get("cache-control") ?? "public, max-age=3600");
  if (!h.has("content-type")) h.set("content-type", "application/octet-stream");
  h.set("x-content-type-options", "nosniff");
  const fname = typeof o.download === "string" ? o.download : o.download ? key.split("/").pop() : undefined;
  h.set("content-disposition", contentDisposition(o.download ? "attachment" : "inline", fname));

  // conditional GET (RFC 9110 13.2.2: If-None-Match wins over If-Modified-Since)
  const inm = req.headers.get("if-none-match"); const ims = req.headers.get("if-modified-since");
  const fresh = inm !== null
    ? inm.split(",").some((t) => { t = t.trim().replace(/^W\//, ""); return t === "*" || t === head.httpEtag; })
    : ims !== null && Number.isFinite(Date.parse(ims)) && Math.floor(head.uploaded.getTime() / 1000) <= Math.floor(Date.parse(ims) / 1000);
  if (fresh) { h.delete("content-type"); return new Response(null, { status: 304, headers: h }); }

  // If-Range: honour Range only when the validator still matches
  const ir = req.headers.get("if-range");
  const rangeHeader = ir && ir !== head.httpEtag && Date.parse(ir) !== Math.floor(head.uploaded.getTime() / 1000) * 1000 ? null : req.headers.get("range");
  const range = parseRange(rangeHeader, head.size);
  if (range === "invalid") { h.set("content-range", `bytes */${head.size}`); h.delete("content-type"); return new Response(null, { status: 416, headers: h }); }

  if (req.method === "HEAD") { h.set("content-length", String(head.size)); return new Response(null, { status: 200, headers: h }); }
  if (range) {
    const obj = await bucket.get(key, { range: { offset: range.start, length: range.end - range.start + 1 }, onlyIf: { etagMatches: head.etag } });
    if (!obj || !("body" in obj)) return new Response("Precondition Failed", { status: 412 });
    h.set("content-range", `bytes ${range.start}-${range.end}/${head.size}`);
    h.set("content-length", String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  const obj = await bucket.get(key, { onlyIf: { etagMatches: head.etag } });
  if (!obj || !("body" in obj)) return new Response("Precondition Failed", { status: 412 });
  h.set("content-length", String(head.size));
  return new Response(obj.body, { status: 200, headers: h });
}

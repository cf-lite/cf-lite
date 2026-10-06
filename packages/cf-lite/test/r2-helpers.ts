// Test helper (not a test file): in-memory R2 bucket double + Node stand-in for workerd's FixedLengthStream.
interface Obj { size: number; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; bytes: Uint8Array; uploaded: Date }

export function installFixedLengthStream() {
  (globalThis as any).FixedLengthStream ??= class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(len: number) {
      let n = 0;
      super({ transform(c, ctl) { n += c.byteLength; if (n > len) throw new TypeError("too many bytes"); ctl.enqueue(c); }, flush() { if (n !== len) throw new TypeError("too few bytes"); } });
    }
  };
}

const drain = async (b: unknown): Promise<Uint8Array> => new Uint8Array(await new Response(b as BodyInit).arrayBuffer());
const makeObj = (key: string, o: Obj) => ({
  key, size: o.size, etag: "e" + o.size + key, httpEtag: `"e${o.size}${key}"`, uploaded: o.uploaded, customMetadata: o.customMetadata,
  writeHttpMetadata(h: Headers) { if (o.httpMetadata?.contentType) h.set("content-type", o.httpMetadata.contentType); },
});

export function fakeBucket() {
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const s = { partCounts: [] as number[], aborted: 0, deleted: [] as string[] };
  const put = async (key: string, body: unknown, meta?: any) => {
    const bytes = await drain(body);
    const o = { size: bytes.length, customMetadata: meta?.customMetadata, httpMetadata: meta?.httpMetadata, bytes, uploaded: new Date(1_700_000_000_000) };
    objects.set(key, o);
    return makeObj(key, o);
  };
  const resume = (key: string, uploadId: string) => ({
    key, uploadId,
    async uploadPart(n: number, body: unknown) {
      const parts = uploads.get(uploadId); if (!parts) throw new Error("no such upload");
      parts.set(n, await drain(body)); return { partNumber: n, etag: `p${n}` };
    },
    async complete(ps: { partNumber: number }[]) {
      const parts = uploads.get(uploadId); if (!parts) throw new Error("no such upload");
      s.partCounts.push(ps.length);
      const all = ps.map((p) => parts.get(p.partNumber)!);
      const bytes = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let off = 0; for (const a of all) { bytes.set(a, off); off += a.length; }
      return put(key, bytes, { httpMetadata: undefined });
    },
    async abort() { s.aborted++; uploads.delete(uploadId); },
  });
  const bucket = {
    put,
    async createMultipartUpload(key: string, meta?: any) { const id = "u" + uploads.size + 1; uploads.set(id, new Map()); const m = resume(key, id); const c = m.complete; m.complete = async (ps: any) => { const r = await c(ps); const o = objects.get(key)!; o.httpMetadata = meta?.httpMetadata; o.customMetadata = meta?.customMetadata; return r; }; return m; },
    resumeMultipartUpload: resume,
    async head(key: string) { const o = objects.get(key); return o ? makeObj(key, o) : null; },
    async get(key: string, opts?: any) {
      const o = objects.get(key); if (!o) return null;
      const obj = makeObj(key, o);
      if (opts?.onlyIf?.etagMatches && opts.onlyIf.etagMatches !== obj.etag) return obj;
      const r = opts?.range; const bytes = r ? o.bytes.slice(r.offset, r.offset + r.length) : o.bytes;
      return { ...obj, body: new Blob([bytes]).stream() };
    },
    async delete(key: string) { s.deleted.push(key); objects.delete(key); },
    ...s,
  } as any;
  Object.defineProperties(bucket, { partCounts: { get: () => s.partCounts }, aborted: { get: () => s.aborted }, deleted: { get: () => s.deleted } });
  return { bucket: bucket as R2Bucket & typeof s, objects };
}

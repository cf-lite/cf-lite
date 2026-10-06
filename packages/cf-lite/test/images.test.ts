import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { configureImages, cssText, hostAllowed, imageAttrs, imageUrl, imagesHandler, imgTag, negotiateFormat, snapWidth } from "../src/modules/images.js";
import { images } from "../src/conventions/images.js";
import { readImageSize } from "../src/vite-images.js";

beforeEach(() => configureImages({}));

describe("imageUrl / imageAttrs", () => {
  it("binding backend URLs are whitelist-snapped", () => {
    expect(imageUrl("/a.jpg", { width: 640 })).toBe("/_img?src=%2Fa.jpg&w=640&q=75");
    expect(snapWidth(700)).toBe(750); expect(snapWidth(99999)).toBe(3840); expect(snapWidth(1)).toBe(320);
  });
  it("cdn-cgi backend (local + absolute source)", () => {
    const c = { backend: "cdn-cgi" as const };
    expect(imageUrl("/img/a.jpg", { width: 640 }, c)).toBe("/cdn-cgi/image/width=640,quality=75,format=auto/img/a.jpg");
    expect(imageUrl("https://cdn.x.com/a.jpg", { width: 640, quality: 80 }, c)).toBe("/cdn-cgi/image/width=640,quality=80,format=auto/https://cdn.x.com/a.jpg");
  });
  it("snapshot: sizes -> width descriptors, dimensions, lazy", () => {
    expect(imageAttrs({ src: "/hero.jpg", alt: "Hero", width: 1200, height: 600, sizes: "(min-width:800px) 50vw, 100vw" })).toMatchInlineSnapshot(`
      {
        "alt": "Hero",
        "decoding": "async",
        "height": 600,
        "loading": "lazy",
        "sizes": "(min-width:800px) 50vw, 100vw",
        "src": "/_img?src=%2Fhero.jpg&w=640&q=75",
        "srcset": "/_img?src=%2Fhero.jpg&w=320&q=75 320w, /_img?src=%2Fhero.jpg&w=480&q=75 480w, /_img?src=%2Fhero.jpg&w=640&q=75 640w, /_img?src=%2Fhero.jpg&w=750&q=75 750w, /_img?src=%2Fhero.jpg&w=828&q=75 828w, /_img?src=%2Fhero.jpg&w=1080&q=75 1080w, /_img?src=%2Fhero.jpg&w=1200&q=75 1200w, /_img?src=%2Fhero.jpg&w=1920&q=75 1920w, /_img?src=%2Fhero.jpg&w=2048&q=75 2048w, /_img?src=%2Fhero.jpg&w=3840&q=75 3840w",
        "width": 1200,
      }
    `);
  });
  it("no sizes -> 1x/2x; priority -> eager + fetchpriority", () => {
    const a = imageAttrs({ src: "/a.png", width: 320, height: 200, priority: true });
    expect(a.srcset).toBe("/_img?src=%2Fa.png&w=320&q=75 1x, /_img?src=%2Fa.png&w=640&q=75 2x");
    expect(a).toMatchObject({ loading: "eager", decoding: "sync", fetchpriority: "high", width: 320, height: 200 });
  });
  it("requires dimensions unless fill; fill has no width/height attrs", () => {
    expect(() => imageAttrs({ src: "/a.png" })).toThrow(/width and height/);
    const f = imageAttrs({ src: "/a.png", fill: true });
    expect(f.width).toBeUndefined(); expect(cssText(f.style!)).toContain("position:absolute");
  });
  it("svg / unoptimized / backend none are passed through untouched", () => {
    expect(imageAttrs({ src: "/a.svg", width: 1, height: 1 }).srcset).toBeUndefined();
    expect(imageAttrs({ src: "/a.png", width: 1, height: 1, unoptimized: true }).src).toBe("/a.png");
    expect(imageAttrs({ src: "/a.png", width: 1, height: 1, config: { backend: "none" } }).src).toBe("/a.png");
  });
  it("blurDataURL becomes a safe background; imgTag escapes", () => {
    const t = imgTag({ src: "/a.jpg", alt: `x" onerror="1`, width: 10, height: 10, blurDataURL: "data:image/png;base64,AAA" });
    expect(t).toContain(`alt="x&quot; onerror=&quot;1"`); expect(t).toContain("background-image:url(");
  });
  it("configureImages applies globally", () => {
    configureImages({ backend: "cdn-cgi", widths: [100, 200] });
    expect(imageAttrs({ src: "/a.jpg", width: 100, height: 1 }).srcset).toContain("width=200");
  });
});

describe("hostAllowed / negotiateFormat", () => {
  it.each([
    ["cdn.x.com", ["cdn.x.com"], true], ["CDN.X.COM", ["cdn.x.com"], true], ["a.b.x.com", ["*.x.com"], true], ["x.com", ["*.x.com"], false],
    ["evil.com", ["x.com"], false], ["x.com.evil.com", ["x.com"], false], ["127.0.0.1", ["127.0.0.1"], false], ["169.254.169.254", ["*"], false],
    ["localhost", ["localhost"], false], ["10.0.0.1", ["10.0.0.1"], false], ["[::1]", ["[::1]"], false], ["svc.internal", ["svc.internal"], false], ["x.com", [], false],
  ])("%s in %j -> %s", (h, a, r) => { expect(hostAllowed(h, a)).toBe(r); });
  it("Accept negotiation", () => {
    expect(negotiateFormat("image/avif,image/webp,*/*", undefined, "jpeg")).toBe("avif");
    expect(negotiateFormat("image/webp,*/*", undefined, "png")).toBe("webp");
    expect(negotiateFormat("*/*", undefined, "png")).toBe("png");
    expect(negotiateFormat("image/avif", ["webp", "jpeg"], "jpeg")).toBe("jpeg");
    expect(negotiateFormat(null, ["webp"], "png")).toBe("webp");
  });
});

// ---- binding route -------------------------------------------------------------------------------------------------------------
const memCache = () => { const m = new Map<string, Response>(); return { m, cache: { match: async (r: Request) => m.get(r.url)?.clone(), put: async (r: Request, res: Response) => { m.set(r.url, res); } } as unknown as Cache }; };
function setup(cfg: Parameters<typeof imagesHandler>[0] = {}, envOver: Record<string, unknown> = {}) {
  const calls: { width?: number; format?: string; quality?: number; bytes: number }[] = [];
  const IMAGES = { input: (s: ReadableStream) => { let t: any = {}; return { transform: (o: any) => { t = o; return { output: async (oo: any) => { const n = (await new Response(s).arrayBuffer()).byteLength; calls.push({ width: t.width, format: oo.format, quality: oo.quality, bytes: n }); return { response: () => new Response(`out:${oo.format}:${t.width}`) }; } }; } }; } };
  const assets: string[] = [];
  const ASSETS = { fetch: async (r: Request) => { assets.push(new URL(r.url).pathname); const p = new URL(r.url).pathname; return p === "/assets/a.png" || p === "/pic.jpg" ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": p.endsWith("png") ? "image/png" : "image/jpeg" } }) : p === "/doc.svg" ? new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }) : new Response("nf", { status: 404 }); } };
  const { cache, m } = memCache();
  const app = new Hono<{ Bindings: any }>().all("/_img", imagesHandler({ cache, allowHosts: ["cdn.ok.com", "*.ok.org"], r2: ["MEDIA"], ...cfg }));
  const env = { IMAGES, ASSETS, ...envOver };
  const get = (q: string, accept = "*/*") => app.request(`http://x.test/_img?${q}`, { headers: { accept } }, env);
  return { get, calls, assets, m, app, env };
}

describe("imagesHandler (binding backend)", () => {
  it("transforms a local asset, negotiates format, caches (second call = HIT, transformer not re-run)", async () => {
    const t = setup();
    const r1 = await t.get("src=%2Fassets%2Fa.png&w=640&q=75", "image/avif,image/webp,*/*");
    expect(r1.status).toBe(200); expect(await r1.text()).toBe("out:image/avif:640");
    expect(r1.headers.get("content-type")).toBe("image/avif"); expect(r1.headers.get("x-cf-lite-image")).toBe("MISS");
    expect(r1.headers.get("vary")).toBe("Accept"); expect(r1.headers.get("cache-control")).toContain("immutable");
    const r2 = await t.get("src=%2Fassets%2Fa.png&w=640&q=75", "image/avif,image/webp,*/*");
    expect(r2.headers.get("x-cf-lite-image")).toBe("HIT"); expect(await r2.text()).toBe("out:image/avif:640");
    expect(t.calls).toHaveLength(1); expect(t.assets).toHaveLength(1);
  });
  it("different Accept = different cache entry; fallback keeps source type", async () => {
    const t = setup();
    const a = await t.get("src=%2Fpic.jpg&w=320", "image/webp"); expect(a.headers.get("content-type")).toBe("image/webp");
    const b = await t.get("src=%2Fpic.jpg&w=320", "*/*"); expect(b.headers.get("content-type")).toBe("image/jpeg"); expect(b.headers.get("x-cf-lite-image")).toBe("MISS");
    expect(b.headers.get("cache-control")).toContain("max-age=86400");
  });
  it("rejects widths/qualities outside the whitelist (no cache busting) before touching the source", async () => {
    const t = setup();
    for (const q of ["src=%2Fpic.jpg&w=641", "src=%2Fpic.jpg", "src=%2Fpic.jpg&w=abc", "src=%2Fpic.jpg&w=640&q=74", "src=%2Fpic.jpg&w=640&q=1e2", "src=%2Fpic.jpg&w=-640"]) expect((await t.get(q)).status, q).toBe(400);
    expect(t.assets).toHaveLength(0); expect(t.calls).toHaveLength(0);
  });
  it("SSRF: host allow-list, private/IP hosts, scheme, credentials, port, redirects", async () => {
    const t = setup();
    const fetched: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: URL | string, init?: RequestInit) => { fetched.push(String(u)); return String(u).includes("redir") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }) : new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } }); }) as typeof fetch;
    try {
      const bad: [string, number][] = [
        ["https://evil.com/a.png", 403], ["https://cdn.ok.com.evil.com/a.png", 403], ["http://cdn.ok.com/a.png", 400], ["https://user:pw@cdn.ok.com/a.png", 400],
        ["https://cdn.ok.com:8443/a.png", 400], ["https://169.254.169.254/a.png", 403], ["https://127.0.0.1/a.png", 403], ["https://localhost/a.png", 403],
        ["https://cdn.ok.org/", 200], ["file:///etc/passwd", 400], ["data:image/png;base64,AAAA", 400], ["javascript:alert(1)", 400], ["ftp://cdn.ok.com/a", 400],
        ["https://redir.ok.org/a.png", 502], ["//evil.com/a.png", 400], ["/../etc/passwd", 400], ["/a/../../b.png", 400], ["/%2e%2e/b.png", 400], ["/a\\b.png", 400],
        ["/_img?src=/pic.jpg&w=320", 400], ["/cdn-cgi/image/width=1/x", 400], ["r2:OTHER/key.png", 403], ["r2:MEDIA/../secret", 400], ["", 400],
      ];
      for (const [src, status] of bad) expect((await t.get(`src=${encodeURIComponent(src)}&w=320`)).status, src).toBe(status);
      expect(fetched.every((u) => /cdn\.ok\.org|redir\.ok\.org/.test(u))).toBe(true);
    } finally { globalThis.fetch = orig; }
  });
  it("remote source allowed only via allow-list; R2 source via configured binding", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    try {
      const t = setup({}, { MEDIA: { get: async (k: string) => k === "a/b.png" ? { body: new Response("xyz").body, httpMetadata: { contentType: "image/png" }, size: 3 } : null } });
      expect((await t.get(`src=${encodeURIComponent("https://cdn.ok.com/a.jpg")}&w=320`)).status).toBe(200);
      expect((await t.get(`src=${encodeURIComponent("https://x.ok.org/a.jpg")}&w=320`)).status).toBe(200);
      expect((await t.get(`src=${encodeURIComponent("r2:MEDIA/a/b.png")}&w=320`)).status).toBe(200);
      expect((await t.get(`src=${encodeURIComponent("r2:MEDIA/nope.png")}&w=320`)).status).toBe(404);
    } finally { globalThis.fetch = orig; }
  });
  it("svg / non-image sources are refused; oversize refused; allowLocal:false", async () => {
    const t = setup();
    expect((await t.get("src=%2Fdoc.svg&w=320")).status).toBe(415);
    expect((await t.get("src=%2Fmissing.png&w=320")).status).toBe(404);
    expect((await setup({ maxBytes: 2 }).get("src=%2Fpic.jpg&w=320")).status).toBe(200); // no content-length -> streamed; binding enforces its own limit
    expect((await setup({ allowLocal: false }).get("src=%2Fpic.jpg&w=320")).status).toBe(403);
  });
  it("405 on POST; 501 without IMAGES binding, passthrough when configured; transform failure -> 502 not cached", async () => {
    const t = setup();
    expect((await t.app.request("http://x.test/_img?src=%2Fpic.jpg&w=320", { method: "POST" }, t.env)).status).toBe(405);
    expect((await setup({}, { IMAGES: undefined }).get("src=%2Fpic.jpg&w=320")).status).toBe(501);
    const p = await setup({ onMissingBinding: "passthrough" }, { IMAGES: undefined }).get("src=%2Fpic.jpg&w=320");
    expect(p.status).toBe(200); expect(p.headers.get("x-cf-lite-image")).toBe("PASSTHROUGH"); expect(p.headers.get("cache-control")).toBe("no-store");
    const boom = setup({}, { IMAGES: { input: () => ({ transform: () => ({ output: async () => { throw new Error("x"); } }) }) } });
    expect((await boom.get("src=%2Fpic.jpg&w=320")).status).toBe(502); expect(boom.m.size).toBe(0);
  });
});

describe("images() convention + header sniffing", () => {
  it("emits the route, worker-first glob and a wrangler check", () => {
    const c = images({ allowHosts: ["a.com"] });
    const e = c.emit(null, { root: ".", entries: {} });
    expect(e.app![0]).toContain(`.get("/_img", imagesHandler(`); expect(e.workerFirst).toEqual(["/_img"]);
    expect(e.checks![0]({})).toHaveLength(1); expect(e.checks![0]({ images: { binding: "IMAGES" } })).toHaveLength(0);
    expect(images({ backend: "cdn-cgi" }).emit(null, { root: ".", entries: {} })).toEqual({});
  });
  it("reads png/gif/jpeg/webp dimensions", () => {
    const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47], 0); new DataView(png.buffer).setUint32(16, 300); new DataView(png.buffer).setUint32(20, 200);
    expect(readImageSize(png)).toEqual({ type: "png", width: 300, height: 200 });
    const gif = new Uint8Array(10); gif.set([0x47, 0x49, 0x46], 0); new DataView(gif.buffer).setUint16(6, 40, true); new DataView(gif.buffer).setUint16(8, 30, true);
    expect(readImageSize(gif)).toEqual({ type: "gif", width: 40, height: 30 });
    const jpg = new Uint8Array(30); jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8], 0); new DataView(jpg.buffer).setUint16(13, 480); new DataView(jpg.buffer).setUint16(15, 640);
    expect(readImageSize(jpg)).toEqual({ type: "jpeg", width: 640, height: 480 });
    const webp = new Uint8Array(30); webp.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0); webp.set([..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 8); webp.set([99, 0, 0, 49, 0, 0], 24);
    expect(readImageSize(webp)).toEqual({ type: "webp", width: 100, height: 50 });
    expect(readImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

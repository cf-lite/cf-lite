import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { defaultHeaders, mergeHeaders } from "../src/modules/headers-default.js";
import { assetsHeaders, fallbackFace, fontCss, fonts, readWoff2Metrics } from "../src/vite-fonts.js";

/** Minimal valid-enough WOFF2 (head/hhea/OS/2 only, untransformed) so the test needs no font binary and no network. */
function fakeWoff2(m: { upm: number; asc: number; desc: number; gap: number; avg: number }): Uint8Array {
  const head = new Uint8Array(54), hhea = new Uint8Array(36), os2 = new Uint8Array(78);
  new DataView(head.buffer).setUint16(18, m.upm);
  const h = new DataView(hhea.buffer); h.setInt16(4, m.asc); h.setInt16(6, m.desc); h.setInt16(8, m.gap);
  new DataView(os2.buffer).setInt16(2, m.avg);
  const tables: [number, Uint8Array][] = [[1, head], [2, hhea], [6, os2]]; // indexes into the WOFF2 known-tag table
  const dir = tables.flatMap(([idx, t]) => [idx, t.length]); // lengths < 128: single UIntBase128 byte
  const comp = brotliCompressSync(Buffer.concat(tables.map(([, t]) => t)));
  const hdr = new Uint8Array(48);
  const dv = new DataView(hdr.buffer);
  hdr.set([0x77, 0x4f, 0x46, 0x32]); dv.setUint16(12, tables.length); dv.setUint32(20, comp.length);
  return Buffer.concat([hdr, Uint8Array.from(dir), comp]);
}
// Inter-ish numbers
const INTER = { upm: 2048, asc: 1984, desc: -494, gap: 0, avg: 1100 };

function project(extraFiles: Record<string, string | Uint8Array> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cf-fonts-"));
  const pkg = join(root, "node_modules/@fontsource/fixture-sans/files");
  mkdirSync(pkg, { recursive: true });
  for (const w of [400, 700]) writeFileSync(join(pkg, `fixture-sans-latin-${w}-normal.woff2`), fakeWoff2(INTER));
  writeFileSync(join(root, "index.html"), `<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>`);
  writeFileSync(join(root, "main.js"), "console.log(1)");
  for (const [k, v] of Object.entries(extraFiles)) { mkdirSync(join(root, k, ".."), { recursive: true }); writeFileSync(join(root, k), v); }
  return root;
}

describe("woff2 metrics + fallback face", () => {
  it("reads head/hhea/OS2 from a woff2 container", () => {
    expect(readWoff2Metrics(fakeWoff2(INTER))).toEqual({ unitsPerEm: 2048, ascent: 1984, descent: -494, lineGap: 0, xAvgCharWidth: 1100 });
  });
  it("computes size-adjust and overrides against Arial", () => {
    const css = fallbackFace("Fixture Sans", { unitsPerEm: 2048, ascent: 1984, descent: -494, lineGap: 0, xAvgCharWidth: 1100 });
    // 1100/904 = 121.82%; ascent 1984/2048/1.2168 = 79.53%; descent 494/2048/1.2168 = 19.8%
    expect(css).toBe('@font-face{font-family:"Fixture Sans Fallback";src:local("Arial"),local("Liberation Sans"),local("Arimo");size-adjust:121.82%;ascent-override:79.53%;descent-override:19.8%;line-gap-override:0%}');
  });
  it("parses a real (glyf-transformed) OFL font: Be Vietnam Pro", () => {
    const m = readWoff2Metrics(readFileSync(new URL("./fixtures/be-vietnam-pro-400-latin.woff2", import.meta.url)));
    expect(m.unitsPerEm).toBe(1000);
    expect(m.ascent).toBeGreaterThan(800);
    expect(m.descent).toBeLessThan(0);
    expect(m.xAvgCharWidth).toBeGreaterThan(400);
  });
  it("rejects non-woff2 input", () => expect(() => readWoff2Metrics(new Uint8Array(60))).toThrow(/woff2/));
});

describe("fonts() vite build (offline fixture)", () => {
  it("emits hashed woff2, preload links, @font-face with fallback metrics, and default _headers", async () => {
    const root = project({ "public/_headers": "/private/*\n  X-Robots-Tag: noindex\n" });
    await build({ root, logLevel: "silent", configFile: false, plugins: [fonts({ family: "Fixture Sans", weights: [400, 700] }), assetsHeaders()] });
    const files = readdirSync(join(root, "dist/assets/fonts")).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^fixture-sans-latin-400-normal-[0-9a-f]{8}\.woff2$/);
    const html = readFileSync(join(root, "dist/index.html"), "utf8");
    for (const f of files) expect(html).toContain(`<link rel="preload" as="font" type="font/woff2" crossorigin="" href="/assets/fonts/${f}">`);
    expect(html).toContain('font-family:"Fixture Sans";font-style:normal;font-weight:700;font-display:swap;src:url(/assets/fonts/');
    expect(html).toContain("unicode-range:U+0000-00FF");
    expect(html).toContain('font-family:"Fixture Sans Fallback";src:local("Arial"),local("Liberation Sans"),local("Arimo");size-adjust:121.82%');
    expect(html).toContain(':root{--font-fixture-sans:"Fixture Sans","Fixture Sans Fallback",sans-serif}');
    expect(html).not.toMatch(/https?:\/\/fonts\./); // no network font host
    // preload comes before the stylesheet/scripts so the fetch starts early
    expect(html.indexOf("rel=\"preload\"")).toBeLessThan(html.indexOf("<script"));
    expect(readFileSync(join(root, "dist/_headers"), "utf8")).toBe(
      "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n# --- public/_headers ---\n/private/*\n  X-Robots-Tag: noindex\n",
    );
  });
  it("is byte-stable across builds (content-hashed names)", async () => {
    const root = project();
    const run = () => build({ root, logLevel: "silent", configFile: false, plugins: [fonts({ family: "Fixture Sans" })] }).then(() => readdirSync(join(root, "dist/assets/fonts")));
    expect(await run()).toEqual(await run());
  });
  it("local source + custom base + preload:false", async () => {
    const root = project({ "src/brand.woff2": fakeWoff2(INTER) });
    await build({ root, base: "/cdn/", logLevel: "silent", configFile: false, plugins: [fonts({ family: "Brand", source: "local", files: [{ path: "src/brand.woff2", weight: 500 }], preload: false })] });
    const html = readFileSync(join(root, "dist/index.html"), "utf8");
    expect(html).not.toContain("preload");
    expect(html).toMatch(/src:url\(\/cdn\/assets\/fonts\/brand-latin-500-normal-[0-9a-f]{8}\.woff2\)/);
  });
  it("fails clearly when the fontsource package or a weight is missing", async () => {
    const root = project();
    await expect(build({ root, logLevel: "silent", configFile: false, plugins: [fonts({ family: "Nope Sans" })] })).rejects.toThrow(/@fontsource\/nope-sans is not installed/);
    await expect(build({ root, logLevel: "silent", configFile: false, plugins: [fonts({ family: "Fixture Sans", weights: [900] })] })).rejects.toThrow(/fixture-sans-latin-900-normal\.woff2 not found/);
  });
  it("fontCss emits a CSS variable override", () => {
    const buf = Buffer.from(fakeWoff2(INTER));
    const css = fontCss({ family: "A B", variable: "--f", fallback: "serif", fallbackStack: ["Georgia"] }, [{ family: "A B", weight: "400", style: "normal", subset: "latin", buf, file: "x", url: "/x.woff2" }]);
    expect(css).toContain(':root{--f:"A B","A B Fallback",Georgia,serif}');
    expect(css).toContain('src:local("Times New Roman"),local("Liberation Serif")');
  });
});

describe("default _headers", () => {
  it("snapshot", () => {
    expect(defaultHeaders()).toMatchInlineSnapshot(`
      "/assets/*
        Cache-Control: public, max-age=31536000, immutable
      "
    `);
    expect(defaultHeaders({ assetsDir: "/static/", extra: { "/api/*": { "Cache-Control": "no-store" } } })).toBe(
      "/static/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/api/*\n  Cache-Control: no-store\n",
    );
  });
  it("merge keeps defaults first and the user's file verbatim after", () => {
    expect(mergeHeaders("D\n")).toBe("D\n");
    expect(mergeHeaders("D\n", "/x\n  A: b\n\n")).toBe("D\n\n# --- public/_headers ---\n/x\n  A: b\n");
  });
});

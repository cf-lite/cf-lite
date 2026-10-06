/**
 * Build-time image metadata (sharp-free): this plugin rewrites `import hero from "./hero.jpg?meta"` into `{ src, width, height }` read from the file header (PNG, JPEG, GIF, WebP),
 * so `<Image {...hero} />` has intrinsic dimensions with zero runtime cost and no layout shift.
 *
 * Variant generation needs an encoder: none is bundled. Pre-size with your own tool (or use the cdn-cgi/binding backends) and
 * set `backend: "none"` and point `<Image>` at the files. docs/images.md.
 */
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export interface ImageSize { width: number; height: number; type: "png" | "jpeg" | "gif" | "webp" }

/** Read intrinsic dimensions from an image header. Returns null for unknown/truncated data. */
export function readImageSize(b: Uint8Array): ImageSize | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (i: number) => (i < b.length ? b[i] : -1);
  if (b.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return { type: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length >= 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return { type: "gif", width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b.length >= 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const k = String.fromCharCode(...b.slice(12, 16));
    if (k === "VP8X") return { type: "webp", width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (k === "VP8 ") return { type: "webp", width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    if (k === "VP8L") { const v = dv.getUint32(21, true); return { type: "webp", width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "jpeg", height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}

export function imagesPlugin(): Plugin {
  return {
    name: "cf-lite:images",
    enforce: "pre",
    async resolveId(id, importer) {
      if (!/\?meta$/.test(id)) return null;
      const r = await this.resolve(id.replace(/\?meta$/, ""), importer, { skipSelf: true });
      return r ? `\0cf-lite-image-meta:${r.id}` : null;
    },
    async load(id) {
      if (!id.startsWith("\0cf-lite-image-meta:")) return null;
      const file = id.slice("\0cf-lite-image-meta:".length);
      const size = readImageSize(readFileSync(file));
      if (!size) this.error(`cf-lite/images: cannot read dimensions of ${file} (supported: png, jpeg, gif, webp)`);
      this.addWatchFile(file);
      return `import src from ${JSON.stringify(file)};\nexport default { src, width: ${size.width}, height: ${size.height} };`;
    },
  };
}

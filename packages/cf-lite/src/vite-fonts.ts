/**
 * Build-time self-hosted fonts (the `next/font` equivalent) and the default `_headers` writer.
 *
 *   fonts({ family: "Inter", weights: [400, 700], subsets: ["latin"] })      // reads node_modules/@fontsource/inter, offline
 *   fonts({ family: "Brand", source: "local", files: [{ path: "src/brand.woff2", weight: 400 }] })
 *
 * Emits content-hashed `woff2` under `<assetsDir>/fonts/` (immutable via the default `_headers`), injects `<link rel=preload as=font crossorigin>`
 * plus an inline `<style>` with `@font-face` (per-subset `unicode-range`) and a metric-adjusted fallback face (`size-adjust` / `ascent-override` /
 * `descent-override` / `line-gap-override`, computed from the font's own `head`/`hhea`/`OS/2` tables) so the swap causes no layout shift.
 * CSS: `font-family: var(--font-inter)` (or the family name + " Fallback"). No network access at build or runtime.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import type { HtmlTagDescriptor, Plugin } from "vite";
import { defaultHeaders, mergeHeaders, type DefaultHeadersOptions } from "./modules/headers-default.js";

export interface FontOptions {
  family: string;
  /** "fontsource" (default): `@fontsource/<id>` installed in node_modules. "fontsource-variable": `@fontsource-variable/<id>`. "local": `files`. */
  source?: "fontsource" | "fontsource-variable" | "local";
  weights?: (number | string)[];
  styles?: ("normal" | "italic")[];
  subsets?: string[];
  /** `font-display` (default "swap"). */
  display?: "auto" | "block" | "swap" | "fallback" | "optional";
  /** Preload the first subset's files (default true). */
  preload?: boolean;
  /** Generic family of the system fallback (default "sans-serif"); picks Arial / Times New Roman / Courier New as the metric base. */
  fallback?: "sans-serif" | "serif" | "monospace";
  /** Extra families appended after the fallback in the CSS variable. */
  fallbackStack?: string[];
  /** source "local": woff2 files, relative to the project root. */
  files?: { path: string; weight?: number | string; style?: "normal" | "italic"; subset?: string }[];
  /** CSS variable name (default `--font-<id>`). */
  variable?: string;
}

export interface FontMetrics { unitsPerEm: number; ascent: number; descent: number; lineGap: number; xAvgCharWidth: number }

const WOFF2_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt_ fpgm glyf loca prep CFF_ VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG_ sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
  .split(" ").map((t) => t.replace("_", " "));

/** Read the vertical metrics + average width out of a WOFF2 file (only head/hhea/OS/2 are needed and none of them is transformed). */
export function readWoff2Metrics(buf: Uint8Array): FontMetrics {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const str = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (str(0) !== "wOF2") throw new Error("not a woff2 file");
  const numTables = dv.getUint16(12);
  let p = 48;
  const b128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const c = buf[p++]; v = v * 128 + (c & 0x7f); if (!(c & 0x80)) return v; } throw new Error("bad UIntBase128"); };
  const tables = new Map<string, { off: number; len: number }>();
  const transformedTags = new Set<string>();
  let off = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    const idx = flags & 63;
    let tag: string;
    if (idx === 63) { tag = str(p); p += 4; } else tag = WOFF2_TAGS[idx];
    const orig = b128();
    const ver = flags >> 6;
    const transformed = tag === "glyf" || tag === "loca" ? ver === 0 : ver !== 0;
    const len = transformed ? b128() : orig;
    if (transformed) transformedTags.add(tag);
    tables.set(tag, { off, len });
    off += len;
  }
  const raw = brotliDecompressSync(buf.subarray(p, p + dv.getUint32(20)));
  const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const map = new Map<string, number>();
  for (const [tag, e] of tables) map.set(tag, e.off);
  // hmtx is only readable when it was not transformed (rare); glyf/loca transforms are irrelevant here
  const hmtxOk = tables.has("hmtx") && tables.get("hmtx")!.len > 0 && !transformedTags.has("hmtx");
  return sfntMetrics(data, map, hmtxOk);
}

/** English letter + space frequencies (Capsize's weighting), so the average width reflects running text, not every glyph in the font. */
const FREQ: Record<string, number> = { " ": 0.1818, a: 0.0668, b: 0.0122, c: 0.0228, d: 0.0348, e: 0.1039, f: 0.0182, g: 0.0165, h: 0.0499, i: 0.0573, j: 0.0009, k: 0.0059, l: 0.0336, m: 0.0203, n: 0.0563, o: 0.0639, p: 0.0159, q: 0.0008, r: 0.0497, s: 0.0526, t: 0.0752, u: 0.0228, v: 0.0081, w: 0.017, x: 0.0015, y: 0.0143, z: 0.0006 };

function glyphIds(d: DataView, cmap: number): Map<number, number> | null {
  const n = d.getUint16(cmap + 2);
  let sub = -1;
  for (let i = 0; i < n; i++) {
    const plat = d.getUint16(cmap + 4 + i * 8), enc = d.getUint16(cmap + 6 + i * 8), off = d.getUint32(cmap + 8 + i * 8);
    if ((plat === 3 && enc === 1) || (plat === 0 && sub < 0)) sub = cmap + off;
  }
  if (sub < 0 || d.getUint16(sub) !== 4) return null;
  const segX2 = d.getUint16(sub + 6), end = sub + 14, start = end + segX2 + 2, delta = start + segX2, range = delta + segX2;
  const out = new Map<number, number>();
  for (const ch of Object.keys(FREQ)) {
    const c = ch.charCodeAt(0);
    for (let i = 0; i < segX2; i += 2) {
      if (c > d.getUint16(end + i)) continue;
      if (c < d.getUint16(start + i)) break;
      const ro = d.getUint16(range + i);
      let g = ro === 0 ? c : d.getUint16(range + i + ro + (c - d.getUint16(start + i)) * 2);
      if (g !== 0 || ro === 0) g = (g + d.getInt16(delta + i)) & 0xffff;
      out.set(c, g);
      break;
    }
  }
  return out;
}

/** Metrics from sfnt tables (`offsets`: tag -> offset into `d`); exported for calibrating the system-font table. */
export function sfntMetrics(d: DataView, offsets: Map<string, number>, hmtxOk = true): FontMetrics {
  const need = (t: string) => { const o = offsets.get(t); if (o === undefined) throw new Error(`font has no ${t} table`); return o; };
  const head = need("head"), hhea = need("hhea"), os2 = need("OS/2");
  const typo = (d.getUint16(os2 + 62) & 128) !== 0; // USE_TYPO_METRICS
  let avg = d.getInt16(os2 + 2);
  try {
    const cm = offsets.get("cmap"), hm = offsets.get("hmtx");
    const ids = cm !== undefined && hm !== undefined && hmtxOk ? glyphIds(d, cm) : null;
    if (ids) {
      const nh = d.getUint16(hhea + 34);
      let sum = 0, w = 0;
      for (const [c, g] of ids) {
        if (g === 0) continue;
        sum += d.getUint16(hm! + Math.min(g, nh - 1) * 4) * FREQ[String.fromCharCode(c)];
        w += FREQ[String.fromCharCode(c)];
      }
      if (w > 0.9) avg = Math.round(sum / w);
    }
  } catch { /* keep xAvgCharWidth */ }
  return {
    unitsPerEm: d.getUint16(head + 18),
    ascent: typo ? d.getInt16(os2 + 68) : d.getInt16(hhea + 4),
    descent: typo ? d.getInt16(os2 + 70) : d.getInt16(hhea + 6),
    lineGap: typo ? d.getInt16(os2 + 72) : d.getInt16(hhea + 8),
    xAvgCharWidth: avg,
  };
}

/** Metrics of the metric-compatible Liberation fonts measured with `sfntMetrics` (same weighting as web fonts get), i.e. of Arial / Times New Roman / Courier New. */
const SYSTEM: Record<NonNullable<FontOptions["fallback"]>, { local: string[]; m: FontMetrics }> = {
  "sans-serif": { local: ["Arial", "Liberation Sans", "Arimo"], m: { unitsPerEm: 2048, ascent: 1854, descent: -434, lineGap: 67, xAvgCharWidth: 903 } },
  serif: { local: ["Times New Roman", "Liberation Serif", "Tinos"], m: { unitsPerEm: 2048, ascent: 1825, descent: -443, lineGap: 87, xAvgCharWidth: 817 } },
  monospace: { local: ["Courier New", "Liberation Mono", "Cousine"], m: { unitsPerEm: 2048, ascent: 1705, descent: -615, lineGap: 0, xAvgCharWidth: 1229 } },
};

const pct = (n: number) => `${(n * 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** `@font-face` for a local system font rescaled to the web font's metrics. */
export function fallbackFace(family: string, m: FontMetrics, generic: NonNullable<FontOptions["fallback"]> = "sans-serif"): string {
  const sys = SYSTEM[generic];
  const size = m.xAvgCharWidth / m.unitsPerEm / (sys.m.xAvgCharWidth / sys.m.unitsPerEm);
  const rel = (v: number) => pct(Math.abs(v) / m.unitsPerEm / size);
  return `@font-face{font-family:"${family} Fallback";src:${sys.local.map((l) => `local("${l}")`).join(",")};size-adjust:${pct(size)};ascent-override:${rel(m.ascent)};descent-override:${rel(m.descent)};line-gap-override:${rel(m.lineGap)}}`;
}

const RANGES: Record<string, string> = {
  latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  vietnamese: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
  cyrillic: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116",
  "cyrillic-ext": "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F",
  greek: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF",
  "greek-ext": "U+1F00-1FFF",
};

interface Face { family: string; weight: string; style: string; subset: string; buf: Buffer; file: string; url: string }

const idOf = (family: string) => family.trim().toLowerCase().replace(/\s+/g, "-");

function findPackage(root: string, pkg: string): string {
  for (let d = resolve(root); ; d = dirname(d)) {
    const p = join(d, "node_modules", pkg);
    if (existsSync(p)) return p;
    if (dirname(d) === d) throw new Error(`cf-lite fonts: ${pkg} is not installed (run: bun add -d ${pkg}) - fonts are read from node_modules at build time, never fetched from the network`);
  }
}

function loadFaces(o: FontOptions, root: string, dir: string, base: string): Face[] {
  const source = o.source ?? "fontsource";
  const make = (buf: Buffer, weight: string, style: string, subset: string): Face => {
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 8);
    const file = `${dir}/fonts/${idOf(o.family)}-${subset}-${weight}-${style}-${hash}.woff2`;
    return { family: o.family, weight, style, subset, buf, file, url: base + file };
  };
  if (source === "local") {
    if (!o.files?.length) throw new Error(`cf-lite fonts: ${o.family}: source "local" needs files`);
    return o.files.map((f) => make(readFileSync(resolve(root, f.path)), String(f.weight ?? 400), f.style ?? "normal", f.subset ?? "latin"));
  }
  const id = idOf(o.family), variable = source === "fontsource-variable";
  const pkg = findPackage(root, `${variable ? "@fontsource-variable" : "@fontsource"}/${id}`);
  const weights = variable ? ["wght"] : (o.weights ?? [400]).map(String);
  const faces: Face[] = [];
  for (const subset of o.subsets ?? ["latin"]) for (const style of o.styles ?? ["normal"]) for (const w of weights) {
    const f = join(pkg, "files", `${id}-${subset}-${w}-${style}.woff2`);
    if (!existsSync(f)) throw new Error(`cf-lite fonts: ${o.family}: ${basename(f)} not found in ${pkg}/files (check weights/subsets/styles)`);
    faces.push(make(readFileSync(f), variable ? "100 900" : w, style, subset));
  }
  return faces;
}

export function fontCss(o: FontOptions, faces: Face[]): string {
  const display = o.display ?? "swap";
  const css = faces.map((f) => `@font-face{font-family:"${f.family}";font-style:${f.style};font-weight:${f.weight};font-display:${display};src:url(${f.url}) format("woff2");${RANGES[f.subset] ? `unicode-range:${RANGES[f.subset]}` : ""}}`.replace(/;}$/, "}"));
  const generic = o.fallback ?? "sans-serif";
  css.push(fallbackFace(o.family, readWoff2Metrics(faces[0].buf), generic));
  const stack = [`"${o.family}"`, `"${o.family} Fallback"`, ...(o.fallbackStack ?? []), generic].join(",");
  css.push(`:root{${o.variable ?? `--font-${idOf(o.family)}`}:${stack}}`);
  return css.join("\n");
}

/** Vite plugin: one per family (pass several `fonts()` entries in `plugins`). */
export function fonts(o: FontOptions): Plugin {
  let faces: Face[] = [];
  let css = "";
  let client = true;
  return {
    name: `cf-lite:fonts:${idOf(o.family)}`,
    configResolved(c) {
      const dir = c.build.assetsDir.replace(/^\/+|\/+$/g, "");
      const base = c.base === "./" || c.base === "" ? "/" : c.base.replace(/\/?$/, "/");
      faces = loadFaces(o, c.root, dir, base);
      css = fontCss(o, faces);
      client = true;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = faces.find((x) => req.url?.split("?")[0] === x.url);
        if (!f) return next();
        res.setHeader("Content-Type", "font/woff2");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(f.buf);
      });
    },
    generateBundle() {
      if (this.environment && this.environment.name !== "client") return;
      for (const f of faces) this.emitFile({ type: "asset", fileName: f.file, source: f.buf });
    },
    transformIndexHtml() {
      const tags: HtmlTagDescriptor[] = [];
      if (o.preload !== false) {
        const first = faces[0].subset;
        for (const f of faces.filter((x) => x.subset === first))
          tags.push({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: f.url }, injectTo: "head-prepend" });
      }
      tags.push({ tag: "style", attrs: { "data-cf-font": idOf(o.family) }, children: css, injectTo: "head-prepend" });
      return tags;
    },
  };
}

export interface AssetsHeadersOptions extends DefaultHeadersOptions { /** Set false to skip writing `_headers`. */ enabled?: boolean }

/**
 * Writes the default `_headers` into the client build output, followed by the project's own `public/_headers` (if any).
 * Wired into `cfLite()` (option `headers`); a no-op for the Worker environment.
 */
export function assetsHeaders(o: AssetsHeadersOptions = {}): Plugin {
  let root = "", publicDir = "", assetsDir = "assets";
  return {
    name: "cf-lite:default-headers",
    apply: "build",
    configResolved(c) { root = c.root; publicDir = c.publicDir; assetsDir = c.build.assetsDir; },
    writeBundle: {
      order: "post",
      handler(opts) {
        if (o.enabled === false || (this.environment && this.environment.name !== "client")) return;
        const out = opts.dir ?? resolve(root, this.environment?.config.build.outDir ?? "dist");
        const userFile = publicDir ? join(publicDir, "_headers") : "";
        const user = userFile && existsSync(userFile) ? readFileSync(userFile, "utf8") : undefined;
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "_headers"), mergeHeaders(defaultHeaders({ assetsDir, ...o }), user));
      },
    },
  };
}

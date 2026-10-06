/**
 * cf-lite OG renderer Worker. `POST /render` with `{ tree, width, height, fonts: [{ name, url, weight?, style? }] }` -> `image/png`.
 * `tree` is the plain element tree produced by `serializeOg()` (cf-lite/modules/og); satori lays it out to SVG, resvg-wasm rasterises it.
 * Output is deterministic for a fixed input (no timestamps, fixed fonts) so the PNG hash is stable. Fonts are fetched once per isolate.
 */
// @ts-expect-error wasm module import (wrangler bundles it as a WebAssembly.Module)
import yogaWasm from "satori/yoga.wasm";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error wasm module import
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";

interface FontSpec { name: string; url: string; weight?: number; style?: "normal" | "italic" }
interface Job { tree: unknown; width?: number; height?: number; fonts: FontSpec[] }

// harfbuzzjs (inside satori) is an Emscripten module that reads `self.location.href` when it sees `WorkerGlobalScope`; workerd has no location.
const g = globalThis as { location?: { href: string } };
if (!g.location) g.location = { href: "file:///og-worker/index.js" };
(globalThis as { __dirname?: string }).__dirname ??= "/og-worker"; // Emscripten's Node branch (workerd exposes process.versions.node)

type Satori = typeof import("satori/standalone");
let ready: Promise<Satori["default"]> | undefined;
const init = () => (ready ??= (async () => {
  const s: Satori = await import("satori/standalone");
  await Promise.all([s.init(yogaWasm), initWasm(resvgWasm)]);
  return s.default;
})());
const fontCache = new Map<string, Promise<ArrayBuffer>>();
const loadFont = (url: string) => {
  let p = fontCache.get(url);
  if (!p) fontCache.set(url, (p = fetch(url).then((r) => { if (!r.ok) throw new Error(`font ${url}: ${r.status}`); return r.arrayBuffer(); }).catch((e) => { fontCache.delete(url); throw e; })));
  return p;
};

export default {
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST" || pathname !== "/render") return new Response("POST /render", { status: 404 });
    let job: Job;
    try { job = (await req.json()) as Job; } catch { return new Response("bad json", { status: 400 }); }
    if (!job.tree || !Array.isArray(job.fonts) || !job.fonts.length) return new Response("tree and at least one font are required", { status: 400 });
    const width = Math.min(job.width ?? 1200, 4096), height = Math.min(job.height ?? 630, 4096);
    try {
      const satori = await init();
      const fonts = await Promise.all(job.fonts.map(async (f) => ({ name: f.name, data: await loadFont(f.url), weight: (f.weight ?? 400) as 400, style: f.style ?? "normal" })));
      const svg = await satori(job.tree as never, { width, height, fonts });
      const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
      return new Response(png, { headers: { "content-type": "image/png" } });
    } catch (e) {
      return new Response("render failed: " + (e as Error).message, { status: 500 });
    }
  },
} satisfies ExportedHandler;

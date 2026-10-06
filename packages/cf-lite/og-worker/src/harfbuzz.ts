/**
 * Replacement for `harfbuzzjs` (wrangler.jsonc `alias`). Stock harfbuzzjs cannot run in Workers for two reasons, both fixed here:
 * the main wasm is instantiated from the bundled CompiledWasm module (no runtime compile), and Emscripten's `addFunction` builds tiny
 * trampolines with `new WebAssembly.Module(bytes)` (code generation is disallowed) - those bytes are precompiled (src/fn-sigs) and served
 * through a `WebAssembly.Module` shim. Regenerate with scripts/gen-fn-sigs.mjs.
 */
// @ts-expect-error CJS without types
import hbjs from "../../../../node_modules/harfbuzzjs/hbjs.js";
// @ts-expect-error CJS without types
import createHarfBuzz from "../../../../node_modules/harfbuzzjs/hb.js";
// @ts-expect-error wasm module import
import hbWasm from "../../../../node_modules/harfbuzzjs/hb.wasm";
// @ts-expect-error wasm module import
import s_vi from "./fn-sigs/vi.wasm";
// @ts-expect-error wasm module import
import s_viiiffi from "./fn-sigs/viiiffi.wasm";
// @ts-expect-error wasm module import
import s_viiiffffffi from "./fn-sigs/viiiffffffi.wasm";
// @ts-expect-error wasm module import
import s_viiiffffi from "./fn-sigs/viiiffffi.wasm";
// @ts-expect-error wasm module import
import s_viiii from "./fn-sigs/viiii.wasm";
// @ts-expect-error wasm module import
import s_iiiii from "./fn-sigs/iiiii.wasm";

const SIGS: Record<string, WebAssembly.Module> = { "vi": s_vi, "viiiffi": s_viiiffi, "viiiffffffi": s_viiiffffffi, "viiiffffi": s_viiiffffi, "viiii": s_viiii, "iiiii": s_iiiii };
const codes: Record<string, number> = { i: 127, p: 127, j: 126, f: 125, d: 124 };
const uleb = (a: number[]) => [a.length % 128 | 128, a.length >> 7, ...a];
const pack = (t: string) => uleb(Array.from(t, (c) => codes[c]));
const bytesFor = (sig: string) => Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...uleb([1, 96, ...pack(sig.slice(1)), ...pack(sig[0] === "v" ? "" : sig[0])]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
const byKey = new Map(Object.keys(SIGS).map((s) => [bytesFor(s).join(","), SIGS[s]]));

const RealModule = WebAssembly.Module;
(WebAssembly as { Module: unknown }).Module = new Proxy(RealModule, {
  construct(target, args) {
    const pre = args[0] instanceof Uint8Array ? byKey.get(args[0].join(",")) : undefined;
    return pre ?? Reflect.construct(target, args);
  },
});

export default createHarfBuzz({
  instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) {
    WebAssembly.instantiate(hbWasm, imports).then(done);
    return {};
  },
}).then(hbjs);

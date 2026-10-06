// Regenerates src/fn-sigs/*.wasm: the tiny JS->wasm trampolines Emscripten (harfbuzzjs) builds at runtime with `new WebAssembly.Module(bytes)`,
// which Workers forbid. Byte layout is identical to Emscripten's convertJsFunctionToWasm; see src/harfbuzz.ts.
import { writeFileSync } from "node:fs";
export const SIGS = ["vi", "viiiffi", "viiiffffffi", "viiiffffi", "viiii", "iiiii"];
export const wasmFor = (sig) => {
  const codes = { i: 127, p: 127, j: 126, f: 125, d: 124 };
  const uleb = (a) => [a.length % 128 | 128, a.length >> 7, ...a];
  const pack = (t) => uleb(Array.from(t, (c) => codes[c]));
  return Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...uleb([1, 96, ...pack(sig.slice(1)), ...pack(sig[0] === "v" ? "" : sig[0])]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
};
if (import.meta.url === `file://${process.argv[1]}`) for (const s of SIGS) writeFileSync(new URL(`../src/fn-sigs/${s}.wasm`, import.meta.url), wasmFor(s));

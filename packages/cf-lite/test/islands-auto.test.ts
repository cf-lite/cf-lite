import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCandidates, discoverIslands, islandTransform, wrapExports, type IslandEntry } from "../src/vite-islands.js";
import type { UiAdapter } from "../src/adapter.js";
import { detectIslands } from "../../react/src/detect.js";

const W = "@x/wrap";
const entries = (...e: Array<[string, string?]>): IslandEntry[] => e.map(([x, id]) => ({ export: x, id: id ?? (x === "default" ? "a/B" : `a/B#${x}`), strategy: "visible" }));
const w = (code: string, e: IslandEntry[]) => wrapExports(code, "a/B.tsx", e, W);

describe("wrapExports", () => {
  it("export default function: keeps the declaration, exports the wrapper", () => {
    const out = w("export default function B() { return <i />; }", entries(["default"]));
    expect(out).toContain('import { island as __cflWrap } from "@x/wrap"');
    expect(out).toContain("function B() { return <i />; }");
    expect(out).not.toMatch(/export default function/);
    expect(out).toContain('const __cflW_default = __cflWrap(B, "a/B", "visible", true);');
    expect(out).toContain("export default __cflW_default;");
  });
  it("export default Identifier / expression", () => {
    expect(w("function B() { return <i />; }\nexport default B;", entries(["default"]))).toContain("__cflWrap(B,");
    const e = w("export default () => <i />;", entries(["default"]));
    expect(e).toContain("const __cflInner = () => <i />;");
    expect(e).toContain("__cflWrap(__cflInner,");
  });
  it("named function / const; siblings stay exported untouched", () => {
    const out = w("export function A() { return <a />; }\nexport const Btn = () => <b />, Other = 1;\nexport function Plain() { return <p />; }", entries(["Btn"]));
    expect(out).toContain('const __cflW_Btn = __cflWrap(Btn, "a/B#Btn", "visible", true);');
    expect(out).toContain("export { __cflW_Btn as Btn };");
    expect(out).toContain("export { Other };");
    expect(out).toContain("export function A()"); // not a target: left alone
  });
  it("export lists, renames and strings", () => {
    const out = w("function H() { return <h />; }\nfunction P() { return <p />; }\nexport { H as Renamed, P };", entries(["Renamed", "a/B#Renamed"]));
    expect(out).toContain('__cflWrap(H, "a/B#Renamed"');
    expect(out).toContain('export { __cflW_Renamed as "Renamed" };');
    expect(out).toContain('export { P as "P" };');
  });
  it("rejects an unknown strategy", () => {
    expect(() => wrapExports("export default function B() { return null; }", "a.tsx", [{ export: "default", id: "a", strategy: "never" as never }], W)).toThrow(/strategy/);
  });
});

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cfl-auto-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), c); }
  return root;
}
const adapter = (auto: object | undefined): UiAdapter => ({ id: "t", extensions: [".tsx"], client: "c", server: "s", islands: { wrap: W, mount: "m", detect: (s, f) => detectIslands(s, f), ...(auto ? { auto } : {}) }, vite: () => ({ plugins: [] }) });
const INTERACTIVE = `import { useState } from "react";\nexport default function C() { const [n, set] = useState(0); return <button onClick={() => set(n + 1)}>{n}</button>; }`;

describe("discoverIslands (auto)", () => {
  const root = project({
    "app/components/Counter.tsx": INTERACTIVE,
    "app/components/Static.tsx": "export default function S() { return <p />; }",
    "app/components/Box.tsx": `export function Box({ children }) { const [a] = useState(0); return <div>{a}{children}</div>; }`,
    "app/components/Optout.tsx": INTERACTIVE + "\nexport const island = false;",
    "app/components/Strat.tsx": INTERACTIVE + `\nexport const client = "idle";`,
    "app/routes/index.tsx": INTERACTIVE,
    "app/routes/_layout.tsx": INTERACTIVE,
    "app/islands/Marked.island.tsx": INTERACTIVE,
    "app/components/Counter.test.tsx": INTERACTIVE,
    "test/x.tsx": INTERACTIVE,
    "src/vendor/Skip.tsx": INTERACTIVE,
    "node_modules/pkg/i.tsx": INTERACTIVE,
  });
  it("off by default: marker files only", () => {
    expect(discoverIslands(root, adapter(undefined)).map((s) => s.file.slice(root.length + 1))).toEqual(["app/islands/Marked.island.tsx"]);
  });
  it("finds interactive components outside routes/tests; opt-out, children and strategy", () => {
    const warn = vi.fn();
    const specs = discoverIslands(root, adapter({}), warn);
    const rows = specs.flatMap((s) => s.entries.map((e) => `${s.file.slice(root.length + 1)}|${e.id}|${e.strategy ?? "(file)"}`));
    expect(rows.sort()).toEqual([
      "app/components/Counter.tsx|app/components/Counter|visible",
      "app/components/Strat.tsx|app/components/Strat|idle",
      "app/islands/Marked.island.tsx|app/islands/Marked|(file)",
      "src/vendor/Skip.tsx|src/vendor/Skip|visible",
    ].sort());
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Box\.tsx#Box: interactive but not an island: takes `children`/));
  });
  it("`exclude` and `client` options", () => {
    const rows = discoverIslands(root, adapter({ exclude: ["src/vendor"], client: "idle" })).flatMap((s) => s.entries.map((e) => `${e.id}|${e.strategy}`));
    expect(rows).toContain("app/components/Counter|visible"); // detect proposes "visible" itself; `client` is only the fallback when a candidate has no strategy
    expect(rows.join()).not.toContain("Skip");
  });
  it("autoCandidates skips routes, tests, node_modules, dot dirs", () => {
    expect(autoCandidates(root).map((f) => f.slice(root.length + 1))).toEqual(["app/components/Box.tsx", "app/components/Counter.tsx", "app/components/Optout.tsx", "app/components/Static.tsx", "app/components/Strat.tsx", "src/vendor/Skip.tsx"]);
  });
  it("an adapter without detect ignores auto", () => {
    const a = adapter({}); delete a.islands!.detect;
    expect(discoverIslands(root, a).length).toBe(1);
  });
  it("a detect that throws is reported, not fatal", () => {
    const a = adapter({}); a.islands!.detect = () => { throw new Error("boom"); };
    const warn = vi.fn();
    expect(discoverIslands(root, a, warn).length).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/detection failed \(boom\)/));
  });
  it("islandTransform wraps auto modules by path and leaves other files alone", () => {
    const a = adapter({});
    const specs = discoverIslands(root, a);
    const t = (islandTransform(root, a, specs) as any).transform;
    const file = join(root, "app/components/Counter.tsx");
    expect(t(INTERACTIVE, file)!.code).toContain("__cflWrap(C, \"app/components/Counter\", \"visible\", true)");
    expect(t(INTERACTIVE, join(root, "app/components/Static.tsx"))).toBeNull();
    expect(t(INTERACTIVE, join(root, "app/routes/index.tsx"))).toBeNull();
  });
});

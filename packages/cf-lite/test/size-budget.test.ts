import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper shared with scripts/size-budget.mjs
import { baselineBytes, moduleBytes, moduleNames, unusedBytes } from "../../../scripts/size-budget-lib.mjs";

// Needs `bun run build` first (bun run test does it). Proves the "opt-in, 0 bytes if unused" promise (roadmap principle 4).
describe("tree-shaking", () => {
  const mods: string[] = moduleNames();
  it("finds the module entries", () => expect(mods.length).toBeGreaterThan(30));
  it("an imported-but-unused cf-lite/modules/* entry adds 0 bytes to a Worker", async () => {
    const base: number = await baselineBytes();
    const extra: Record<string, number> = {};
    for (const m of mods) { const n: number = await unusedBytes(m); if (n !== base) extra[m] = n - base; }
    expect(extra).toEqual({});
  }, 60_000);
  it("sanity: using a module does cost bytes", async () => {
    expect(await moduleBytes("session")).toBeGreaterThan((await baselineBytes()) + 500);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8"));
const ex = read("examples/site-rsc/package.json").dependencies as Record<string, string>;
const cf = read("packages/cf-lite/package.json");
const ver = (v: string) => v.split(".").map(Number) as [number, number, number];
const gte = (a: string, b: string) => { const x = ver(a), y = ver(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

// docs/design/rsc.md "Upgrade policy": exact pins, follow vinext 1.0.0 (plugin-rsc ^0.5.34, react ^19.2.6), never below the patched floor.
describe("RSC dependency pins (docs/design/rsc.md)", () => {
  const PINNED = ["@vitejs/plugin-rsc", "react", "react-dom", "react-server-dom-webpack", "rsc-html-stream"];
  it("are exact (no ^ ~ ranges) in the example and as optional peers of cf-lite", () => {
    for (const k of PINNED) {
      expect(ex[k], k).toMatch(/^\d+\.\d+\.\d+$/);
      if (k !== "react" && k !== "react-dom") {
        expect(cf.peerDependencies[k], k).toBe(ex[k]);
        expect(cf.peerDependenciesMeta[k]).toEqual({ optional: true });
      }
    }
  });
  it("keep react, react-dom and react-server-dom-webpack on one version, inside vinext's ranges", () => {
    expect(ex["react-dom"]).toBe(ex.react);
    expect(ex["react-server-dom-webpack"]).toBe(ex.react);
    expect(gte(ex.react, "19.2.6")).toBeGreaterThanOrEqual(0); // vinext peer ^19.2.6
    expect(ver(ex.react)[0]).toBe(19);
    expect(ver(ex["@vitejs/plugin-rsc"]).slice(0, 2)).toEqual([0, 5]); // vinext peer ^0.5.34
    expect(gte(ex["@vitejs/plugin-rsc"], "0.5.34")).toBeGreaterThanOrEqual(0);
  });
  it("are at or above the last patched versions of every known RSC/Flight advisory", () => {
    // react-server-dom-*: 19.2.x >= 19.2.8 (CVE-2026-44907); a 19.3+ release postdates it. plugin-rsc >= 0.5.26 (GHSA-w94c-4vhp-22gx).
    const [maj, min] = ver(ex.react);
    expect(maj * 1000 + min >= 19003 || gte(ex.react, "19.2.8") >= 0).toBe(true);
    expect(gte(ex["@vitejs/plugin-rsc"], "0.5.26")).toBeGreaterThanOrEqual(0);
  });
  it("core cf-lite never depends on the Optimizely SDK or on RSC packages (opt-in only)", () => {
    const all = JSON.stringify({ ...cf.dependencies, ...cf.devDependencies });
    expect(all).not.toMatch(/optimizely|plugin-rsc|react-server-dom/);
  });
});

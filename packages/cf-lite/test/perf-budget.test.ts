import { describe, expect, it } from "vitest";
import { compare, deployedUrl, limitFor, liveSafe, median, percentile, tempWorkerName } from "../../../scripts/perf-budget-lib.mjs";

const budgets = { rules: { buildSeconds: { pct: 50, abs: 2 }, workerGzipBytes: { pct: 5, abs: 256 } }, examples: { demo: { buildSeconds: 4, workerGzipBytes: 1000 } } };

describe("perf budget gate", () => {
  it("median / percentile", () => {
    expect(median([3, 1, 2])).toBe(2); expect(median([4, 1, 2, 3])).toBe(2.5); expect(median([])).toBeNaN();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(6); expect(percentile([5], 99)).toBe(5);
  });
  it("limit = baseline * (1 + pct) + abs", () => expect(limitFor({ pct: 50, abs: 2 }, 4)).toBe(8));
  it("passes within budget, fails above it", () => {
    expect(compare({ demo: { buildSeconds: 8, workerGzipBytes: 1306 } }, budgets).every((r) => r.ok)).toBe(true);
    const rows = compare({ demo: { buildSeconds: 8.1, workerGzipBytes: 1307 } }, budgets);
    expect(rows.map((r) => r.ok)).toEqual([false, false]);
  });
  it("a missing baseline or an unmeasured (NaN) metric is a failure; unruled metrics are informational", () => {
    expect(compare({ other: { buildSeconds: 1 } }, budgets)[0]).toMatchObject({ ok: false, why: "no baseline (run --update)" });
    expect(compare({ demo: { buildSeconds: NaN } }, budgets)[0]).toMatchObject({ ok: false, why: "not measured" });
    expect(compare({ demo: { p95Ms: 99 } }, budgets)).toEqual([]);
  });
  it("temp Worker names are prefixed, bounded, sanitised; url parsed from deploy output", () => {
    expect(tempWorkerName("Site_Preact", "abc123")).toBe("cfl-perf-site-preact-abc123");
    expect(tempWorkerName("x".repeat(100), "abc123").length).toBeLessThanOrEqual(63);
    expect(deployedUrl("Deployed foo triggers\n  https://cfl-perf-demo-abc.my-sub.workers.dev\nVersion")).toBe("https://cfl-perf-demo-abc.my-sub.workers.dev");
    expect(deployedUrl("nothing")).toBeNull();
  });
  it("live mode refuses examples with resource bindings", () => {
    expect(liveSafe(`{ "name": "a", "assets": {} }`)).toBe(true);
    expect(liveSafe(`{ "d1_databases": [] }`)).toBe(false); expect(liveSafe(`{ "durable_objects": {} }`)).toBe(false); expect(liveSafe(`{ "ai": { "binding": "AI" } }`)).toBe(false);
  });
});

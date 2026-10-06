import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs helper shared with scripts/gen-llms.mjs and scripts/docs-check.mjs
import { buildLlms, describe as describeDoc, codeDrift, doctorCodes, root } from "../../../scripts/llms-lib.mjs";

describe("llms.txt generation", () => {
  it("describe() takes the title and first prose paragraph, flattening markup", () => {
    const d = describeDoc("# `Foo` page\n\n```\ncode\n```\n\nSee [bar](bar.md) for **more** `x`.\n\n| a |\n");
    expect(d).toEqual({ title: "Foo page", desc: "See bar for more x." });
  });
  it("truncates long descriptions at a word boundary", () => {
    const d = describeDoc("# T\n\n" + "word ".repeat(80));
    expect(d.desc.length).toBeLessThanOrEqual(160); expect(d.desc.endsWith("...")).toBe(true);
  });
  it("is deterministic and the committed llms.txt is current (run `bun run llms:gen` if this fails)", () => {
    expect(buildLlms()).toBe(buildLlms());
    expect(readFileSync(join(root, "llms.txt"), "utf8")).toBe(buildLlms());
  });
  it("lists every docs page exactly once", () => {
    const txt: string = buildLlms();
    for (const n of ["getting-started", "troubleshooting", "doctor", "rsc", "roadmap-dx"]) expect(txt.split(`/docs/${n}.md)`).length - 1).toBe(1);
  });
});

describe("doc drift", () => {
  it("finds every doctor code and the real docs have no drift", () => {
    expect(doctorCodes()).toContain("CFL018");
    const f = (p: string): [string, string] => [p, readFileSync(join(root, p), "utf8")];
    expect(codeDrift(["docs/doctor.md", "docs/dx.md", "docs/getting-started.md", "docs/roadmap-dx.md", "docs/troubleshooting.md"].map(f))).toEqual([]);
  });
  it("flags a stale range and a missing section", () => {
    const bad = codeDrift([["docs/x.md", "codes CFL001-CFL011"], ["docs/doctor.md", "## CFL001\n"]], ["CFL001", "CFL002"]);
    expect(bad).toEqual(["docs/x.md: range ends at CFL011, doctor.ts emits up to CFL002", 'docs/doctor.md: no "## CFL002" section']);
  });
});

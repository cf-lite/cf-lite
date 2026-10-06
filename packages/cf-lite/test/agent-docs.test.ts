import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain .mjs helper shared with scripts/docs-check.mjs
import { agentDocsProblems, briefProblems, decisionsProblems, denyProblems, parseDecisions, frontMatter } from "../../../scripts/agent-docs-lib.mjs";

const entry = (over: Record<string, string> = {}) => {
  const f: Record<string, string> = { date: "2026-10-06", "decided by": "owner", source: "PR #1", decision: "x", why: "y", scope: "z", evidence: "none (owner statement only)", status: "active", lastChecked: "2026-10-06 by doc agent", ...over };
  return `### D-001 Title\n| field | value |\n|---|---|\n${Object.entries(f).map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n`;
};
const today = Date.parse("2026-10-10");

describe("agent docs rules", () => {
  it("the repository itself has 0 findings", () => {
    expect(agentDocsProblems(join(__dirname, "../../.."))).toEqual([]);
  });
  it("parses an entry and accepts a valid one", () => {
    expect(parseDecisions(entry())[0].fields.status).toBe("active");
    expect(decisionsProblems(entry(), { today })).toEqual([]);
  });
  it("rejects a personal name, a bad status, a missing field and a bad date", () => {
    expect(decisionsProblems(entry({ "decided by": "Alice" }), { today }).join()).toMatch(/must be a role/);
    expect(decisionsProblems(entry({ status: "maybe" }), { today }).join()).toMatch(/status/);
    expect(decisionsProblems(entry({ date: "06/10/2026" }), { today }).join()).toMatch(/not YYYY-MM-DD/);
    expect(decisionsProblems(entry().replace("| why | y |\n", ""), { today }).join()).toMatch(/missing field "why"/);
  });
  it("checks evidence paths, superseding ids and staleness", () => {
    expect(decisionsProblems(entry({ evidence: "`docs/nope.md`" }), { today, exists: () => false }).join()).toMatch(/does not exist/);
    expect(decisionsProblems(entry({ status: "superseded by D-009" }), { today }).join()).toMatch(/D-009, which does not exist/);
    expect(decisionsProblems(entry({ lastChecked: "2026-01-01 by doc agent" }), { today }).join()).toMatch(/older than 90 days/);
    expect(decisionsProblems(entry({ status: "unverified", lastChecked: "2026-01-01 by doc agent" }), { today })).toEqual([]);
  });
  it("brief front matter, listing and staleness", () => {
    const ok = "---\nversion: 0.4.0\nscope: agents\nevidence: unverified\nverifiedOn: 2026-10-06\nowner: maintainer\n---\n# Brief: x\n";
    expect(briefProblems("x.md", ok, new Set(["x.md"]), today)).toEqual([]);
    expect(briefProblems("x.md", ok, new Set(), today).join()).toMatch(/not listed/);
    expect(briefProblems("x.md", ok.replace("2026-10-06", "2026-01-01"), new Set(["x.md"]), today).join()).toMatch(/older than 90/);
    expect(briefProblems("x.md", "# no front matter", new Set(), today).join()).toMatch(/missing front matter/);
    expect(frontMatter(ok)?.owner).toBe("maintainer");
  });
  it("denylist flags infrastructure leaks, not the placeholders", () => {
    expect(denyProblems("agents/x.md", "see 10.1.2.3 or /home/dev/x", []).length).toBe(2);
    expect(denyProblems("agents/x.md", "fetch https://example.com/a?token=1", []).length).toBe(1);
    expect(denyProblems("agents/x.md", "an API key supplied by the owner via the secret store", [])).toEqual([]);
    const terms = [["term", /zorblax/i, "term from the external hygiene list"]];
    expect(denyProblems("agents/x.md", "the Zorblax host", terms).length).toBe(1);
    expect(denyProblems("agents/x.md", "the Zorblax host", [])).toEqual([]);
  });
  it("reads the real log without throwing", () => {
    const text = readFileSync(join(__dirname, "../../../docs/DECISIONS.md"), "utf8");
    expect(parseDecisions(text).length).toBeGreaterThanOrEqual(15);
  });
});

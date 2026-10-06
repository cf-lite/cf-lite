import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgents, appFacts, AI_SOURCE, renderAgents, renderCopilot, renderSkill } from "../src/ai-assets.js";
import { doctor } from "../src/doctor.js";
import { doctorFix } from "../src/doctor-fix.js";
import { parseWith, runInit } from "../src/init.js";
import { dryRun } from "../src/add-extras.js";

const tmps: string[] = [];
const app = (files: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "init-")); tmps.push(d);
  const all = { "package.json": '{"name":"demo"}', "wrangler.jsonc": '{\n  // keep me\n  "name": "demo",\n  "compatibility_date": "2026-09-01"\n}\n', ...files };
  for (const [f, b] of Object.entries(all)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), b); }
  return d;
};
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const NOW = new Date("2026-10-02");

describe("AI assets (one source, four targets)", () => {
  it("every target carries every rule and command from AI_SOURCE", () => {
    const f = { name: "demo", ui: "react", bindings: ["DB"] };
    for (const text of [renderAgents(f), renderSkill(f), renderCopilot(f)]) {
      for (const r of AI_SOURCE.rules) expect(text).toContain(r);
      for (const [c] of AI_SOURCE.commands) expect(text).toContain(c);
      expect(text).toContain("Bindings: DB");
    }
    expect(renderSkill(f)).toMatch(/^---\nname: cf-lite\ndescription: .+\n---\n/);
  });
  it("writes the four files, is idempotent, never overwrites, appends the CLAUDE.md import once", () => {
    const d = app({ "CLAUDE.md": "# mine", "AGENTS.md": "# custom agents" });
    const first = addAgents(d).changed.sort();
    expect(first).toEqual([".claude/skills/cf-lite/SKILL.md", ".github/copilot-instructions.md", "CLAUDE.md"]);
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe("# custom agents");
    expect(readFileSync(join(d, "CLAUDE.md"), "utf8")).toBe("# mine\n\n@AGENTS.md\n");
    expect(addAgents(d).changed).toEqual([]);
  });
  it("facts come from the app: bindings and adapter", () => {
    const d = app({ "wrangler.jsonc": '{"kv_namespaces":[{"binding":"CACHE","id":"x"}]}', "vite.config.ts": 'import react from "@cf-lite/react";' });
    expect(appFacts(d)).toEqual({ name: "demo", ui: "react", bindings: ["CACHE"] });
  });
  it("refuses outside an app", () => {
    const d = mkdtempSync(join(tmpdir(), "init-")); tmps.push(d);
    expect(() => addAgents(d)).toThrow(/no package.json/);
  });
});

describe("doctor --fix", () => {
  it("fixes the safe subset, keeps comments, is idempotent", () => {
    const d = app({
      "wrangler.jsonc": '{\n  // keep me\n  "name": "demo",\n  "d1_databases": [{ "binding": "DB", "database_name": "x", "database_id": "y" }]\n}\n',
      "server/env.d.ts": "interface Env { DB: D1Database; API_TOKEN: string }",
    });
    const before = doctor(d, { now: NOW }).map((f) => f.code);
    expect(before).toEqual(expect.arrayContaining(["CFL003", "CFL006", "CFL011"]));
    const done = doctorFix(d, doctor(d, { now: NOW }), () => {}, NOW);
    expect(done.length).toBe(3);
    const w = readFileSync(join(d, "wrangler.jsonc"), "utf8");
    expect(w).toContain("// keep me");
    expect(w).toContain('"compatibility_date": "2026-10-02"');
    expect(readFileSync(join(d, ".dev.vars.example"), "utf8")).toContain("API_TOKEN=\n");
    expect(existsSync(join(d, "migrations/0001_init.sql"))).toBe(true);
    const after = doctor(d, { now: NOW }).map((f) => f.code);
    expect(after).not.toContain("CFL003");
    expect(after).not.toContain("CFL011");
    expect(doctorFix(d, doctor(d, { now: NOW }), () => {}, NOW)).toEqual([]);
  });
  it("never touches a value the user set (CFL004 stale date stays)", () => {
    const d = app({ "wrangler.jsonc": '{"name":"x","compatibility_date":"2020-01-01"}' });
    const f = doctor(d, { now: NOW });
    expect(f.map((x) => x.code)).toContain("CFL004");
    expect(doctorFix(d, f, () => {}, NOW)).toEqual([]);
    expect(readFileSync(join(d, "wrangler.jsonc"), "utf8")).toContain("2020-01-01");
  });
  it("does nothing without a wrangler config", () => {
    expect(doctorFix(app({ "wrangler.jsonc": "" }) && mkdtempSync(join(tmpdir(), "init-")), [])).toEqual([]);
  });
});

describe("init", () => {
  it("parseWith validates names and kinds", () => {
    expect(parseWith(["d1", "queue:emails", "do:Room"])).toEqual([["d1"], ["queue", "emails"], ["do", "Room"]]);
    expect(() => parseWith(["queue"])).toThrow(/needs a name/);
    expect(() => parseWith(["nope"])).toThrow(/unknown item "nope"/);
  });
  it("--yes with flags: composes add calls in order, asks nothing, writes agents + .dev.vars.example", async () => {
    const d = app();
    const calls: string[][] = [];
    const asked: string[] = [];
    const r = await runInit(d, { yes: true, ui: "react", with: ["d1", "kv"], add: async (a) => { calls.push(a); }, ask: async (q) => { asked.push(q); return ""; } });
    expect(calls).toEqual([["react"], ["d1"], ["kv"]]);
    expect(asked).toEqual([]);
    expect(r.agents).toContain("AGENTS.md");
    expect(existsSync(join(d, ".dev.vars.example"))).toBe(true);
  });
  it("--yes with no flags adds nothing but still writes agents and runs doctor", async () => {
    const d = app();
    const calls: string[][] = [];
    const r = await runInit(d, { yes: true, add: async (a) => { calls.push(a); } });
    expect(calls).toEqual([]);
    expect(existsSync(join(d, "AGENTS.md"))).toBe(true);
    expect(r.findings.every((f) => f.level !== "error")).toBe(true);
  });
  it("prompts only for what no flag answered", async () => {
    const d = app();
    const asked: string[] = [];
    const answers = ["r2, queue:emails", "n"];
    const calls: string[][] = [];
    await runInit(d, { ui: "vue", add: async (a) => { calls.push(a); }, ask: async (q) => { asked.push(q); return answers.shift()!; } });
    expect(asked.length).toBe(2); // bindings + agents; the UI flag skipped its prompt
    expect(calls).toEqual([["vue"], ["r2"], ["queue", "emails"]]);
    expect(existsSync(join(d, "AGENTS.md"))).toBe(false);
  });
  it("--no-agents / --no-fix", async () => {
    const d = app({ "wrangler.jsonc": '{"name":"x"}' });
    const r = await runInit(d, { yes: true, agents: false, fix: false, add: async () => {} });
    expect(r.agents).toEqual([]);
    expect(r.fixed).toEqual([]);
    expect(r.findings.map((f) => f.code)).toContain("CFL003");
  });
  it("auto-fixes the post-init findings by default", async () => {
    const d = app({ "wrangler.jsonc": '{"name":"x"}' });
    const r = await runInit(d, { yes: true, add: async () => {} });
    expect(r.fixed.length).toBeGreaterThan(0);
    expect(r.findings.map((f) => f.code)).not.toContain("CFL003");
  });
  it("an unknown --with fails before any step runs", async () => {
    const d = app();
    const calls: string[][] = [];
    await expect(runInit(d, { yes: true, ui: "react", with: ["d1", "zzz"], add: async (a) => { calls.push(a); } })).rejects.toThrow(/unknown item/);
    expect(calls).toEqual([]);
  });
  it("run twice = no diff (dry-run on the result)", async () => {
    const d = app();
    const o = { yes: true, with: ["d1"] as string[], add: async () => {} };
    await runInit(d, o);
    const lines = await dryRun(d, async (s) => { await runInit(s, o); });
    expect(lines).toEqual(["(no changes)"]);
  });
});

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCi, addSmartPlacement, checkPreviewConfig, describePlan, parseDeployFlags, parseDotenv, parseSteps, parseVersionId, planDeploy, pushSecrets, runGradual, type Wrangler } from "../src/cli-deploy.js";
import { CliError } from "../src/cli-db.js";
import { defineEnv, envGuard, EnvError, parseEnv } from "../src/modules/env.js";

const OLD = "11111111-1111-1111-1111-111111111111";
const NEW = "22222222-2222-2222-2222-222222222222";

function mock(opts: { uploadOut?: string; failDeployAt?: number } = {}) {
  const calls: string[][] = [];
  const w: Wrangler = (args) => {
    calls.push(args);
    if (args[0] === "deployments") return { code: 0, out: JSON.stringify([{ versions: [{ version_id: OLD, percentage: 100 }] }]) };
    if (args[0] === "versions" && args[1] === "upload") return { code: 0, out: opts.uploadOut ?? `Worker Version ID: ${NEW}\n` };
    if (args[0] === "versions" && args[1] === "deploy" && opts.failDeployAt && args.some((a) => a.endsWith(`@${opts.failDeployAt}`))) return { code: 1, out: "" };
    return { code: 0, out: "" };
  };
  return { w, calls };
}

describe("flags + plan (--dry-run)", () => {
  it("parses --gradual and appends 100", () => {
    expect(parseSteps("10,50")).toEqual([10, 50, 100]);
    expect(() => parseSteps("50,10")).toThrow(CliError);
    expect(() => parseSteps("0,100")).toThrow(CliError);
    expect(() => parseSteps("a")).toThrow(CliError);
  });
  it("prints a gradual plan without touching anything", () => {
    const f = parseDeployFlags(["--env", "prod", "--gradual", "10,100", "--health-url", "https://x/_health", "--dry-run"]);
    expect(f.dryRun).toBe(true);
    const lines = describePlan(planDeploy(f), f).join("\n");
    expect(lines).toContain("wrangler versions upload --env prod");
    expect(lines).toContain("<current>@90 <new>@10 -y");
    expect(lines).toContain("<new>@100");
    expect(lines).toContain("rollback");
  });
  it("plain deploy = wrangler deploy [--env]; preview = versions upload --preview-alias", () => {
    expect(planDeploy(parseDeployFlags(["--env", "staging"]))).toEqual({ kind: "plain", steps: [{ label: "deploy", args: ["deploy", "--env", "staging"] }] });
    const p = planDeploy(parseDeployFlags(["--env", "preview", "--preview-alias", "pr-7"]));
    expect(p.kind === "preview" && p.steps[0].args).toEqual(["versions", "upload", "--env", "preview", "--preview-alias", "pr-7", "--message", "preview pr-7"]);
  });
  it("rejects bad combos", () => {
    expect(() => parseDeployFlags(["--gradual", "10", "--preview-alias", "pr-1"])).toThrow(CliError);
    expect(() => parseDeployFlags(["--preview-alias", "PR 1"])).toThrow(CliError);
    expect(() => parseDeployFlags(["--env"])).toThrow(CliError);
  });
  it("parses a version id", () => { expect(parseVersionId(`x\nWorker Version ID: ${NEW}\n`)).toBe(NEW); expect(parseVersionId("nope")).toBeUndefined(); });
});

describe("gradual rollout + rollback (mocked wrangler)", () => {
  const f = (extra: string[] = []) => parseDeployFlags(["--gradual", "10,50,100", "--health-url", "https://x/_health", "--soak", "10", "--interval", "5", ...extra]);
  const run = (m: ReturnType<typeof mock>, flags = f(), fetchStatus: () => number = () => 200) =>
    runGradual(planDeploy(flags) as any, flags, { wrangler: m.w, fetch: async () => ({ status: fetchStatus() }), sleep: async () => {} });

  it("walks 10 -> 50 -> 100 with old/new splits and never rolls back when healthy", async () => {
    const m = mock();
    const r = await run(m);
    expect(r).toMatchObject({ ok: true, newVersion: NEW, previous: OLD, rolledBack: false });
    const specs = m.calls.filter((c) => c[1] === "deploy").map((c) => c.slice(2, c.indexOf("--message")).join(" "));
    expect(specs).toEqual([`${OLD}@90 ${NEW}@10`, `${OLD}@50 ${NEW}@50`, `${NEW}@100`]);
    expect(m.calls.some((c) => c[0] === "rollback")).toBe(false);
  });
  it("a failing health gate rolls back to the previous version and stops", async () => {
    const m = mock();
    const r = await run(m, f(), () => 503);
    expect(r).toMatchObject({ ok: false, rolledBack: true, failedAt: 10, previous: OLD });
    expect(m.calls.filter((c) => c[1] === "deploy")).toHaveLength(1);
    expect(m.calls.at(-1)).toEqual(expect.arrayContaining(["rollback", OLD, "-y"]));
  });
  it("a failing versions deploy step also rolls back; a failing rollback is reported loudly", async () => {
    const m = mock({ failDeployAt: 50 });
    const r = await run(m);
    expect(r).toMatchObject({ ok: false, rolledBack: true, failedAt: 50 });
    const bad: Wrangler = (a, o) => (a[0] === "rollback" ? { code: 1, out: "" } : mock().w(a, o));
    const flags = f();
    const r2 = await runGradual(planDeploy(flags) as any, flags, { wrangler: bad, fetch: async () => ({ status: 500 }), sleep: async () => {} });
    expect(r2.rolledBack).toBe(false);
    expect(r2.reason).toContain("ROLLBACK ALSO FAILED");
  });
  it("tolerates --max-failures probes", async () => {
    let n = 0;
    const r = await run(mock(), f(["--max-failures", "1"]), () => (n++ === 0 ? 500 : 200));
    expect(r.ok).toBe(true);
  });
  it("upload without a version id aborts before any traffic change", async () => {
    const m = mock({ uploadOut: "garbled" });
    const r = await run(m);
    expect(r.ok).toBe(false);
    expect(m.calls.some((c) => c[1] === "deploy")).toBe(false);
  });
  it("first deploy (no current version) goes straight to 100%", async () => {
    const calls: string[][] = [];
    const w: Wrangler = (a) => { calls.push(a); return a[0] === "deployments" ? { code: 1, out: "" } : a[1] === "upload" ? { code: 0, out: `Worker Version ID: ${NEW}` } : { code: 0, out: "" }; };
    const flags = f();
    const r = await runGradual(planDeploy(flags) as any, flags, { wrangler: w, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(calls.filter((c) => c[1] === "deploy")).toHaveLength(1);
  });
});

describe("preview never gets production bindings", () => {
  const base = { name: "app", d1_databases: [{ binding: "DB", database_name: "app-db", database_id: "prod-id" }], kv_namespaces: [{ binding: "KV", id: "kvprod" }] };
  it("errors without an env, with a missing env block, or when an id is reused", () => {
    expect(checkPreviewConfig(base, undefined).errors[0]).toContain("--env");
    expect(checkPreviewConfig(base, "preview").errors[0]).toContain("no env.preview");
    const reuse = checkPreviewConfig({ ...base, env: { preview: { d1_databases: [{ binding: "DB", database_name: "app-db", database_id: "prod-id" }] } } }, "preview");
    expect(reuse.errors.join()).toContain("reuses production database_id");
  });
  it("passes with its own resources; warns about missing ones and cron", () => {
    const ok = checkPreviewConfig({ ...base, env: { preview: { d1_databases: [{ binding: "DB", database_name: "app-db-preview", database_id: "prev-id" }], triggers: { crons: ["* * * * *"] } } } }, "preview");
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.join()).toContain("kv_namespaces");
    expect(ok.warnings.join()).toContain("cron");
  });
  it("routes on a preview are an error", () => {
    expect(checkPreviewConfig({ ...base, env: { preview: { routes: ["x.com/*"] } } }, "preview").errors.join()).toContain("routes");
  });
});

describe("secrets push never echoes values", () => {
  const SECRET = "sup3r-s3cret-value-XYZ";
  const setup = (gitignore = ".dev.vars\n") => {
    const d = mkdtempSync(join(tmpdir(), "cfl-sec-"));
    writeFileSync(join(d, ".dev.vars"), `# c\nAPI_KEY=${SECRET}\nexport OTHER="quoted ${SECRET}"\n`);
    if (gitignore) writeFileSync(join(d, ".gitignore"), gitignore);
    return d;
  };
  it("logs names only (dry-run and real) and hands wrangler a file path, not argv values", () => {
    const d = setup(); let log = ""; const calls: string[][] = [];
    const w: Wrangler = (a) => { calls.push(a); return { code: 0, out: `Success ${SECRET}` }; };
    expect(pushSecrets(d, { dryRun: true, force: false }, w, (m) => (log += m + "\n"))).toBe(0);
    expect(calls).toHaveLength(0);
    expect(pushSecrets(d, { env: "prod", dryRun: false, force: false }, w, (m) => (log += m + "\n"))).toBe(0);
    expect(log).toContain("API_KEY, OTHER");
    expect(log).not.toContain(SECRET);
    expect(calls[0]).toEqual(["secret", "bulk", join(d, ".dev.vars"), "--env", "prod"]);
    expect(calls.flat().join(" ")).not.toContain(SECRET);
  });
  it("a failing wrangler's output is withheld too", () => {
    const d = setup(); let log = "";
    pushSecrets(d, { dryRun: false, force: false }, () => ({ code: 1, out: `boom ${SECRET}` }), (m) => (log += m));
    expect(log).not.toContain(SECRET);
    expect(log).toContain("exit 1");
  });
  it("errors never contain values; un-ignored file refused; --only filters", () => {
    expect(() => pushSecrets(setup(""), { dryRun: true, force: false }, () => ({ code: 0, out: "" }), () => {})).toThrow(/not in \.gitignore/);
    const d = setup(); writeFileSync(join(d, ".dev.vars"), `BAD LINE ${SECRET}\n`);
    try { pushSecrets(d, { dryRun: true, force: false }, () => ({ code: 0, out: "" }), () => {}); expect.unreachable(); } catch (e) { expect((e as Error).message).not.toContain(SECRET); expect((e as Error).message).toContain("line 1"); }
    const d2 = setup(); let log = "";
    pushSecrets(d2, { dryRun: true, force: false, only: ["OTHER"] }, () => ({ code: 0, out: "" }), (m) => (log += m));
    expect(log).toContain("1 secret(s)"); expect(log).not.toContain("API_KEY");
    expect(() => pushSecrets(d2, { dryRun: true, force: false, only: ["NOPE"] }, () => ({ code: 0, out: "" }), () => {})).toThrow(/NOPE/);
  });
  it("dotenv parsing", () => {
    expect(parseDotenv("A=1 # c\nB='x y'\n\n# z\nexport C=\"q\"")).toEqual({ A: "1", B: "x y", C: "q" });
  });
});

describe("smart placement + CI templates", () => {
  it("adds placement once, keeping comments; leaves an existing one", () => {
    const src = `{\n  // keep me\n  "name": "a",\n  "compatibility_date": "2026-09-01"\n}\n`;
    const r = addSmartPlacement(src);
    expect(r.changed).toBe(true);
    expect(r.text).toContain("// keep me");
    expect(JSON.parse(r.text.replace(/\/\/.*/g, "")).placement).toEqual({ mode: "smart" });
    expect(addSmartPlacement(r.text).changed).toBe(false);
    expect(addSmartPlacement(`{ "name": "a", "placement": { "mode": "off" } }`).changed).toBe(false);
  });
  it("addCi writes both workflows and never overwrites", () => {
    const d = mkdtempSync(join(tmpdir(), "cfl-ci-")); const t = join(__dirname, "..", "templates", "ci");
    addCi(d, t, () => {});
    const prod = join(d, ".github/workflows/production-cf-lite.yml");
    expect(readFileSync(prod, "utf8")).toContain("environment: production");
    expect(readFileSync(join(d, ".github/workflows/preview-cf-lite.yml"), "utf8")).toContain("--preview-alias");
    writeFileSync(prod, "mine"); addCi(d, t, () => {});
    expect(readFileSync(prod, "utf8")).toBe("mine");
    expect(existsSync(t)).toBe(true);
  });
});

describe("defineEnv fails closed", () => {
  const str = (v: unknown) => { if (typeof v !== "string" || !v) throw new Error("must be a non-empty string"); return v; };
  const std = { "~standard": { validate: (v: unknown) => (typeof v === "number" ? { value: v } : { issues: [{ message: "expected number" }] }) } };
  it("names every bad variable, never values", () => {
    try { parseEnv({ A: str, B: str, N: std as any }, { A: "ok", N: "hunter2" }); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(EnvError); const m = (e as Error).message; expect(m).toContain("B: missing"); expect(m).toContain("N: expected number"); expect(m).not.toContain("hunter2"); expect(m).not.toContain("A:"); }
  });
  it("returns typed values, passes other bindings through, caches per env object", () => {
    let calls = 0; const get = defineEnv({ A: (v) => { calls++; return str(v).toUpperCase(); } });
    const raw = { A: "x", DB: { tag: "d1" } };
    const e = get(raw); expect(e.A).toBe("X"); expect(e.DB).toBe(raw.DB); get(raw); expect(calls).toBe(1);
  });
  it("envGuard answers 500 without detail and skips next()", async () => {
    const logs: string[] = []; const orig = console.error; console.error = (m: string) => logs.push(m);
    try {
      const g = envGuard({ A: str }); let nexted = false;
      const c = { env: {}, text: (b: string, s?: number) => new Response(b, { status: s }) };
      const res = (await g(c, async () => { nexted = true; })) as Response;
      expect(res.status).toBe(500); expect(await res.text()).toBe("Server misconfigured"); expect(nexted).toBe(false); expect(logs.join()).toContain("A: missing");
      const ok = await envGuard({ A: str })({ ...c, env: { A: "v" } }, async () => { nexted = true; }); expect(ok).toBeUndefined(); expect(nexted).toBe(true);
    } finally { console.error = orig; }
  });
});

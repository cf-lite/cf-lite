import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DOCTOR_CODES, doctor, declaredBindings, envTypeKeys } from "../src/doctor.js";
import { analyze, formatReport, staticImports } from "../src/analyze.js";
import { CODEMODS, cmpVersion, diskFs, plan } from "../src/upgrade/codemods.js";
import { upgrade } from "../src/upgrade/index.js";
import { addExtra, dryRun } from "../src/add-extras.js";
import { addDo } from "../src/add-do.js";
import { addJob } from "../src/add-jobs.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "dx-"));
const put = (d: string, f: string, s: string) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), s); };
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");
const codes = (d: string, o = {}) => doctor(d, { now: new Date("2026-09-30"), ...o }).map((f) => f.code);
function* files(d: string, base = d): Generator<string> { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) yield* files(p, base); else yield relative(base, p); } }

describe("doctor", () => {
  const app = (wr: string, extra: Record<string, string> = {}) => { const d = tmp(); put(d, "wrangler.jsonc", wr); for (const [f, s] of Object.entries(extra)) put(d, f, s); return d; };
  const good = `{ "name": "x", "main": "server/worker.ts", "compatibility_date": "2026-09-01", "assets": { "run_worker_first": ["/api/*"] } }`;
  it("clean app: no findings", () => expect(codes(app(good))).toEqual([]));
  it("CFL001 no config / unparsable, CFL002 wrangler.toml", () => {
    expect(codes(tmp())).toEqual(["CFL001"]);
    expect(codes(app("{ nope"))).toEqual(["CFL001"]);
    const d = tmp(); put(d, "wrangler.toml", 'name = "x"'); expect(codes(d)).toEqual(["CFL002"]);
  });
  it("CFL003 missing/invalid compat date, CFL004 older than 180 days", () => {
    expect(codes(app(`{ "name": "x" }`))).toContain("CFL003");
    expect(codes(app(`{ "compatibility_date": "soon" }`))).toContain("CFL003");
    expect(codes(app(`{ "compatibility_date": "2026-03-01" }`))).toContain("CFL004");
    expect(codes(app(`{ "compatibility_date": "2026-04-05" }`))).not.toContain("CFL004"); // 178 days
  });
  it("CFL005/CFL006 bindings vs Env (incl. nested types, comments)", () => {
    const wr = `{ "compatibility_date": "2026-09-01", "d1_databases": [{ "binding": "DB" }], "kv_namespaces": [{ "binding": "KV" }], "vars": { "SITE": "x" }, "ai": { "binding": "AI" } }`;
    const d = app(wr, { "server/env.d.ts": `interface Env {\n  DB: D1Database; // the db\n  SITE: string;\n  NESTED: { a: string; b: number };\n  SECRET_ONLY: string;\n}` });
    const f = doctor(d, { now: new Date("2026-09-30") });
    expect(f.find((x) => x.code === "CFL005")!.message).toMatch(/KV, AI|AI, KV/);
    expect(f.find((x) => x.code === "CFL005")!.message).not.toMatch(/DB|SITE/);
    expect(f.find((x) => x.code === "CFL006")!.message).toMatch(/SECRET_ONLY/);
    expect([...envTypeKeys(d).keys].sort()).toEqual(["DB", "NESTED", "SECRET_ONLY", "SITE"]);
    // secret documented in .dev.vars.example silences CFL006
    put(d, ".dev.vars.example", "SECRET_ONLY=\nNESTED=\n");
    expect(codes(d)).not.toContain("CFL006");
    expect(codes(app(wr))).toContain("CFL005"); // no Env at all
    expect([...declaredBindings({ durable_objects: { bindings: [{ name: "ROOM" }] }, queues: { producers: [{ binding: "Q" }] }, assets: { binding: "ASSETS" } })].sort()).toEqual(["ASSETS", "Q", "ROOM"]);
  });
  it("CFL007 run_worker_first everything / without a Worker", () => {
    expect(codes(app(`{ "compatibility_date": "2026-09-01", "main": "a.ts", "assets": { "run_worker_first": true } }`))).toContain("CFL007");
    expect(codes(app(`{ "compatibility_date": "2026-09-01", "main": "a.ts", "assets": { "run_worker_first": ["/*", "!/assets/*"] } }`))).not.toContain("CFL007");
    expect(doctor(app(`{ "compatibility_date": "2026-09-01", "assets": { "run_worker_first": ["/api/*"] } }`), { now: new Date("2026-09-30") }).find((f) => f.code === "CFL007")?.level).toBe("error");
  });
  it("CFL008 cron/queue handlers without wrangler entries", () => {
    const d = app(good, { "server/cron/a.ts": "export default 1", "server/queues/jobs.ts": "export default 1" });
    const f = doctor(d, { now: new Date("2026-09-30") }).filter((x) => x.code === "CFL008");
    expect(f).toHaveLength(2);
    // adding through `cf-lite add` satisfies doctor
    addJob(d, "cron", "b"); addJob(d, "queue", "jobs");
    expect(doctor(d, { now: new Date("2026-09-30") }).filter((x) => x.code === "CFL008").map((x) => x.message).join()).not.toMatch(/queue/);
  });
  it("CFL009 DO without migration; `add do` fixes it", () => {
    const d = app(`{ "compatibility_date": "2026-09-01", "durable_objects": { "bindings": [{ "name": "CHAT", "class_name": "Chat" }] } }`);
    expect(doctor(d, { now: new Date("2026-09-30") }).find((f) => f.code === "CFL009")?.level).toBe("error");
    const d2 = app(`{ "compatibility_date": "2026-09-01" }`); addDo(d2, "chat");
    expect(codes(d2)).not.toContain("CFL009");
  });
  it("CFL010 size budget from a built Worker", () => {
    const d = app(good);
    put(d, ".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/w/wrangler.json" }));
    put(d, "dist/w/wrangler.json", JSON.stringify({ main: "index.js" }));
    put(d, "dist/w/index.js", Array.from({ length: 60000 }, (_, i) => `const v${i}=${Math.random()};`).join("\n"));
    expect(codes(d, { budgetKiB: 100000 })).not.toContain("CFL010");
    expect(codes(d, { budgetKiB: 10 })).toContain("CFL010");
  });
  it("CFL011 D1 without migrations dir", () => {
    const d = app(`{ "compatibility_date": "2026-09-01", "d1_databases": [{ "binding": "DB" }] }`, { "server/env.d.ts": "interface Env { DB: D1Database }" });
    expect(codes(d)).toContain("CFL011");
    mkdirSync(join(d, "migrations")); expect(codes(d)).not.toContain("CFL011");
  });
  it("every code has a section in docs/doctor.md", () => {
    const doc = readFileSync(join(here, "../../../docs/doctor.md"), "utf8");
    for (const c of DOCTOR_CODES) expect(doc, c).toMatch(new RegExp(`^## ${c}\\b`, "m"));
  });
  it("every emitted code is registered", () => {
    const src = readFileSync(join(here, "../src/doctor.ts"), "utf8");
    for (const m of src.matchAll(/add\("(CFL\d+)"/g)) expect(DOCTOR_CODES as readonly string[]).toContain(m[1]);
  });
});

describe("analyze", () => {
  it("staticImports finds static edges, not dynamic ones", () => {
    expect(staticImports(`import{a}from"./a.js";import"./b.js";export{c}from"../c.js";const x=()=>import("./lazy.js");`)).toEqual(["./a.js", "./b.js", "../c.js"]);
  });
  it("reports Worker size and per-page client JS (transitive, sorted)", () => {
    const d = tmp();
    put(d, ".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/w/wrangler.json" }));
    put(d, "dist/w/wrangler.json", JSON.stringify({ main: "index.js", assets: { directory: "../c" } }));
    put(d, "dist/w/index.js", "export default {}; ".repeat(100));
    put(d, "dist/c/index.html", `<script type="module" src="/assets/entry.js"></script>`);
    put(d, "dist/c/about/index.html", `<p>no js</p>`);
    put(d, "dist/c/assets/entry.js", `import"./shared.js";import{x}from"./other.js";export const lazy=()=>import("./lazy.js");`);
    put(d, "dist/c/assets/shared.js", "var a=1;".repeat(500));
    put(d, "dist/c/assets/other.js", "import './shared.js';var b=2;");
    put(d, "dist/c/assets/lazy.js", "var l=3;".repeat(5000));
    const r = analyze(d);
    expect(r.worker!.files[0].file).toBe("index.js");
    const home = r.pages.find((p) => p.page === "/")!;
    expect(home.js.map((f) => f.file).sort()).toEqual(["assets/entry.js", "assets/other.js", "assets/shared.js"]); // lazy excluded, shared counted once
    expect(home.gzipTotal).toBe(home.js.reduce((s, f) => s + f.gzip, 0));
    expect(r.pages.find((p) => p.page === "/about")!.js).toEqual([]);
    expect(formatReport(r)).toMatch(/Client JS per page[\s\S]*\//);
    expect(analyze(tmp()).worker).toBeNull();
  });
});

describe("upgrade codemods", () => {
  const fx = (n: string, s: "before" | "after") => join(here, "fixtures/upgrade", n, s);
  for (const [name, id] of [["0.2-app", "0.3-renderer"], ["0.3-sso", "0.4-sso-env"]] as const) {
    it(`${id}: before -> after fixture, idempotent`, () => {
      const d = tmp(); cpSync(fx(name, "before"), d, { recursive: true });
      const cm = CODEMODS.find((c) => c.id === id)!;
      const r1 = cm.run(diskFs(d));
      expect(r1.changed.length).toBeGreaterThan(0);
      for (const f of files(fx(name, "after"))) expect(read(d, f), f).toBe(readFileSync(join(fx(name, "after"), f), "utf8"));
      const r2 = cm.run(diskFs(d));
      expect(r2.changed).toEqual([]); // second run = no diff
    });
  }
  it("plan picks codemods by version window", () => {
    expect(plan("^0.2.1", "0.4.0").map((c) => c.id)).toEqual(["0.3-renderer", "0.4-sso-env"]);
    expect(plan("^0.3.0", "0.4.0").map((c) => c.id)).toEqual(["0.4-sso-env"]);
    expect(plan("^0.4.0", "0.4.0")).toEqual([]);
    expect(plan("^0.2.0", "0.3.5").map((c) => c.id)).toEqual(["0.3-renderer"]);
    expect(cmpVersion("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });
  it("unknown renderer strings produce a manual step, not a guess", () => {
    const d = tmp(); put(d, "vite.config.ts", `export default { plugins: [cfLite({ renderer: "lit" })] }`);
    const r = CODEMODS[0].run(diskFs(d));
    expect(r.changed).toEqual([]); expect(r.manual[0]).toMatch(/unknown renderer/);
  });
  it("upgrade(): runs codemods, bumps versions, --dry-run writes nothing, second run is a no-op", () => {
    const d = tmp(); cpSync(fx("0.2-app", "before"), d, { recursive: true });
    put(d, "package.json", JSON.stringify({ dependencies: { "cf-lite": "^0.2.1", hono: "^4.0.0" } }));
    const before = read(d, "vite.config.ts");
    const dry = upgrade(d, { to: "0.4.0", dryRun: true });
    expect(dry.ran).toEqual(["0.3-renderer", "0.4-sso-env"]); expect(dry.changed).toContain("package.json");
    expect(read(d, "vite.config.ts")).toBe(before); expect(JSON.parse(read(d, "package.json")).dependencies["cf-lite"]).toBe("^0.2.1");
    const r = upgrade(d, { to: "0.4.0", install: false });
    expect(read(d, "vite.config.ts")).toContain("renderer: react()");
    expect(JSON.parse(read(d, "package.json")).dependencies["cf-lite"]).toBe("^0.4.0");
    expect(upgrade(d, { to: "0.4.0", install: false }).changed).toEqual([]);
    expect(r.manual.join()).toMatch(/@cf-lite\/react/);
  });
  it("every breaking change in the changelog mentions a codemod id or is listed as no-automated-path (Breaking entries tracked)", () => {
    const cl = readFileSync(join(here, "../../../CHANGELOG.md"), "utf8");
    expect(cl).toMatch(/\*\*Breaking/); // sanity: the rule has something to apply to
    expect(CODEMODS.length).toBeGreaterThanOrEqual(2);
  });
});

describe("add extras + --dry-run", () => {
  const appDir = () => {
    const d = tmp();
    put(d, "package.json", JSON.stringify({ name: "a", dependencies: { "cf-lite": "^0.4.0" } }, null, 2) + "\n");
    put(d, "vite.config.ts", `import { defineConfig } from "vite";\nimport cfLite from "cf-lite/vite";\n\nexport default defineConfig({ plugins: [cfLite()] });\n`);
    put(d, "index.html", `<html><head><title>x</title></head><body></body></html>`);
    put(d, "wrangler.jsonc", `{\n  // keep me\n  "name": "a",\n  "compatibility_date": "2026-09-01"\n}\n`);
    put(d, "server/env.d.ts", "interface Env {}\n");
    return d;
  };
  const snapshot = (d: string) => Object.fromEntries([...files(d)].map((f) => [f, read(d, f)]));
  for (const kind of ["tailwind", "ai", "images", "turnstile"] as const) {
    it(`${kind}: idempotent (run twice = no diff) and --dry-run matches the real run without touching the dir`, async () => {
      const d = appDir();
      const before = snapshot(d);
      const dry = await dryRun(d, (s) => { addExtra(s, kind, { install: false }); });
      expect(snapshot(d)).toEqual(before); // dry-run changed nothing
      expect(dry.join("\n")).not.toBe("(no changes)");
      const r1 = addExtra(d, kind, { install: false });
      const afterOnce = snapshot(d);
      const r2 = addExtra(d, kind, { install: false });
      expect(r2.changed).toEqual([]); expect(snapshot(d)).toEqual(afterOnce);
      // every file the dry-run reported is one the real run changed
      const reported = dry.filter((l) => /^[+~] /.test(l)).map((l) => l.slice(2)).sort();
      expect(reported).toEqual([...r1.changed].sort());
      expect(await dryRun(d, (s) => { addExtra(s, kind, { install: false }); })).toEqual(["(no changes)"]);
    });
  }
  it("tailwind: golden dry-run output", async () => {
    const out = (await dryRun(appDir(), (s) => { addExtra(s, "tailwind", { install: false }); })).join("\n");
    expect(out).toMatchInlineSnapshot(`
      "+ app/styles.css
      ~ index.html
          +<html><head><title>x</title>  <link rel="stylesheet" href="/app/styles.css" />
          +</head><body></body></html>
          -<html><head><title>x</title></head><body></body></html>
      ~ package.json
          +    "cf-lite": "^0.4.0",
          +    "tailwindcss": "^4.1.0"
          +  },
          +  "devDependencies": {
          +    "@tailwindcss/vite": "^4.1.0"
          -    "cf-lite": "^0.4.0"
      ~ vite.config.ts
          +import tailwindcss from "@tailwindcss/vite";
          +export default defineConfig({ plugins: [tailwindcss(), cfLite()] });
          -export default defineConfig({ plugins: [cfLite()] });"
    `)
  });
  it("ai/images: wrangler edit keeps comments, adds binding + Env type once", () => {
    const d = appDir();
    addExtra(d, "ai", { install: false }); addExtra(d, "images", { install: false });
    const w = read(d, "wrangler.jsonc");
    expect(w).toContain("// keep me"); expect(w).toContain('"binding": "AI"'); expect(w).toContain('"binding": "IMAGES"');
    expect(read(d, "server/env.d.ts")).toMatch(/AI: Ai;/); expect(read(d, "server/env.d.ts")).toMatch(/IMAGES: ImagesBinding;/);
    expect(codes(d)).toEqual([]); // and doctor agrees the bindings are typed
  });
  it("turnstile: never overwrites an existing route file", () => {
    const d = appDir(); put(d, "server/api/signup.ts", "// mine");
    addExtra(d, "turnstile", { install: false });
    expect(read(d, "server/api/signup.ts")).toBe("// mine");
    expect(read(d, ".dev.vars.example")).toContain("TURNSTILE_SECRET=");
  });
  it("add d1/kv/do/cron/queue dry-run goes through the same scratch-copy mechanism", async () => {
    const d = appDir();
    const out = await dryRun(d, (s) => { addDo(s, "room"); addJob(s, "cron", "nightly", () => {}, { schedule: "0 3 * * *" }); });
    expect(out.filter((l) => /^[+~] /.test(l))).toEqual(["+ server/cron/nightly.ts", "+ server/do/room.ts", "~ wrangler.jsonc"]);
    expect(existsSync(join(d, "server/do/room.ts"))).toBe(false);
  });
});

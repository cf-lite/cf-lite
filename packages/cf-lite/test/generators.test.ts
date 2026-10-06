import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, GenError, planGenerate, reportDry, reportJson, routeUrl, type GenOptions, type Generator } from "../src/gen-app.js";
import { planSeed, rowsToSql, runSeed } from "../src/seed.js";
import { scanPreview } from "../src/preview-scan.js";

const tmps: string[] = [];
const app = (ui: string | null = "react", files: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), "gen-")); tmps.push(d);
  const all: Record<string, string> = { "package.json": '{"name":"demo"}', "wrangler.jsonc": '{"name":"demo","d1_databases":[{"binding":"DB","database_name":"demo-db"}]}', ...(ui ? { "vite.config.ts": `import x from "@cf-lite/${ui}";` } : {}), ...files };
  for (const [f, b] of Object.entries(all)) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), b); }
  return d;
};
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const out = (d: string, g: Generator, n: string, o: GenOptions = {}) => Object.fromEntries(planGenerate(d, g, n, o).files.map((f) => [f.path, f.content]));

describe("generated output (snapshots = the frozen conventions)", () => {
  for (const ui of ["react", "preact", "solid", "vue", "svelte"]) {
    it(`page + component, ${ui}`, () => {
      const d = app(ui);
      expect(out(d, "page", "about")).toMatchSnapshot();
      expect(out(d, "page", "posts/[id]", { render: "ssr", loader: true })).toMatchSnapshot();
      expect(out(d, "component", "Card")).toMatchSnapshot();
    });
  }
  it("page variants", () => {
    const d = app();
    expect(out(d, "page", "docs/[...rest]", { render: "ssr" })).toMatchSnapshot();
    expect(out(d, "page", "(marketing)/pricing", { render: "spa" })).toMatchSnapshot();
  });
  it("api (+ mock + seed) and its test", () => {
    const d = app();
    expect(out(d, "api", "blog-posts", { mock: true, seed: true })).toMatchSnapshot();
    expect(out(d, "test", "blog-posts", { kind: "api" })).toMatchSnapshot();
  });
  it("component variants: island, folder, dir", () => {
    const d = app();
    expect(out(d, "component", "Counter", { island: true, dir: "app/islands" })).toMatchSnapshot();
    expect(Object.keys(out(d, "component", "Nav", { folder: true, dir: "app/patterns/organisms" }))).toEqual(["app/patterns/organisms/Nav/Nav.tsx", "app/patterns/organisms/Nav/Nav.states.ts"]);
  });
  it("page + component tests", () => {
    const d = app("react", { "app/routes/about.tsx": "", "app/patterns/Card/Card.states.ts": "" });
    expect(out(d, "test", "about")).toMatchSnapshot();
    expect(out(d, "test", "Card")).toMatchSnapshot();
  });
});

describe("generator contract", () => {
  it("writes, is idempotent, never overwrites", () => {
    const d = app();
    const first = applyPlan(d, planGenerate(d, "component", "Card"));
    expect(first).toEqual(["app/components/Card.tsx", "app/components/Card.states.ts"]);
    writeFileSync(join(d, "app/components/Card.tsx"), "// mine");
    expect(applyPlan(d, planGenerate(d, "component", "Card"))).toEqual([]);
    expect(readFileSync(join(d, "app/components/Card.tsx"), "utf8")).toBe("// mine");
    expect(planGenerate(d, "component", "Card").files.map((f) => f.action)).toEqual(["keep", "keep"]);
  });
  it("--dry-run reports and --json is stable data, neither touches disk", () => {
    const d = app();
    const plan = planGenerate(d, "api", "items", { mock: true });
    expect(reportDry(plan)).toEqual(["+ server/api/items.ts", "+ mocks/api/items.json"]);
    const j = JSON.parse(reportJson(plan, true));
    expect(j).toMatchObject({ ok: true, generator: "api", name: "items", dryRun: true });
    expect(j.files[0]).toMatchObject({ path: "server/api/items.ts", action: "create" });
    expect(j.files[0].content).toContain('.post("/"');
    expect(planGenerate(d, "api", "items").files[0].action).toBe("create"); // still nothing written
  });
  it("component states are discovered by the preview scan (generated code follows the preview convention)", () => {
    const d = app();
    applyPlan(d, planGenerate(d, "component", "Card", { folder: true, dir: "app/patterns/atoms" }));
    expect(scanPreview(d).map((e) => [e.id, e.states])).toEqual([["patterns/atoms/Card", "app/patterns/atoms/Card/Card.states.ts"]]);
  });
  it("route names map to URLs", () => {
    expect(routeUrl("about")).toBe("/about");
    expect(routeUrl("index")).toBe("/");
    expect(routeUrl("posts/index")).toBe("/posts");
    expect(routeUrl("posts/[id]")).toBe("/posts/sample");
    expect(routeUrl("(m)/pricing")).toBe("/pricing");
    expect(routeUrl("docs/[[...slug]]")).toBe("/docs");
  });
  it("refuses bad input", () => {
    const d = app();
    for (const [g, n, o] of [
      ["page", "../x", {}], ["page", "/abs", {}], ["page", "About", {}], ["page", "x", { render: "nope" }], ["page", "x", { render: "spa", loader: true }],
      ["api", "a/b", {}], ["api", "Bad", {}], ["component", "card", {}], ["component", "Card", { dir: "app/routes" }], ["component", "Card", { dir: "../out" }],
      ["component", "Card", { island: true, ui: "vue" }], ["test", "ghost", {}], ["test", "Card", {}], ["page", undefined, {}],
    ] as [Generator, string | undefined, GenOptions][]) expect(() => planGenerate(d, g, n, o), `${g} ${n}`).toThrow(GenError);
    expect(() => planGenerate(app(null), "page", "x")).toThrow(/no UI adapter/);
    expect(() => planGenerate(mkdtempSync(join(tmpdir(), "gen-")), "api", "x")).toThrow(/no package.json/);
    tmps.push();
  });
  it("api and test work without a UI adapter; svelte writes no states", () => {
    expect(planGenerate(app(null), "api", "x").files).toHaveLength(1);
    expect(planGenerate(app("svelte"), "component", "Card").files.map((f) => f.path)).toEqual(["app/components/Card.svelte"]);
  });
});

describe("seed", () => {
  const seeds = (files: Record<string, string>, ui: string | null = null) => app(ui, Object.fromEntries(Object.entries(files).map(([k, v]) => ["seeds/" + k, v])));
  it("plans sql, d1 json and kv json into wrangler steps (local by default)", () => {
    const d = seeds({
      "a.sql": "INSERT INTO t VALUES (1);",
      "b.d1.json": JSON.stringify({ table: "posts", rows: [{ id: 1, title: "it's", draft: false, meta: { a: 1 }, x: null }] }),
      "c.kv.json": JSON.stringify({ binding: "CACHE", entries: [{ key: "k", value: { n: 1 } }, { key: "s", value: "str", expiration_ttl: 60 }] }),
    });
    const p = planSeed(d, []);
    expect(p.steps.map((s) => [s.kind, s.args.slice(0, 4)])).toEqual([
      ["d1-sql", ["d1", "execute", "demo-db", "--local"]], ["d1-json", ["d1", "execute", "demo-db", "--local"]], ["kv", ["kv", "bulk", "put", "<generated>"]],
    ]);
    expect(p.steps[1].sql).toBe("INSERT OR REPLACE INTO posts (id, title, draft, meta, x) VALUES (1, 'it''s', 0, '{\"a\":1}', NULL);\n");
    expect(JSON.parse(p.steps[2].bulk!)).toEqual([{ key: "k", value: '{"n":1}' }, { key: "s", value: "str", expiration_ttl: 60 }]);
    expect(planSeed(d, ["b"]).steps).toHaveLength(1);
  });
  it("refuses remote without --yes, bad identifiers, bad shapes, empty folder", () => {
    const d = seeds({ "a.d1.json": '{"table":"t","rows":[{"id":1}]}' });
    expect(() => planSeed(d, ["--remote"])).toThrow(/REMOTE.*--yes/s);
    expect(planSeed(d, ["--remote", "--yes"]).remote).toBe(true);
    expect(() => rowsToSql("t; DROP", [{ id: 1 }])).toThrow(/identifier/);
    expect(() => rowsToSql("t", [{ "a b": 1 }])).toThrow(/identifier/);
    expect(() => planSeed(seeds({ "x.kv.json": "{}" }), [])).toThrow(/binding/);
    expect(() => planSeed(seeds({ "x.d1.json": "nope" }), [])).toThrow(/invalid JSON/);
    expect(() => planSeed(app(null), [])).toThrow(/no seeds/);
    expect(() => planSeed(seeds({ "a.d1.json": "{}" }), ["zzz"])).toThrow(/no seed named/);
  });
  it("runs steps with generated temp files, stops at the first failure, cleans up", () => {
    const d = seeds({ "a.d1.json": '{"table":"t","rows":[{"id":1}]}', "b.kv.json": '{"binding":"K","entries":[{"key":"a","value":"b"}]}' });
    const seen: string[][] = []; const bodies: string[] = [];
    expect(runSeed(planSeed(d, []), (a) => { seen.push(a); bodies.push(readFileSync(a[a.includes("--file") ? a.indexOf("--file") + 1 : 3], "utf8")); return 0; }, () => {})).toBe(0);
    expect(bodies).toEqual(["INSERT OR REPLACE INTO t (id) VALUES (1);\n", '[{"key":"a","value":"b"}]']);
    expect(runSeed(planSeed(d, []), () => 3, () => {})).toBe(3);
    expect(seen[0]).not.toContain("<generated>");
  });
  it("a generator seed file feeds seed", () => {
    const d = app();
    applyPlan(d, planGenerate(d, "api", "blog-posts", { seed: true }));
    expect(planSeed(d, []).steps[0].sql).toContain("INSERT OR REPLACE INTO blog_posts (id, name) VALUES (1, 'Blog posts one');");
  });
});

describe("reports and remaining branches", () => {
  it("error json, dry text for kept files, seed descriptions", async () => {
    const { errorJson } = await import("../src/gen-app.js");
    const { describeSeed, seedJson } = await import("../src/seed.js");
    expect(JSON.parse(errorJson(new GenError("boom")))).toEqual({ ok: false, error: "boom" });
    const d = app("react", { "app/components/Card.tsx": "x", "seeds/a.sql": "INSERT INTO t VALUES (1);", "seeds/b.kv.json": '{"binding":"K","entries":[{"key":"a","value":1}]}' });
    expect(reportDry(planGenerate(d, "component", "Card"))).toEqual(["= app/components/Card.tsx (exists, kept)", "+ app/components/Card.states.ts"]);
    const p = planSeed(d, ["--remote", "--yes", "--env", "prod"]);
    expect(describeSeed(p)).toEqual(["WARNING: REMOTE target", "d1  DB  <- seeds/a.sql (1 statements)", "kv  K  <- seeds/b.kv.json (1 entries)"]);
    expect(p.steps.every((s) => s.args.includes("prod"))).toBe(true);
    const j = JSON.parse(seedJson(planSeed(d, ["--persist-to", ".x"]), true));
    expect(j.steps[1].bulk).toEqual([{ key: "a", value: "1" }]);
    expect(JSON.parse(seedJson(planSeed(d, []), false)).steps[0]).not.toHaveProperty("sql");
  });
  it("test generator: page kind, explicit kinds, errors", () => {
    const d = app("vue", { "app/routes/posts/[id].vue": "", "server/api/items.ts": "" });
    expect(Object.keys(out(d, "test", "posts/[id]", { kind: "page" }))).toEqual(["test/routes/posts-_id_.test.ts"]);
    expect(Object.keys(out(d, "test", "items"))).toEqual(["test/api/items.test.ts"]);
    expect(() => planGenerate(d, "test", "items", { kind: "zzz" })).toThrow(/--kind/);
    expect(() => planGenerate(d, "test", "Bad name", { kind: "api" })).toThrow(GenError);
    expect(() => planGenerate(d, "test", "bad name", { kind: "component" })).toThrow(GenError);
  });
  it("vue/svelte page with params and loader", () => {
    for (const ui of ["vue", "svelte"]) expect(out(app(ui), "page", "blog/[slug]", { render: "ssr", loader: true })).toMatchSnapshot();
    expect(out(app("react"), "page", "index")).toMatchSnapshot();
    expect(planGenerate(app("react"), "page", "p/[id]").notes.join(" ")).toMatch(/paths/);
  });
});

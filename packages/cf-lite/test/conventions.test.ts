import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConvention } from "../src/conventions/index.js";
import { renderHandlers, runConventions, genApp } from "../src/generate.js";
import { builtinConventions } from "../src/conventions/index.js";
import { generate } from "../src/vite.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-cv-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};

/** A made-up convention: server/queues/*.ts -> a queue handler, a middleware line, a worker-first glob, a declaration, an extra file, a check. */
const dummy = defineConvention<string[]>({
  name: "dummy",
  scan: () => ["q1"],
  emit: (qs) => ({
    imports: [`import q0 from "../server/queues/${qs[0]}";`],
    declarations: [`const hello = "dummy";`],
    appPre: [`  .use("*", async (_c, next) => next())`],
    app: [`  .get("/dummy", (c) => c.text(hello))`],
    exports: [`export const extra = 1;`],
    files: { "dummy.ts": "export const d = 1;\n" },
    handlers: { imports: [`import q0 from "../server/queues/q1";`], queue: "(b, e, c) => q0(b, e, c)" },
    workerFirst: ["/dummy/*"],
    checks: [(w) => (w.queues ? [] : ["no queues binding"])],
  }),
});

describe("convention contributors", () => {
  it("a new convention needs zero edits of generate.ts: its chunks land in every slot", () => {
    const root = tmp({ "server/api/hello.ts": "" });
    const g = runConventions(root, undefined, [...builtinConventions, dummy]);
    const app = g.files["app.ts"];
    expect(app).toContain(`import q0 from "../server/queues/q1";`);
    expect(app).toContain(`const hello = "dummy";`);
    expect(app.indexOf(`.use("*"`)).toBeLessThan(app.indexOf(`.route("/api", api)`));
    expect(app.indexOf(`.get("/dummy"`)).toBeGreaterThan(app.indexOf(`.route("/api", api)`));
    expect(app.indexOf("export const extra")).toBeLessThan(app.indexOf("export default app"));
    expect(g.files["dummy.ts"]).toBe("export const d = 1;\n");
    expect(g.files["handlers.ts"]).toContain("queue: (b, e, c) => q0(b, e, c),");
    expect(g.workerFirst).toEqual(["/dummy/*"]);
    expect(g.checks[0]({})).toEqual(["no queues binding"]);
    expect(g.checks[0]({ queues: {} })).toEqual([]);
  });
  it("generate() writes contributor files and removes handlers.ts when the contributor goes away", () => {
    const root = tmp({ "server/api/hello.ts": "" });
    generate(root, "none", [dummy]);
    expect(readFileSync(join(root, ".cf-lite/dummy.ts"), "utf8")).toBe("export const d = 1;\n");
    expect(existsSync(join(root, ".cf-lite/handlers.ts"))).toBe(true);
    generate(root, "none");
    expect(existsSync(join(root, ".cf-lite/handlers.ts"))).toBe(false);
  });
  it("no handlers => no handlers.ts content at all", () => {
    expect(renderHandlers([{}, { app: [] }])).toBeNull();
    expect(runConventions(tmp({}), undefined, builtinConventions).files["handlers.ts"]).toBeUndefined();
  });
  it("two contributors for the same handler, duplicate names and clashing files are errors", () => {
    expect(() => renderHandlers([{ handlers: { queue: "a" } }, { handlers: { queue: "b" } }])).toThrow(/queue/);
    expect(() => runConventions(tmp({}), undefined, [...builtinConventions, builtinConventions[0]])).toThrow(/duplicate/);
    const clash = defineConvention({ name: "c", scan: () => 0, emit: () => ({ files: { "routes.ts": "x" } }) });
    expect(() => runConventions(tmp({}), undefined, [...builtinConventions, clash])).toThrow(/routes\.ts/);
  });
  it("later contributors see earlier entries", () => {
    let seen: unknown;
    const spy = defineConvention({ name: "spy", scan: () => 0, emit: (_e, ctx) => { seen = ctx.entries.api; return {}; } });
    runConventions(tmp({ "server/api/a.ts": "" }), undefined, [...builtinConventions, spy]);
    expect(seen).toEqual([{ file: "server/api/a.ts", mount: "/a" }]);
  });
  it("genApp compat wrapper matches the contributor pipeline", () => {
    const root = tmp({ "server/api/a.ts": "" });
    const g = runConventions(root, undefined, builtinConventions);
    expect(genApp(g.entries.api as never, [])).toBe(g.files["app.ts"]);
  });
});

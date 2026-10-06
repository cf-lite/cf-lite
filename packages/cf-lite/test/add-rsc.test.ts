import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { addExtra, dryRun, RSC_PINS, EXTRA_KINDS } from "../src/add-extras.js";
import { scanPages } from "../src/scan.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), "addrsc-"));
const put = (d: string, f: string, s: string) => { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), s); };
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");
const reactApp = (wrangler = `{\n  // keep me\n  "name": "a",\n  "main": "server/worker.ts",\n  "compatibility_date": "2026-09-01"\n}\n`) => {
  const d = tmp();
  put(d, "package.json", JSON.stringify({ name: "a", dependencies: { "cf-lite": "^0.4.0", "@cf-lite/react": "^0.4.0" } }, null, 2) + "\n");
  put(d, "vite.config.ts", `import { defineConfig } from "vite";\nimport cfLite from "cf-lite/vite";\nimport react from "@cf-lite/react";\n\nexport default defineConfig({ plugins: [cfLite({ renderer: react() })] });\n`);
  put(d, "wrangler.jsonc", wrangler);
  return d;
};

describe("cf-lite add rsc", () => {
  it("is a known extra kind", () => expect(EXTRA_KINDS).toContain("rsc"));
  it("pins equal examples/site-rsc/package.json", () => {
    const pj = JSON.parse(readFileSync(join(here, "../../../examples/site-rsc/package.json"), "utf8"));
    for (const [k, v] of Object.entries(RSC_PINS)) expect(pj.dependencies[k]).toBe(v);
  });
  it("adds pins, nodejs_compat (comments kept), page + layout + client component; doctor is clean; the page is an rsc route", () => {
    const d = reactApp();
    const r = addExtra(d, "rsc", { install: false });
    expect(r.changed.sort()).toEqual(["app/islands/counter.tsx", "app/routes/_layout.rsc.tsx", "app/routes/rsc.tsx", "package.json", "wrangler.jsonc"]);
    const pj = JSON.parse(read(d, "package.json"));
    for (const [k, v] of Object.entries(RSC_PINS)) expect(pj.dependencies[k]).toBe(v);
    expect(read(d, "wrangler.jsonc")).toContain("// keep me"); expect(read(d, "wrangler.jsonc")).toContain('"compatibility_flags": ["nodejs_compat"]');
    expect(doctor(d, { now: new Date("2026-09-30") }).filter((f) => /CFL01[45]/.test(f.code))).toEqual([]);
    const pages = scanPages(d, "app/routes", [".tsx"]);
    expect(pages.map((p) => [p.path, p.render])).toEqual([["/rsc", "rsc"]]);
    expect(pages[0].rscLayouts).toEqual(["app/routes/_layout.rsc.tsx"]);
    expect(read(d, "app/islands/counter.tsx").startsWith('"use client"')).toBe(true);
  });
  it("idempotent, never overwrites user files, dry-run matches and touches nothing", async () => {
    const d = reactApp();
    put(d, "app/routes/rsc.tsx", "// mine");
    const dry = await dryRun(d, (s) => { addExtra(s, "rsc", { install: false }); });
    expect(existsSync(join(d, "app/islands/counter.tsx"))).toBe(false);
    const r1 = addExtra(d, "rsc", { install: false });
    expect(read(d, "app/routes/rsc.tsx")).toBe("// mine");
    expect(dry.filter((l) => /^[+~] /.test(l)).map((l) => l.slice(2)).sort()).toEqual([...r1.changed].sort());
    expect(addExtra(d, "rsc", { install: false }).changed).toEqual([]);
  });
  it("merges nodejs_compat into existing flags; leaves nodejs_als / nodejs_compat alone", () => {
    const d = reactApp(`{ "name": "a", "compatibility_date": "2026-09-01", "compatibility_flags": ["global_fetch_strictly_public"] }`);
    addExtra(d, "rsc", { install: false });
    expect(read(d, "wrangler.jsonc")).toContain('"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"]');
    const e = reactApp(`{ "name": "a", "compatibility_flags": ["nodejs_als"] }`);
    addExtra(e, "rsc", { install: false });
    expect(read(e, "wrangler.jsonc")).toBe(`{ "name": "a", "compatibility_flags": ["nodejs_als"] }`);
  });
  it("refuses a non-React app (RSC is React-only)", () => {
    const d = reactApp();
    put(d, "vite.config.ts", `import cfLite from "cf-lite/vite";\nexport default { plugins: [cfLite()] };\n`);
    expect(() => addExtra(d, "rsc", { install: false })).toThrow(/React-only/);
    expect(existsSync(join(d, "app/routes/rsc.tsx"))).toBe(false);
  });
});

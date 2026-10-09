import { expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain mjs
import { scaffold } from "../index.mjs";

// inside the repo (not os.tmpdir) so the adapter packages resolve through the workspace links
const base = () => mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-"));
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");

it("none: minimal template with the project name, no UI framework, no build output", async () => {
  const dir = join(base(), "My_App");
  await scaffold(dir);
  expect(JSON.parse(read(dir, "package.json")).name).toBe("my-app");
  expect(read(dir, "wrangler.jsonc")).toContain('"name": "my-app"');
  for (const f of ["vite.config.ts", "server/worker.ts", "server/api/hello.ts", "index.html", "public/_redirects", ".gitignore"]) expect(existsSync(join(dir, f))).toBe(true);
  const deps = JSON.parse(read(dir, "package.json")).dependencies;
  expect(Object.keys(deps).sort()).toEqual(["cf-lite", "hono"]); // no react/react-dom
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
  await expect(scaffold(dir)).rejects.toThrow(/not empty/);
});

for (const ui of ["react", "preact", "vue", "svelte"]) {
  it(`--ui ${ui}: template + adapter wired (config, deps, entry, starter routes)`, async () => {
    const dir = join(base(), "app-" + ui);
    await scaffold(dir, { ui });
    expect(read(dir, "vite.config.ts")).toContain(`renderer: ${ui}()`);
    expect(JSON.parse(read(dir, "package.json")).dependencies[`@cf-lite/${ui}`]).toBeTruthy();
    expect(read(dir, "index.html")).toMatch(/src="\/app\/main\.(tsx|ts)"/);
    const ext = ui === "vue" ? "vue" : ui === "svelte" ? "svelte" : "tsx";
    expect(existsSync(join(dir, `app/routes/index.${ext}`))).toBe(true);
    expect(existsSync(join(dir, "app/main.ts")) && read(dir, "app/main.ts").includes("none-starter")).toBe(false); // none starter removed
  });
}

it("scaffolds from a template that lives under node_modules (the published-package layout)", async () => {
  const b = base();
  const tpl = join(b, "node_modules", "create-cf-lite", "template");
  cpSync(fileURLToPath(new URL("../template/", import.meta.url)), tpl, { recursive: true });
  const dir = join(b, "app");
  await scaffold(dir, { template: tpl });
  expect(existsSync(join(dir, ".gitignore"))).toBe(true);
  expect(existsSync(join(dir, "server/worker.ts"))).toBe(true);
});

it("--ui htmx: preset files + deps, renderer stays none, no adapter package", async () => {
  const dir = join(base(), "app-htmx");
  await scaffold(dir, { ui: "htmx" });
  expect(read(dir, "vite.config.ts")).toContain("cfLite()");
  const deps = JSON.parse(read(dir, "package.json")).dependencies;
  expect(Object.keys(deps).sort()).toEqual(["alpinejs", "cf-lite", "hono", "htmx.org"]);
  expect(read(dir, "index.html")).toContain('hx-get="/api/ui"');
  expect(existsSync(join(dir, "server/api/ui.ts"))).toBe(true);
  expect(read(dir, "app/main.ts")).not.toContain("none-starter");
});

it("worker name never starts/ends with a dash (wrangler rejects it)", async () => {
  const dir = join(base(), ".Weird__Name..");
  await scaffold(dir);
  expect(JSON.parse(read(dir, "package.json")).name).toBe("weird-name");
});

// ---- templates (WP-DX): every template scaffolds; overlay wins over the base; steps run; wrangler name/package name rewritten
import { readdirSync } from "node:fs";
for (const kind of ["blog", "saas", "api", "realtime", "ai-chat", "patterns"]) {
  it(`--template ${kind}: scaffolds with the project name, no stray template.json, doctor-clean`, async () => {
    const dir = join(base(), "My_" + kind);
    await scaffold(dir, { kind });
    const pj = JSON.parse(read(dir, "package.json"));
    expect(pj.name).toBe("my-" + kind);
    expect(JSON.stringify(pj)).not.toContain('"*"');
    expect(read(dir, "wrangler.jsonc")).toContain(`"name": "my-${kind}"`);
    expect(existsSync(join(dir, "template.json"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    const { doctor } = await import("cf-lite/doctor");
    expect(doctor(dir).filter((f: any) => f.level === "error" || f.code === "CFL005")).toEqual([]);
  });
}
it("--template saas: auth + queue steps ran; blog uses preact by default and --ui overrides", async () => {
  const saas = join(base(), "saas");
  await scaffold(saas, { kind: "saas" });
  for (const f of ["server/auth.ts", "server/api/auth.ts", "migrations/0001_auth.sql", "server/queues/emails.ts", "server/api/dashboard.ts"]) expect(existsSync(join(saas, f)), f).toBe(true);
  expect(read(saas, "wrangler.jsonc")).toMatch(/AUTH_DB/); expect(read(saas, "wrangler.jsonc")).toMatch(/emails/);
  const blog = join(base(), "blog");
  await scaffold(blog, { kind: "blog" });
  expect(read(blog, "vite.config.ts")).toContain("renderer: preact()");
  expect(existsSync(join(blog, "app/routes/posts/[slug]/index.tsx"))).toBe(true);
  const r = join(base(), "blog-react");
  await scaffold(r, { kind: "blog", ui: "react" });
  expect(read(r, "vite.config.ts")).toContain("renderer: react()");
});
it("--template patterns: react + pattern folders, states, preview setup, mocks, aliases and scripts", async () => {
  const d = join(base(), "pat");
  await scaffold(d, { kind: "patterns" });
  for (const f of ["app/patterns/atoms/Button/Button.tsx", "app/patterns/atoms/Button/Button.states.ts", "app/preview.setup.ts", "app/styles.css", "app/routes/index.tsx", "mocks/api/hello.json", "app/patterns/README.md"]) expect(existsSync(join(d, f)), f).toBe(true);
  expect(read(d, "vite.config.ts")).toContain("renderer: react()");
  expect(JSON.parse(read(d, "tsconfig.json")).compilerOptions.paths).toEqual({ "@/*": ["./app/*"], "@patterns/*": ["./app/patterns/*"] });
  expect(JSON.parse(read(d, "package.json")).scripts).toMatchObject({ "dev:mock": "MOCK=1 cf-lite dev", "patterns:export": "cfl export" });
  expect(read(d, "app/preview.setup.ts")).toContain('import "./styles.css"'); // the overlay's active setup file wins over the commented stub
});
it("unknown template is rejected; realtime keeps its DO files", async () => {
  await expect(scaffold(join(base(), "x"), { kind: "nope" })).rejects.toThrow(/unknown template/);
  const d = join(base(), "rt"); await scaffold(d, { kind: "realtime" });
  expect(readdirSync(join(d, "server/do"))).toContain("chat.ts");
});

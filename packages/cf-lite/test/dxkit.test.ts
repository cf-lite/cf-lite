import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPreview } from "../src/preview-scan.js";
import { defineStates } from "../src/preview.js";
import { parseMockFile, scanMocks } from "../src/mocks.js";
import { createMocks } from "../src/modules/mock.js";
import { createPreview, indexHtml } from "../src/modules/preview.js";
import { fragmentPath, normalizeHtml, planExport, readAssets, syncExport, type AssetsInfo } from "../src/export.js";
import { pathsToAliases, tsconfigAliases } from "../src/aliases.js";
import { addPatterns } from "../src/add-patterns.js";
import { previewConvention } from "../src/conventions/preview.js";
import { mocksConvention } from "../src/conventions/mocks.js";
import { generate } from "../src/vite.js";
import { doctor } from "../src/doctor.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "dxkit-")); tmps.push(d); return d; };
const put = (root: string, files: Record<string, string>) => { for (const [f, b] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), b); } return root; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("preview scan", () => {
  it("finds components + states, folder-per-component ids, groups, islands; skips routes/tests/lowercase", () => {
    const root = put(tmp(), {
      "app/patterns/atoms/Button/Button.tsx": "", "app/patterns/atoms/Button/Button.states.ts": "",
      "app/patterns/molecules/Card.tsx": "", // no states: still listed (rendered with no props)
      "app/components/Nav/index.tsx": "", "app/components/Nav/Nav.states.ts": "", // index.tsx sibling
      "app/islands/Counter.island.tsx": "", "app/islands/Counter.states.ts": "", // Stem.island sibling
      "app/routes/Page.tsx": "", "app/main.tsx": "", "app/components/Card.test.tsx": "", "app/components/helper.tsx": "", "app/_private/Hidden.tsx": "",
    });
    const got = scanPreview(root).map((e) => [e.id, e.group, e.file, e.states, e.island]);
    expect(got).toEqual([
      ["components/Nav", "components", "app/components/Nav/index.tsx", "app/components/Nav/Nav.states.ts", false],
      ["islands/Counter", "islands", "app/islands/Counter.island.tsx", "app/islands/Counter.states.ts", true],
      ["patterns/atoms/Button", "patterns/atoms", "app/patterns/atoms/Button/Button.tsx", "app/patterns/atoms/Button/Button.states.ts", false],
      ["patterns/molecules/Card", "patterns/molecules", "app/patterns/molecules/Card.tsx", undefined, false],
    ]);
  });
  it("a states file without a sibling is kept (it names the component itself); no app/ = empty", () => {
    expect(scanPreview(put(tmp(), { "app/x/Lonely.states.ts": "" })).map((e) => [e.id, e.file])).toEqual([["x/Lonely", undefined]]);
    expect(scanPreview(tmp())).toEqual([]);
  });
  it("vue extensions via the adapter list", () => {
    const root = put(tmp(), { "app/ui/Tag.vue": "", "app/ui/Tag.tsx": "" });
    expect(scanPreview(root, [".vue"]).map((e) => e.file)).toEqual(["app/ui/Tag.vue"]);
  });
  it("defineStates keeps the component and meta", () => {
    const C = (p: { a: number }) => p.a;
    const d = defineStates(C, { one: { a: 1 }, lazy: () => ({ a: 2 }) }, { title: "T" });
    expect(d.component).toBe(C);
    expect(d.title).toBe("T");
    expect(Object.keys(d.states)).toEqual(["one", "lazy"]);
  });
});

describe("mock files", () => {
  it.each([
    ["mocks/api/products.json", { method: "GET", pattern: "/api/products", kind: "json" }],
    ["mocks/api/products/[id].json", { method: "GET", pattern: "/api/products/:id", kind: "json" }],
    ["mocks/api/orders.post.json", { method: "POST", pattern: "/api/orders", kind: "json" }],
    ["mocks/api/search.ts", { method: "*", pattern: "/api/search", kind: "handler" }],
    ["mocks/api/index.json", { method: "GET", pattern: "/api", kind: "json" }],
    ["mocks/api/files/[...rest].json", { method: "GET", pattern: "/api/files/*", kind: "json" }],
    ["mocks/api.example.com/items.json", { method: "GET", host: "api.example.com", pattern: "/items", kind: "json" }],
    ["mocks/index.json", { method: "GET", pattern: "/", kind: "json" }],
  ])("%s", (f, want) => expect(parseMockFile(f)).toMatchObject(want));
  it("ignores helpers, d.ts and other extensions", () => {
    for (const f of ["mocks/_helpers.ts", "mocks/api/_x/y.json", "mocks/a.d.ts", "mocks/readme.md", "other/x.json"]) expect(parseMockFile(f)).toBeNull();
  });
  it("scan orders most-specific first and rejects duplicates", () => {
    const root = put(tmp(), { "mocks/api/[id].json": "1", "mocks/api/me.json": "{}", "mocks/api/[...all].json": "{}", "mocks/api/x.post.ts": "" });
    expect(scanMocks(root).map((m) => m.file)).toEqual(["mocks/api/me.json", "mocks/api/x.post.ts", "mocks/api/[id].json", "mocks/api/[...all].json"]);
    expect(() => scanMocks(put(tmp(), { "mocks/api/a.json": "{}", "mocks/api/a.get.json": "{}" }))).toThrow(/both mock GET \/api\/a/);
  });
});

describe("mock runtime", () => {
  const table = createMocks([
    { method: "GET", pattern: "/api/me", file: "mocks/api/me.json", json: { me: true } },
    { method: "GET", pattern: "/api/u/:id", file: "mocks/api/u/[id].ts", handler: ({ params, query }) => ({ id: params.id, q: query.q }) },
    { method: "POST", pattern: "/api/echo", file: "mocks/api/echo.post.ts", handler: ({ body }) => ({ body }) },
    { method: "*", pattern: "/api/teapot", file: "mocks/api/teapot.ts", handler: () => new Response("t", { status: 418 }) },
    { method: "GET", pattern: "/api/none", file: "mocks/api/none.ts", handler: () => undefined },
    { method: "GET", host: "ext.example.com", pattern: "/stock", file: "mocks/ext.example.com/stock.json", json: { n: 3 } },
  ]);
  const app = new Hono().use("*", (c, n) => table.middleware(c, n as never)).get("/api/real", (c) => c.text("real"));
  it("json + handler params/query/body, status passthrough, 204, header names the file", async () => {
    let r = await app.request("http://app.test/api/me");
    expect(await r.json()).toEqual({ me: true });
    expect(r.headers.get("x-cfl-mock")).toBe("mocks/api/me.json");
    expect(await (await app.request("http://app.test/api/u/7?q=z")).json()).toEqual({ id: "7", q: "z" });
    r = await app.request("http://app.test/api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    expect(await r.json()).toEqual({ body: { a: 1 } });
    expect((await app.request("http://app.test/api/teapot", { method: "DELETE" })).status).toBe(418);
    expect((await app.request("http://app.test/api/none")).status).toBe(204);
  });
  it("no match falls through to the real route; method must match; other-origin mocks do not answer here", async () => {
    expect(await (await app.request("http://app.test/api/real")).text()).toBe("real");
    expect((await app.request("http://app.test/api/me", { method: "POST" })).status).toBe(404);
    expect((await app.request("http://app.test/stock")).status).toBe(404);
  });
  it("fetch() interception: same origin + host folders are served, everything else reaches the real fetch", async () => {
    const real = vi.fn(async () => new Response("net"));
    const saved = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = real;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("cf-lite.mock-fetch")];
    try {
      await app.request("http://app.test/api/real"); // first request installs the wrapper
      expect(await (await fetch("http://app.test/api/me")).json()).toEqual({ me: true });
      expect(await (await fetch("https://ext.example.com/stock")).json()).toEqual({ n: 3 });
      expect(real).not.toHaveBeenCalled();
      expect(await (await fetch("https://other.example.com/api/me")).text()).toBe("net"); // same path, other origin: not ours
      expect(await (await fetch("http://app.test/api/real")).text()).toBe("net");
      expect(real).toHaveBeenCalledTimes(2);
    } finally { (globalThis as { fetch: unknown }).fetch = saved; delete (globalThis as Record<symbol, unknown>)[Symbol.for("cf-lite.mock-fetch")]; }
  });
});

describe("preview handler", () => {
  // a tiny "adapter": props -> string; enough to exercise routing, states, fragments, errors
  const ui = {
    bind: (C: unknown, props: Record<string, unknown>) => () => (C as (p: unknown) => string)(props),
    render: async (v: { Page: unknown }) => ({ body: (v.Page as () => string)() }),
  };
  const Btn = (p: { label?: string }) => `<button>${p.label ?? "none"}</button>`;
  const mk = (extra: Partial<Parameters<typeof createPreview>[0]> = {}) => {
    const h = createPreview({
      ui: ui as never,
      items: [
        { id: "atoms/Button", name: "Button", group: "atoms", island: false, load: async () => ({ default: Btn }), states: async () => ({ default: defineStates(Btn, { default: { label: "Save" }, "sold out": () => Promise.resolve({ label: "Gone" }) }) }) },
        { id: "atoms/Bare", name: "Bare", group: "atoms", island: false, load: async () => ({ default: Btn }) },
        { id: "atoms/Named", name: "Named", group: "atoms", island: false, states: async () => ({ states: { a: { label: "A" } }, component: Btn }) },
        { id: "atoms/Broken", name: "Broken", group: "atoms", island: false, states: async () => ({ default: { states: { x: {} } } }) }, // no component anywhere
        { id: "atoms/Throws", name: "Throws", group: "atoms", island: false, load: async () => ({ default: () => { throw new Error("boom"); } }) },
      ],
      ...extra,
    });
    return new Hono().use("/__preview", h).use("/__preview/*", h).get("/__preview/other", (c) => c.text("fell through"));
  };
  const env = { ASSETS: { fetch: async () => new Response('<html><head><title>shell</title><link rel="stylesheet" href="/s.css"><script type="module" src="/app/main.tsx"></script></head><body><div id="root"></div></body></html>') } };
  const get = (a: Hono, p: string) => a.request("http://x.test" + p, {}, env);

  it("index + manifest list components, states (declared names), errors, mocks", async () => {
    const a = mk();
    const html = await (await get(a, "/__preview")).text();
    expect(html).toContain("cf-lite preview"); expect(html).toContain("aria-pressed"); expect(html).toBe(indexHtml());
    expect((await get(a, "/__preview/")).status).toBe(200);
    const m = await (await get(a, "/__preview/api/manifest")).json() as { items: { id: string; states: string[]; error?: string }[]; adapterBind: boolean; viewports: unknown[] };
    expect(m.adapterBind).toBe(true);
    expect(m.viewports).toHaveLength(3);
    expect(m.items.find((i) => i.id === "atoms/Button")!.states).toEqual(["default", "sold out"]);
    expect(m.items.find((i) => i.id === "atoms/Bare")!.states).toEqual(["default"]);
    expect(m.items.find((i) => i.id === "atoms/Named")!.states).toEqual(["a"]);
    expect(m.items.find((i) => i.id === "atoms/Broken")!.error).toMatch(/no component/);
  });
  it("fragment = the component HTML only; async state props; unknown state/component 404; render error 500", async () => {
    const a = mk();
    expect(await (await get(a, "/__preview/frame/atoms/Button?s=default&fragment=1")).text()).toBe("<button>Save</button>\n");
    expect(await (await get(a, "/__preview/frame/atoms/Button?s=sold%20out&fragment=1")).text()).toBe("<button>Gone</button>\n");
    expect(await (await get(a, "/__preview/frame/atoms/Named?s=a&fragment=1")).text()).toBe("<button>A</button>\n");
    expect((await get(a, "/__preview/frame/atoms/Button?s=nope&fragment=1")).status).toBe(404);
    expect((await get(a, "/__preview/frame/nope/X")).status).toBe(404);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await get(a, "/__preview/frame/atoms/Throws?s=default&fragment=1");
    expect(r.status).toBe(500); expect(await r.text()).toContain("boom");
    expect(await (await get(a, "/__preview/frame/atoms/Throws?s=default")).text()).toContain("boom"); // full frame shows the stack
    vi.restoreAllMocks();
  });
  it("full frame = app shell (styles kept, entry script dropped) + setup + island runtime", async () => {
    const doc = await (await get(mk({ setup: "app/preview.setup.ts", islands: true }), "/__preview/frame/atoms/Button?s=default")).text();
    expect(doc).toContain('<div id="root" data-preview><button>Save</button></div>');
    expect(doc).toContain('href="/s.css"'); expect(doc).not.toContain("/app/main.tsx");
    expect(doc).toContain('src="/app/preview.setup.ts"'); expect(doc).toContain("virtual:cf-lite-islands"); expect(doc).toContain("cfl-island{display:contents}");
    const bare = await (await mk().request("http://x.test/__preview/frame/atoms/Button?s=default", {}, { ASSETS: { fetch: async () => new Response("") } })).text();
    expect(bare).toContain("<body><div id=\"root\" data-preview><button>Save</button>"); // no shell: bare document
  });
  it("other methods and unknown sub-paths fall through (draft mode owns /__preview/<page>)", async () => {
    const a = mk();
    expect(await (await get(a, "/__preview/other")).text()).toBe("fell through");
    expect((await a.request("http://x.test/__preview", { method: "POST" }, env)).status).toBe(404);
  });
  it("an adapter without bind() answers 501", async () => {
    const a = mk({ ui: { render: ui.render } as never });
    expect((await get(a, "/__preview/frame/atoms/Button?s=default")).status).toBe(501);
    expect((await (await get(a, "/__preview/api/manifest")).json() as { adapterBind: boolean }).adapterBind).toBe(false);
  });
});

describe("export", () => {
  const assets: AssetsInfo = { version: 1, source: null, css: [], js: [], islands: null };
  const items = [
    { id: "b/Two", name: "Two", group: "b", island: false, states: ["z", "a b"] },
    { id: "a/One", name: "One", group: "a", island: true, states: ["default"] },
  ];
  const frags = new Map([["a/One\0default", "<i>1</i>\r\n\r\n"], ["b/Two\0z", "<p>z</p>"], ["b/Two\0a b", "<p>ab</p>\n"]]);
  it("plan: sorted, normalised, hashed, no timestamps; fragment path is file-safe", () => {
    const p = planExport(items, frags, assets);
    expect([...p.keys()].sort()).toEqual(["a/One/default.html", "assets.json", "b/Two/a_b.html", "b/Two/z.html", "manifest.json"]);
    expect(p.get("a/One/default.html")).toBe("<i>1</i>\n");
    const m = JSON.parse(p.get("manifest.json")!);
    expect(m.components.map((c: { id: string }) => c.id)).toEqual(["a/One", "b/Two"]);
    expect(m.components[1].states.map((s: { name: string }) => s.name)).toEqual(["a b", "z"]);
    expect(m.components[0].states[0]).toMatchObject({ file: "a/One/default.html", bytes: 9 });
    expect(p.get("manifest.json")).not.toMatch(/\d{4}-\d\d-\d\dT|\/home\/|\\r/);
    expect(planExport(items, frags, assets)).toEqual(p); // deterministic
    expect(fragmentPath("x/Y", "a/b")).toBe("x/Y/a_b.html");
    expect(normalizeHtml("a\r\nb  \n\n")).toBe("a\nb\n");
  });
  it("two state names that collapse to one file are an error", () => {
    expect(() => planExport([{ id: "x/Y", name: "Y", group: "x", island: false, states: ["a b", "a_b"] }], new Map(), assets)).toThrow(/collide/);
  });
  it("sync: write, idempotent, stale removal (+empty dirs), --check reports", () => {
    const dir = join(tmp(), "out");
    const first = syncExport(dir, planExport(items, frags, assets));
    expect(first.written).toHaveLength(5);
    expect(syncExport(dir, planExport(items, frags, assets)).written).toEqual([]); // run twice: no change
    const fewer = planExport([items[1]!], frags, assets);
    const chk = syncExport(dir, fewer, true);
    expect(chk.stale.sort()).toEqual(["b/Two/a_b.html", "b/Two/z.html"]); expect(chk.changed).toContain("manifest.json");
    expect(existsSync(join(dir, "b/Two/z.html"))).toBe(true); // check never touches disk
    const done = syncExport(dir, fewer);
    expect(done.removed.sort()).toEqual(["b/Two/a_b.html", "b/Two/z.html"]);
    expect(existsSync(join(dir, "b"))).toBe(false); // empty folder gone
    writeFileSync(join(dir, "a/One/default.html"), "hand edit");
    expect(syncExport(dir, fewer, true).changed).toEqual(["a/One/default.html"]);
  });
  it("assets: lists css/js of dist/client + island runtime; none without a build", () => {
    const root = tmp();
    expect(readAssets(root)).toEqual(assets);
    put(root, { "dist/client/assets/b.js": "x", "dist/client/assets/a.css": "y", "dist/client/index.html": "", "dist/client/_islands.json": JSON.stringify({ runtime: "/assets/islands.js", preload: ["/assets/z.js", "/assets/c.js"] }) });
    const a = readAssets(root);
    expect(a.css.map((f) => f.file)).toEqual(["assets/a.css"]); expect(a.js.map((f) => f.file)).toEqual(["assets/b.js"]);
    expect(a.islands).toEqual({ runtime: "/assets/islands.js", preload: ["/assets/c.js", "/assets/z.js"] });
    expect(a.css[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("tsconfig aliases", () => {
  it("wildcards become prefix aliases, exact keys exact, first target wins", () => {
    const a = pathsToAliases({ "@/*": ["./app/*"], "@patterns/*": ["./app/patterns/*", "x/*"], "~env": ["./server/env"], "bad/*": ["./nowild"] }, "/proj");
    expect(a).toEqual([{ find: "@", replacement: "/proj/app" }, { find: "@patterns", replacement: "/proj/app/patterns" }, { find: /^~env$/, replacement: "/proj/server/env" }]);
  });
  it("reads tsconfig.json (comments ok, baseUrl honoured); nothing without paths", () => {
    expect(tsconfigAliases(put(tmp(), { "tsconfig.json": '{ // c\n "compilerOptions": { "baseUrl": "src", "paths": { "@/*": ["*"], }, }, }' }))).toEqual([{ find: "@", replacement: expect.stringMatching(/\/src$/) }]);
    expect(tsconfigAliases(put(tmp(), { "tsconfig.json": '{ "compilerOptions": {} }' }))).toEqual([]);
    expect(tsconfigAliases(tmp())).toEqual([]);
    expect(tsconfigAliases(put(tmp(), { "tsconfig.json": "not json" }))).toEqual([]);
  });
});

describe("add patterns", () => {
  const app = (ui: string) => put(tmp(), {
    "package.json": JSON.stringify({ name: "x", scripts: { dev: "cf-lite dev" } }),
    "vite.config.ts": `import ${ui} from "@cf-lite/${ui}";\nexport default defineConfig({ plugins: [cfLite({ renderer: ${ui}() })] });\n`,
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  });
  it("writes the starter once, wires scripts + tsconfig paths, never overwrites, second run = no change", () => {
    const d = app("react"); const log: string[] = [];
    addPatterns(d, (m) => log.push(m));
    for (const f of ["app/patterns/README.md", "app/patterns/atoms/Button/Button.tsx", "app/patterns/atoms/Button/Button.states.ts", "app/preview.setup.ts", "mocks/api/hello.json"]) expect(existsSync(join(d, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(d, "package.json"), "utf8")).scripts).toMatchObject({ dev: "cf-lite dev", "dev:mock": "MOCK=1 cf-lite dev", "patterns:export": "cfl export" });
    expect(JSON.parse(readFileSync(join(d, "tsconfig.json"), "utf8")).compilerOptions.paths).toEqual({ "@/*": ["./app/*"], "@patterns/*": ["./app/patterns/*"] });
    writeFileSync(join(d, "app/patterns/atoms/Button/Button.tsx"), "// mine");
    const snap = ["package.json", "tsconfig.json"].map((f) => readFileSync(join(d, f), "utf8"));
    const log2: string[] = [];
    addPatterns(d, (m) => log2.push(m));
    expect(readFileSync(join(d, "app/patterns/atoms/Button/Button.tsx"), "utf8")).toBe("// mine");
    expect(["package.json", "tsconfig.json"].map((f) => readFileSync(join(d, f), "utf8"))).toEqual(snap);
    expect(log2.filter((l) => /create|edit/.test(l))).toEqual([]);
  });
  it("vue gets an SFC; no adapter / svelte is refused with the fix", () => {
    const d = app("vue"); addPatterns(d);
    expect(existsSync(join(d, "app/patterns/atoms/Button/Button.vue"))).toBe(true);
    expect(readFileSync(join(d, "app/patterns/atoms/Button/Button.states.ts"), "utf8")).toContain('./Button.vue');
    expect(() => addPatterns(app("svelte"))).toThrow(/cf-lite add react/);
    expect(() => addPatterns(tmp())).toThrow(/no package.json/);
  });
  it("a tsconfig with comments is left alone with the lines to add", () => {
    const d = app("react"); writeFileSync(join(d, "tsconfig.json"), '{ // hi\n "compilerOptions": {} }');
    const log: string[] = []; addPatterns(d, (m) => log.push(m));
    expect(log.join("\n")).toContain("tsconfig.json has comments");
  });
});

describe("conventions (generated code)", () => {
  const fakeAdapter = { id: "@cf-lite/react", extensions: [".tsx"], client: "c", server: "@cf-lite/react/server", vite: () => ({ plugins: [] }) } as never;
  it("nothing to preview / no mocks / no adapter = no generated files and no app.ts change", () => {
    const root = tmp();
    const g = generate(root, fakeAdapter);
    expect(g.files["preview.ts"]).toBeUndefined(); expect(g.files["mocks.ts"]).toBeUndefined();
    expect(g.files["app.ts"]).not.toMatch(/__preview|mockGate/);
    expect(g.devWorkerFirst).toEqual([]);
    put(root, { "app/Card.tsx": "" });
    expect(generate(root).files["preview.ts"]).toBeUndefined(); // no adapter
  });
  it("preview: dev-gated import, dev-only worker-first glob, nothing in workerFirst", () => {
    const root = put(tmp(), { "app/patterns/Card/Card.tsx": "", "app/patterns/Card/Card.states.ts": "", "app/preview.setup.ts": "" });
    const g = generate(root, fakeAdapter);
    expect(g.files["preview.ts"]).toContain('import("../app/patterns/Card/Card.states")');
    expect(g.files["preview.ts"]).toContain('setup: "app/preview.setup.ts"');
    expect(g.files["preview.ts"]).not.toContain("mocks:");
    expect(g.files["app.ts"]).toContain('.use("/__preview", previewGate)');
    expect(g.files["app.ts"]).toMatch(/env\.DEV\) return \(await import\("\.\/preview"\)\)/);
    expect(g.devWorkerFirst).toEqual(["/__preview", "/__preview/*"]);
    expect(g.workerFirst).not.toContain("/__preview"); // production run_worker_first is untouched
    expect(previewConvention.name).toBe("preview");
  });
  it("mocks: inlined JSON, handler imports, gated on DEV and MOCK; invalid JSON names the file", () => {
    const root = put(tmp(), { "mocks/api/a.json": '{"x":1}', "mocks/api/h.ts": "export default () => 1", "mocks/h.example.com/s.json": "[1]" });
    const g = generate(root, fakeAdapter);
    const f = g.files["mocks.ts"]!;
    expect(f).toContain('import m0 from "../mocks/api/a.json"'); expect(f).toContain("json: m0"); expect(f).toContain('import * as m'); expect(f).toContain('host: "h.example.com"');
    expect(g.files["app.ts"]).toMatch(/env\.DEV && __CFL_MOCK__\) return \(await import\("\.\/mocks"\)\)/);
    expect(g.files["app.ts"].indexOf("mockGate)")).toBeGreaterThan(-1);
    expect(mocksConvention.name).toBe("mocks");
    put(root, { "mocks/api/bad.json": "{nope" });
    expect(() => generate(root, fakeAdapter)).toThrow(/mocks\/api\/bad.json is not valid JSON/);
  });
  it("preview lists mocks for the manifest when a mocks/ folder exists", () => {
    const root = put(tmp(), { "app/A.tsx": "", "mocks/a.json": "{}" });
    expect(generate(root, fakeAdapter).files["preview.ts"]).toContain('mocks: () => import("./mocks")');
  });
});

describe("doctor CFL018 + bin alias", () => {
  const built = (js: string) => {
    const d = put(tmp(), { "wrangler.jsonc": `{ "name": "x", "main": "server/worker.ts", "compatibility_date": "2026-09-01", "assets": { "run_worker_first": ["/api/*"] } }`, ".wrangler/deploy/config.json": JSON.stringify({ configPath: "../../dist/w/wrangler.json" }), "dist/w/wrangler.json": JSON.stringify({ main: "index.js" }), "dist/w/index.js": js });
    return doctor(d, { now: new Date("2026-09-30") }).filter((f) => f.code === "CFL018");
  };
  it("flags a Worker that contains the preview runtime or the mock layer; clean builds and un-built apps pass", () => {
    expect(built("export default {}")).toEqual([]);
    const f = built('console.error("preview render error")');
    expect(f).toHaveLength(1); expect(f[0]!.level).toBe("error"); expect(f[0]!.message).toContain("/__preview");
    expect(built('Symbol.for("cf-lite.mock-fetch")')[0]!.message).toContain("mocks");
    expect(doctor(put(tmp(), { "wrangler.jsonc": "{}" })).filter((x) => x.code === "CFL018")).toEqual([]);
  });
  it("`cfl` is a second bin entry next to `cf-lite`, and the new modules are exported", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.bin).toEqual({ "cf-lite": "./dist/cli.js", cfl: "./dist/cli.js" });
    expect(pkg.exports["./preview"].default).toBe("./dist/preview.js");
    expect(pkg.exports["./modules/*"]).toBeTruthy();
  });
});

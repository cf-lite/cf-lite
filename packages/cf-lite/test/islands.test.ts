import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProps, MAX_PROPS_BYTES, WARN_PROPS_BYTES } from "../src/islands.js";
import { islandIds, islandPreloads, islandsRoute, islandTail } from "../src/islands-server.js";
import { findIslandFiles, islandId, wrapIsland, islandTransform, islandsBuild } from "../src/vite-islands.js";
import { doctor, oversizedIslandProps } from "../src/doctor.js";
import { pagesConvention } from "../src/conventions/pages.js";
import type { UiAdapter } from "../src/adapter.js";

describe("encodeProps", () => {
  it("plain JSON round-trips; empty props omit the attribute", () => {
    expect(JSON.parse(encodeProps("a", { n: 1, s: "x", b: true, z: null, arr: [1, { y: 2 }], o: { k: "v" }, u: undefined })!)).toEqual({ n: 1, s: "x", b: true, z: null, arr: [1, { y: 2 }], o: { k: "v" } });
    expect(encodeProps("a", {})).toBeUndefined();
    expect(encodeProps("a", { u: undefined })).toBeUndefined();
  });
  it.each([
    ["function", { f: () => 1 }, /prop props\.f is a function/],
    ["Date", { d: new Date() }, /props\.d is a Date object/],
    ["Map", { m: new Map() }, /Map object/],
    ["bigint", { b: 1n }, /bigint/],
    ["symbol", { s: Symbol("x") }, /symbol/],
    ["NaN", { n: NaN }, /NaN/],
    ["Infinity in array", { a: [Infinity] }, /props\.a\[0\] is Infinity/],
    ["React element", { e: { $$typeof: Symbol.for("react.element") } }, /React element/],
    ["class instance", { c: new (class Foo {})() }, /Foo object/],
    ["children", { children: "x" }, /cannot take `children`/],
  ])("rejects %s with the island id and path", (_n, props, re) => {
    expect(() => encodeProps("app/islands/X", props as never)).toThrow(re);
    expect(() => encodeProps("app/islands/X", props as never)).toThrow(/app\/islands\/X/);
  });
  it("accepts null-prototype objects; size guard throws above the limit, dev warns above the soft limit", () => {
    expect(encodeProps("a", { o: Object.assign(Object.create(null), { k: 1 }) })).toBe('{"o":{"k":1}}');
    expect(() => encodeProps("big", { s: "x".repeat(MAX_PROPS_BYTES) })).toThrow(/limit 65536/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(encodeProps("mid", { s: "x".repeat(WARN_PROPS_BYTES + 1) })!.length).toBeGreaterThan(WARN_PROPS_BYTES); // vitest sets import.meta.env.DEV
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('island "mid"'));
    warn.mockRestore();
  });
});

describe("islandsRoute", () => {
  const html = (body: string, chunks?: string[]) => new Response(new ReadableStream({ start(c) { for (const x of chunks ?? [body]) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), { headers: { "content-type": "text/html; charset=utf-8", "content-length": "99" } });
  const run = async (res: () => Response, o: { hydrate: boolean }, assets?: (u: string) => Response, nonce?: string) => {
    const app = new Hono<any>();
    app.use("*", async (c, n) => { if (nonce) c.set("cspNonce", nonce); await n(); });
    app.get("/", islandsRoute((async () => res()) as never, { dev: false, ...o }) as never);
    const env = { ASSETS: { fetch: async (r: URL) => (assets ? assets(r.pathname) : new Response("nf", { status: 404 })) } };
    const r = await app.request("/", {}, env);
    return { r, text: await r.text() };
  };
  const manifest = (u: string) => (u === "/_islands.json" ? new Response('{"runtime":"/assets/islands-abc.js"}', { headers: { "content-type": "application/json" } }) : new Response("nf", { status: 404 }));

  it("inserts style + runtime script before </body> when the page has an island, drops content-length", async () => {
    // module-level runtime cache: the first call in this file decides it, so this test must be the first to ask
    const { r, text } = await run(() => html('<body><cfl-island data-i="x"></cfl-island></body></html>'), { hydrate: false }, manifest);
    expect(text).toBe('<body><cfl-island data-i="x"></cfl-island><style>cfl-island{display:contents}</style><script type="module" src="/assets/islands-abc.js"></script></body></html>');
    expect(r.headers.get("content-length")).toBeNull();
  });
  it("marker split across chunks is found; nonce goes on both tags; hydrate=true gets the style only", async () => {
    const { text } = await run(() => html("", ["<main><cfl-isl", 'and data-i="x"></cfl-island></main></bo', "dy></html>"]), { hydrate: false }, manifest, "N0NCE");
    expect(text).toContain('<style nonce="N0NCE">');
    expect(text).toContain('<script type="module" src="/assets/islands-abc.js" nonce="N0NCE"></script></body>'.replace("</body>", "") + "");
    const h = await run(() => html('<body><cfl-island data-i="x"></cfl-island></body>'), { hydrate: true }, manifest);
    expect(h.text).toBe('<body><cfl-island data-i="x"></cfl-island><style>cfl-island{display:contents}</style></body>');
  });
  it("adds modulepreload hints for the runtime closure and the load islands rendered on the page (tag split across chunks)", async () => {
    const mf = (u: string) => (u === "/_islands.json" ? new Response(JSON.stringify({ runtime: "/assets/islands-abc.js", preload: ["/assets/fw.js"], islands: { x: { w: "load", deps: ["/assets/x.js"] }, y: { w: "load", deps: ["/assets/y.js"] }, z: { w: "idle", deps: ["/assets/z.js"] } } }), { headers: { "content-type": "application/json" } }) : new Response("nf", { status: 404 }));
    // cached runtime from the first test wins in-process, so exercise the pure parts through a fresh module instance
    vi.resetModules();
    const fresh = await import("../src/islands-server.js");
    const app = new Hono<any>();
    app.get("/", fresh.islandsRoute((async () => html("", ["<body><cfl-island da", 'ta-i="x" data-p="{}"></cfl-island><cfl-island data-i="z" data-w="idle"></cfl-island></body>', "</html>"])) as never, { dev: false, hydrate: false }) as never);
    const text = await (await app.request("/", {}, { ASSETS: { fetch: async (r: URL) => mf(r.pathname) } })).text();
    expect(text).toContain('<link rel="modulepreload" href="/assets/fw.js"><link rel="modulepreload" href="/assets/x.js"><script type="module" src="/assets/islands-abc.js"></script></body>');
    expect(text).not.toContain("y.js");
    expect(text).not.toContain("z.js");
  });
  it("appends the tail at the end of the stream when there is no </body>", async () => {
    const { text } = await run(() => html("<cfl-island data-i=x></cfl-island>"), { hydrate: true });
    expect(text).toBe("<cfl-island data-i=x></cfl-island><style>cfl-island{display:contents}</style>");
  });
  it("pages without islands, non-HTML and bodiless responses pass through untouched", async () => {
    const plain = '<body><p>no islands</p></body>';
    expect((await run(() => html(plain), { hydrate: false }, manifest)).text).toBe(plain);
    const json = await run(() => new Response('{"a":"<cfl-island"}', { headers: { "content-type": "application/json" } }), { hydrate: false }, manifest);
    expect(json.text).toBe('{"a":"<cfl-island"}');
    const redirect = await run(() => new Response(null, { status: 302, headers: { location: "/x", "content-type": "text/html" } }), { hydrate: false });
    expect(redirect.r.status).toBe(302);
  });
  it("islandPreloads: runtime closure + deps of the load islands the page rendered; older manifests give none", () => {
    const m = { runtime: "/r.js", preload: ["/fw.js"], islands: { a: { w: "load", deps: ["/a.js"] }, b: { w: "idle", deps: ["/b.js"] }, c: { w: "load", deps: ["/fw.js", "/c.js"] } } };
    expect(islandPreloads(m, ["a", "b", "zz"])).toEqual(["/fw.js", "/a.js"]);
    expect(islandPreloads(m, [])).toEqual(["/fw.js"]);
    expect(islandPreloads(m, ["a", "c"])).toEqual(["/fw.js", "/a.js", "/c.js"]);
    expect(islandPreloads({ runtime: "/r.js" }, ["a"])).toEqual([]);
    expect(islandPreloads(null, ["a"])).toEqual([]);
    expect(islandIds('<p><cfl-island data-i="a/B" data-p="{&quot;x&quot;:1}"></cfl-island><cfl-island data-w="idle" data-i="c"></cfl-island>')).toEqual(["a/B", "c"]);
  });
  it("islandTail puts modulepreload hints (nonced) before the runtime script, none without a runtime", () => {
    expect(islandTail("/r.js", "N", ["/a.js"])).toBe('<style nonce="N">cfl-island{display:contents}</style><link rel="modulepreload" href="/a.js" nonce="N"><script type="module" src="/r.js" nonce="N"></script>');
    expect(islandTail(null, undefined, ["/a.js"])).toBe("<style>cfl-island{display:contents}</style>");
  });
  it("islandTail without a manifest is style only", () => {
    expect(islandTail(null)).toBe("<style>cfl-island{display:contents}</style>");
  });
});

describe("wrapIsland", () => {
  const W = "@cf-lite/react/islands";
  const w = (code: string, f = "a/B.island.tsx") => wrapIsland(code, f, "a/B", W);
  it("named function declaration: kept in place, default export re-wrapped", () => {
    const out = w("export default function B({ x }: { x: number }) { return <i>{x}</i>; }");
    expect(out).toContain(`import { island as __cflWrap } from "@cf-lite/react/islands";`);
    expect(out).toContain("function B({ x }");
    expect(out).not.toContain("export default function");
    expect(out).toContain('export default __cflWrap(B, "a/B", "load");');
  });
  it("anonymous function, arrow, class and identifier defaults", () => {
    expect(w("export default function () { return null; }")).toMatch(/const __cflInner = function \(\) \{ return null; \};/);
    expect(w("export default () => <b />;")).toMatch(/const __cflInner = \(\) => <b \/>;;?/);
    expect(w("class K {}\nexport default K;")).toContain("const __cflInner = K;");
    expect(w("export default class Foo {}")).toContain("export default __cflWrap(Foo,");
    expect(w("import { memo } from 'react';\nconst C = () => null;\nexport default memo(C);")).toContain("const __cflInner = memo(C);");
  });
  it("reads `export const client`, rejects unknown strategies and files with no default export", () => {
    expect(w('export const client = "visible";\nexport default function B() { return null; }')).toContain('"visible");');
    expect(w("export const client = 'idle';\nexport default function B() { return null; }")).toContain('"idle");');
    expect(() => w('export const client = "soon";\nexport default function B() { return null; }')).toThrow(/expected "load" \| "idle"/);
    expect(() => w("export const B = () => null;")).toThrow(/must `export default`/);
  });
  it("jsx files parse as jsx", () => { expect(wrapIsland("export default function B() { return <i />; }", "B.island.jsx", "B", W)).toContain("__cflWrap(B"); });
});

const adapter = { id: "x", extensions: [".tsx"], client: "c", server: "s", islands: { wrap: "w/islands", mount: "w/mount" }, vite: () => ({ plugins: [] }) } as UiAdapter;
const tmp = () => mkdtempSync(join(tmpdir(), "cfl-isl-"));

describe("findIslandFiles / islandId", () => {
  it("finds *.island.tsx|jsx, skips node_modules, dot dirs and dist; ids are root-relative", () => {
    const d = tmp();
    for (const f of ["app/islands/A.island.tsx", "app/B.island.jsx", "node_modules/p/C.island.tsx", ".cf-lite/D.island.tsx", "dist/E.island.tsx", "app/F.tsx", "app/G.island.ts"]) { mkdirSync(join(d, f, ".."), { recursive: true }); writeFileSync(join(d, f), ""); }
    const found = findIslandFiles(d);
    expect(found.map((f) => f.slice(d.length + 1))).toEqual(["app/B.island.jsx", "app/islands/A.island.tsx"]);
    expect(islandId(d, found[1]!)).toBe("app/islands/A");
    expect(findIslandFiles(join(d, "nope"))).toEqual([]);
  });
});

describe("vite plugins", () => {
  it("islandTransform rewrites island files only (any query, inside the root, not node_modules)", () => {
    const root = "/proj";
    const p = islandTransform(root, adapter) as any;
    const code = "export default function A() { return null; }";
    expect(p.transform(code, "/proj/app/A.island.tsx?x=1").code).toContain('import { island as __cflWrap } from "w/islands"');
    expect(p.transform(code, "/proj/app/A.tsx")).toBeNull();
    expect(p.transform(code, "/other/A.island.tsx")).toBeNull();
    expect(p.transform(code, "/proj/node_modules/x/A.island.tsx")).toBeNull();
  });
  it("islandsBuild: client entry, virtual runtime module, preact/compat resolution, manifest asset", async () => {
    const root = "/proj";
    const mk = (rt: "react" | "preact") => islandsBuild(root, adapter, ["/proj/app/A.island.tsx", "/proj/app/B.island.tsx"], rt) as any;
    const p = mk("react");
    p.configResolved({ base: "/b/" });
    expect(p.configEnvironment("ssr")).toBeUndefined();
    expect(p.configEnvironment("client").build.rollupOptions.input).toEqual({ index: "/proj/index.html", islands: "virtual:cf-lite-islands" });
    const id = await p.resolveId.call({ environment: { name: "client" } }, "virtual:cf-lite-islands");
    expect(id).toBe("\0virtual:cf-lite-islands");
    expect(p.load("other")).toBeNull();
    const src = p.load(id);
    expect(src).toContain('import { start } from "cf-lite/islands-client";');
    expect(src).toContain('import { mount } from "w/mount";');
    expect(src).toContain('"app/A": () => import("/proj/app/A.island.tsx"),');
    // react runtime: bare imports untouched
    expect(await p.resolveId.call({ environment: { name: "client" } }, "react", "/x")).toBeNull();
    // preact runtime: react -> preact/compat, only in the client environment
    const q = mk("preact");
    const resolve = vi.fn(async (to: string) => ({ id: "/resolved/" + to }));
    expect(await q.resolveId.call({ environment: { name: "client" }, resolve }, "react-dom/client", "/x", {})).toEqual({ id: "/resolved/preact/compat/client" });
    expect(await q.resolveId.call({ environment: { name: "client" }, resolve }, "lodash", "/x", {})).toBeNull();
    expect(await q.resolveId.call({ environment: { name: "ssr" }, resolve }, "react", "/x", {})).toBeNull();
    // manifest
    const emitted: any[] = [];
    const bundle = { "assets/islands-h.js": { type: "chunk", isEntry: true, name: "islands", fileName: "assets/islands-h.js", imports: [] }, "assets/x.js": { type: "chunk", isEntry: false, name: "islands", fileName: "assets/x.js", imports: [] } };
    p.generateBundle.call({ environment: { name: "ssr" }, emitFile: (f: any) => emitted.push(f) }, {}, bundle);
    expect(emitted).toEqual([]);
    p.generateBundle.call({ environment: { name: "client" }, emitFile: (f: any) => emitted.push(f) }, {}, bundle);
    expect(emitted[0].fileName).toBe("_islands.json");
    expect(JSON.parse(emitted[0].source)).toEqual({ runtime: "/b/assets/islands-h.js", preload: [], islands: {} });
    p.generateBundle.call({ environment: { name: "client" }, emitFile: (f: any) => emitted.push(f) }, {}, {});
    expect(emitted.length).toBe(1);
  });
});

describe("pages convention + islands", () => {
  const page = (render: "ssr" | "static") => ({ path: "/", file: "app/routes/index.tsx", render, hydrate: false, layouts: [] }) as never;
  const emit = (root: string, ad: UiAdapter | undefined) => pagesConvention.emit([page("ssr")], { root, adapter: ad, entries: {} } as never);
  it("wraps SSR handlers with islandsRoute only for apps with island files", () => {
    const d = tmp(); mkdirSync(join(d, "app"), { recursive: true });
    expect((emit(d, adapter).app ?? []).join("")).not.toContain("islandsRoute");
    writeFileSync(join(d, "app/A.island.tsx"), "");
    const e = emit(d, adapter);
    expect(e.preImports).toContain('import { islandsRoute } from "cf-lite/islands-server";');
    expect(e.app!.join("")).toContain("islandsRoute(ssr(s0 as never, { ui, hydrate: false");
    expect(emit(d, { ...adapter, islands: undefined } as UiAdapter).app!.join("")).not.toContain("islandsRoute"); // adapter without islands support
  });
});

describe("doctor CFL017", () => {
  const build = (props: string) => {
    const d = tmp();
    writeFileSync(join(d, "wrangler.jsonc"), JSON.stringify({ name: "x", main: "w.ts", compatibility_date: new Date().toISOString().slice(0, 10) }));
    mkdirSync(join(d, "dist/client/blog"), { recursive: true }); mkdirSync(join(d, "dist/client/assets"), { recursive: true });
    writeFileSync(join(d, "dist/client/blog/index.html"), `<cfl-island data-i="app/islands/Big" data-p="${props}"><b></b></cfl-island><cfl-island data-i="app/islands/Small" data-p="{&quot;a&quot;:1}"></cfl-island><cfl-island data-i="app/islands/None"></cfl-island>`);
    writeFileSync(join(d, "dist/client/assets/skip.html"), `<cfl-island data-i="z" data-p="${props}">`);
    return d;
  };
  it("warns for props over 8 KiB in built pages (and only those)", () => {
    const d = build("{&quot;s&quot;:&quot;" + "x".repeat(9000) + "&quot;}");
    const o = oversizedIslandProps(d);
    expect(o.map((x) => [x.file, x.id])).toEqual([["blog/index.html", "app/islands/Big"]]);
    const f = doctor(d).filter((x) => x.code === "CFL017");
    expect(f.length).toBe(1);
    expect(f[0]!.message).toMatch(/Big.*blog\/index\.html.*bytes of props/);
  });
  it("small props and apps without a build are clean", () => {
    expect(doctor(build("{&quot;a&quot;:1}")).filter((x) => x.code === "CFL017")).toEqual([]);
    expect(oversizedIslandProps(tmp())).toEqual([]);
  });
});

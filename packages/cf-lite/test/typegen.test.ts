import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { href } from "../src/href.js";
import { patternToTemplate, paramsType, renderRoutesDts } from "../src/conventions/typegen.js";
import { scanHandlers, scanPages } from "../src/scan.js";
import { envTypesArgs, syncEnvTypes } from "../src/cli-types.js";
import type { Wrangler } from "../src/cli-deploy.js";

function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cflite-typegen-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), c); }
  return root;
}

describe("href() runtime", () => {
  it("fills :params, encodes, handles catch-alls, query and hash", () => {
    expect(href("/blog/:slug" as never, { slug: "a b/c" } as never)).toBe("/blog/a%20b%2Fc");
    expect(href("/docs/*?" as never, { "*": "a/b c" } as never)).toBe("/docs/a/b%20c");
    expect(href("/docs/*?" as never)).toBe("/docs");
    expect(href("/" as never, undefined as never, { query: { q: "x y", t: ["1", "2"], skip: undefined }, hash: "top" } as never)).toBe("/?q=x+y&t=1&t=2#top");
  });
  it("throws on a missing required param", () => {
    expect(() => href("/blog/:slug" as never, {} as never)).toThrow(/missing param "slug"/);
    expect(() => href("/docs/*" as never, {} as never)).toThrow(/missing param "\*"/);
  });
});

describe("codegen helpers", () => {
  it("paramsType", () => {
    expect(paramsType("/")).toBe("{}");
    expect(paramsType("/a/:x/b/:y")).toBe('{ "x": string; "y": string }');
    expect(paramsType("/docs/*")).toBe('{ "*": string }');
    expect(paramsType("/docs/*?")).toBe('{ "*"?: string }');
  });
  it("patternToTemplate", () => {
    expect(patternToTemplate("/")).toEqual(['"/"']);
    expect(patternToTemplate("/a/:x")).toEqual(["`/a/${string}`"]);
    expect(patternToTemplate("/docs/*?")).toEqual(["`/docs`", "`/docs/${string}`"]);
    expect(patternToTemplate("/*?")).toEqual(['"/"', "`/${string}`"]);
  });
  it("no routes -> no file", () => expect(renderRoutesDts([], [])).toBeNull());
});

// ---- compile-fail fixtures: a real tsc program over a generated typed-routes.d.ts --------------------------------------------------------------
const ADAPTERS = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const SRC = resolve(dirname(new URL(import.meta.url).pathname), "../src");
function typecheck(root: string, files: Record<string, string>): Record<string, string[]> {
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  const opts: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: false,
    jsx: ts.JsxEmit.ReactJSX, types: [], baseUrl: root, paths: { "cf-lite/href": [join(SRC, "href.ts")] }, allowImportingTsExtensions: true,
  };
  const program = ts.createProgram([join(root, ".cf-lite/typed-routes.d.ts"), ...Object.keys(files).map((f) => join(root, f))], opts);
  const out: Record<string, string[]> = {};
  for (const f of Object.keys(files)) out[f] = ts.getPreEmitDiagnostics(program, program.getSourceFile(join(root, f))).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  return out;
}

describe("typed routes: tsc fixtures", () => {
  const root = project({
    "app/routes/index.tsx": "export default function P() { return null; }",
    "app/routes/blog/[slug].tsx": `import { fail } from "${join(SRC, "modules/actions.ts")}";
export const render = "ssr";
export async function loader() { return { title: "t", n: 1 }; }
export const actions = { save: async () => fail(422, { errors: ["bad"] }), ok: async () => ({ saved: true }) };
export default function P(_: PageProps<"/blog/:slug">) { return null; }
import type { PageProps } from "cf-lite/href";
export const probe = (p: PageProps<"/blog/:slug">) => { const t: string = p.data.title; return t; };`,
    "app/routes/docs/[[...slug]].tsx": "export default function P() { return null; }",
    "app/routes/list.tsx": "export async function loader() { return [1, 2, 3]; }\nexport default function P() { return null; }",
    "server/routes/feed.xml.ts": "export default {};",
  });
  const pages = scanPages(root, "app/routes", [".tsx"]);
  const dts = renderRoutesDts(pages, scanHandlers(root))!;
  mkdirSync(join(root, ".cf-lite"), { recursive: true });
  writeFileSync(join(root, ".cf-lite/typed-routes.d.ts"), dts);

  it("the generated table lists every route with its params", () => {
    expect(dts).toContain('"/blog/:slug": { "slug": string };');
    expect(dts).toContain('"/docs/*?": { "*"?: string };');
    expect(dts).toContain('"/feed.xml": {};');
    expect(dts).toContain('"/blog/:slug": { loader: typeof import("../app/routes/blog/[slug]")["loader"]; actions: typeof import("../app/routes/blog/[slug]")["actions"] };');
  });

  const diag = typecheck(root, {
    "ok.ts": `import { href, type InferData, type InferActionData, type PageProps, type LinkTo } from "cf-lite/href";
import type * as Blog from "./app/routes/blog/[slug]";
import type * as List from "./app/routes/list";
export const a: string = href("/");
export const b: string = href("/blog/:slug", { slug: "x" });
export const c: string = href("/docs/*?");
export const d: string = href("/docs/*?", { "*": "a/b" }, { query: { q: 1 }, hash: "h" });
export const e: string = href("/feed.xml");
export const l1: LinkTo = "/blog/hello"; export const l2: LinkTo = "/docs"; export const l3: LinkTo = "/docs/a/b?x=1#y"; export const l4: LinkTo = "https://x.dev"; export const l5: LinkTo = href("/");
export const data: InferData<typeof Blog> = { title: "t", n: 1 };
export const arr: InferData<typeof List> = [1];
export const act: InferActionData<typeof Blog> = { errors: ["bad"] };
export const act2: InferActionData<typeof Blog> = { saved: true };
export const p: PageProps<"/blog/:slug"> = { params: { slug: "x" }, data: { title: "t", n: 1 } };
export const p2: PageProps<"/list"> = { params: {}, data: { data: [1, 2] } };`,
    "ok-hooks.ts": `import { href, type UseParams, type Navigate } from "cf-lite/href";
declare const useParams: UseParams; declare const navigate: Navigate;
export const s: string = useParams("/blog/:slug").slug;
export const rest: string | undefined = useParams("/docs/*?")["*"];
export const any: Record<string, string> = useParams();
navigate("/blog/hello"); navigate("/docs/a/b?x=1", true); navigate(href("/blog/:slug", { slug: "x" })); navigate("https://x.dev");`,
    // the real adapter sources (vue / solid client.ts; svelte's ambient Link.svelte declaration), compiled against the generated route table
    "ok-adapters.ts": `import { useParams as vueParams, navigate as vueNavigate } from "${join(ADAPTERS, "vue/src/client.ts")}";
import { useParams as solidParams, navigate as solidNavigate } from "${join(ADAPTERS, "solid/src/client.ts")}";
import { navigate as svelteNavigate } from "${join(ADAPTERS, "svelte/src/client.ts")}";
import Link from "@cf-lite/svelte/Link.svelte";
import type { ComponentProps } from "svelte";
export const v: string = vueParams("/blog/:slug").value.slug;
export const va: Record<string, string> = vueParams().value;
export const s: string = solidParams("/blog/:slug").slug;
export const sa: Record<string, string> = solidParams();
vueNavigate("/blog/hello"); solidNavigate("/docs/a", true); svelteNavigate("/list");
export const lp: ComponentProps<typeof Link> = { to: "/blog/hello" };`,
    "svelte-env.d.ts": readFileSync(join(ADAPTERS, "svelte/env.d.ts"), "utf8"),
    "bad-vue-useparams.ts": `import { useParams } from "${join(ADAPTERS, "vue/src/client.ts")}"; useParams("/nope");`,
    "bad-vue-useparams-key.ts": `import { useParams } from "${join(ADAPTERS, "vue/src/client.ts")}"; useParams("/blog/:slug").value.id;`,
    "bad-vue-navigate.ts": `import { navigate } from "${join(ADAPTERS, "vue/src/client.ts")}"; navigate("/blgo/x");`,
    "bad-solid-useparams.ts": `import { useParams } from "${join(ADAPTERS, "solid/src/client.ts")}"; useParams("/nope");`,
    "bad-solid-navigate.ts": `import { navigate } from "${join(ADAPTERS, "solid/src/client.ts")}"; navigate("/blgo/x");`,
    "bad-svelte-navigate.ts": `import { navigate } from "${join(ADAPTERS, "svelte/src/client.ts")}"; navigate("/blgo/x");`,
    "bad-svelte-link.ts": `import Link from "@cf-lite/svelte/Link.svelte"; import type { ComponentProps } from "svelte"; export const p: ComponentProps<typeof Link> = { to: "/blgo/x" };`,
    "bad-useparams-route.ts": `import type { UseParams } from "cf-lite/href"; declare const useParams: UseParams; useParams("/nope");`,
    "bad-useparams-key.ts": `import type { UseParams } from "cf-lite/href"; declare const useParams: UseParams; useParams("/blog/:slug").id;`,
    "bad-navigate.ts": `import type { Navigate } from "cf-lite/href"; declare const navigate: Navigate; navigate("/blgo/hello");`,
    "bad-route.ts": `import { href } from "cf-lite/href"; href("/nope");`,
    "bad-missing-param.ts": `import { href } from "cf-lite/href"; href("/blog/:slug");`,
    "bad-wrong-param.ts": `import { href } from "cf-lite/href"; href("/blog/:slug", { id: "x" });`,
    "bad-param-type.ts": `import { href } from "cf-lite/href"; href("/blog/:slug", { slug: 1 });`,
    "bad-link.ts": `import type { LinkTo } from "cf-lite/href"; export const x: LinkTo = "/blgo/hello";`,
    "bad-data.ts": `import type { InferData } from "cf-lite/href"; import type * as B from "./app/routes/blog/[slug]"; export const d: InferData<typeof B> = { title: 1, n: 1 };`,
    "bad-action.ts": `import type { InferActionData } from "cf-lite/href"; import type * as B from "./app/routes/blog/[slug]"; export const d: InferActionData<typeof B> = { nope: true };`,
    "bad-pageprops.ts": `import type { PageProps } from "cf-lite/href"; export const p: PageProps<"/blog/:slug"> = { params: { slug: "x" }, data: { title: 5, n: 1 } };`,
    "bad-selfref.ts": `import type { PageProps } from "cf-lite/href"; export const t: number = ({} as PageProps<"/blog/:slug">).data.title;`,
  });

  it("valid usage typechecks", () => { expect(diag["ok.ts"]).toEqual([]); expect(diag["ok-hooks.ts"]).toEqual([]); });
  it("vue / solid / svelte adapters are typed from the route table", () => { expect(diag["ok-adapters.ts"]).toEqual([]); });
  it.each(["bad-route", "bad-missing-param", "bad-wrong-param", "bad-param-type", "bad-link", "bad-data", "bad-action", "bad-pageprops", "bad-selfref", "bad-useparams-route", "bad-useparams-key", "bad-navigate", "bad-vue-useparams", "bad-vue-useparams-key", "bad-vue-navigate", "bad-solid-useparams", "bad-solid-navigate", "bad-svelte-navigate", "bad-svelte-link"])("%s fails to compile", (n) => {
    expect(diag[`${n}.ts`].length).toBeGreaterThan(0);
  });
});

// ---- Env from `wrangler types`: stays in sync after a binding change ---------------------------------------------------------------------
const req = createRequire(import.meta.url);
const wranglerBin = join(dirname(req.resolve("wrangler/package.json")), "bin/wrangler.js");
function runner(cwd: string): Wrangler {
  return (args) => { const r = spawnSync(process.execPath, [wranglerBin, ...args], { cwd, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } }); return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") }; };
}

describe("Env types (wrangler types)", () => {
  it("envTypesArgs: null without a wrangler config; runtime types excluded", () => {
    expect(envTypesArgs(project({ "x": "" }))).toBeNull();
    const root = project({ "wrangler.jsonc": "{}" });
    const a = envTypesArgs(root, { env: "staging", check: true })!;
    expect(a).toEqual(expect.arrayContaining(["types", ".cf-lite/worker-configuration.d.ts", "--include-runtime=false", "--env", "staging", "--check"]));
  });
  it("regenerates Env when bindings change; --check detects drift", () => {
    const root = project({ "wrangler.jsonc": JSON.stringify({ name: "t", main: "w.ts", compatibility_date: "2026-01-01", vars: { SITE_URL: "x" } }), "w.ts": "export default {}" });
    const w = runner(root), log = () => {};
    expect(syncEnvTypes(root, w, log)).toBe(0);
    const f = join(root, ".cf-lite/worker-configuration.d.ts");
    expect(readFileSync(f, "utf8")).toContain("SITE_URL: string");
    expect(readFileSync(f, "utf8")).not.toContain("CACHE");
    expect(syncEnvTypes(root, w, log, { check: true })).toBe(0);
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "t", main: "w.ts", compatibility_date: "2026-01-01", vars: { SITE_URL: "x" }, kv_namespaces: [{ binding: "CACHE", id: "abc" }] }));
    expect(syncEnvTypes(root, w, log, { check: true })).not.toBe(0);
    expect(syncEnvTypes(root, w, log)).toBe(0);
    expect(readFileSync(f, "utf8")).toContain("CACHE: KVNamespace");
    expect(syncEnvTypes(root, w, log, { check: true })).toBe(0);
  }, 60_000);
  it("no wrangler config: skipped, not an error", () => expect(syncEnvTypes(project({ "a": "" }), () => ({ code: 1, out: "" }), () => {})).toBe(0));
});

describe("tsconfig include", () => {
  it.each(["../../create-cf-lite/template/tsconfig.json", "../templates/realtime/tsconfig.json", "../../../examples/site-routes/tsconfig.json"])("%s picks up .cf-lite/*.d.ts", (rel) => {
    const inc: string[] = JSON.parse(readFileSync(resolve(SRC, "..", "test", rel), "utf8")).include;
    expect(inc).toContain(".cf-lite/**/*"); // a bare ".cf-lite" is skipped by tsc (dot-directory)
  });
});

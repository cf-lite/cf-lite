import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { csrf, csrfVerdict } from "../src/modules/csrf.js";
import { actionName, defineAction, fail, formToObject, handleAction, withActionData, saveUpload, DEFAULT_MAX_BODY } from "../src/modules/actions.js";
import { redirect, notFound } from "../src/navigation.js";
import { scanPages } from "../src/scan.js";
import { genApp } from "../src/generate.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U = "https://app.test/contact";
const post = (h: Record<string, string> = {}, ct = "application/x-www-form-urlencoded", url = U) => new Request(url, { method: "POST", headers: { ...(ct ? { "content-type": ct } : {}), ...h }, body: "a=1" });

describe("csrfVerdict", () => {
  it("safe methods are never checked", () => expect(csrfVerdict(new Request(U)).ok).toBe(true));
  it("same-origin fetch metadata / matching Origin pass", () => {
    expect(csrfVerdict(post({ "sec-fetch-site": "same-origin" })).ok).toBe(true);
    expect(csrfVerdict(post({ "sec-fetch-site": "none" })).ok).toBe(true);
    expect(csrfVerdict(post({ origin: "https://app.test" })).ok).toBe(true);
  });
  it.each([
    ["no headers", {}],
    ["foreign origin", { origin: "https://evil.test" }],
    ["null origin", { origin: "null" }],
    ["scheme downgrade", { origin: "http://app.test" }],
    ["other port", { origin: "https://app.test:8443" }],
    ["suffix host", { origin: "https://app.test.evil.test" }],
    ["cross-site", { "sec-fetch-site": "cross-site", origin: "https://app.test" }],
    ["same-site", { "sec-fetch-site": "same-site" }],
  ])("blocks %s", (_n, h) => { const v = csrfVerdict(post(h)); expect(v.ok).toBe(false); });
  it("allowedOrigins opts a partner in (also against cross-site metadata)", () => {
    const o = { allowedOrigins: ["https://partner.test"] };
    expect(csrfVerdict(post({ origin: "https://partner.test" }), o).ok).toBe(true);
    expect(csrfVerdict(post({ origin: "https://partner.test", "sec-fetch-site": "cross-site" }), o).ok).toBe(true);
    expect(csrfVerdict(post({ origin: "https://evil.test" }), o).ok).toBe(false);
  });
  it("allowMissingOrigin for non-browser callers", () => expect(csrfVerdict(post(), { allowMissingOrigin: true }).ok).toBe(true));
  it("content-type confusion -> 415", () => {
    for (const ct of ["text/plain", "application/json", ""]) expect(csrfVerdict(post({ origin: "https://app.test" }, ct))).toMatchObject({ ok: false, status: 415 });
    expect(csrfVerdict(post({ origin: "https://app.test" }, "multipart/form-data; boundary=x")).ok).toBe(true);
  });
  it("middleware form", async () => {
    const app = new Hono().use("*", csrf()).post("/x", (c) => c.text("ran"));
    expect((await app.request("/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=1" })).status).toBe(403);
    expect((await app.request("/x", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://localhost" }, body: "a=1" })).status).toBe(200);
  });
});

describe("actionName", () => {
  it.each([["/c?/save", "save"], ["/c?/", "default"], ["/c", "default"], ["/c?x=1&/a", "a"], ["/c?x=/save", "default"]])("%s", (u, n) => expect(actionName(new URL(u, "https://a.test"))).toBe(n));
});

describe("handleAction", () => {
  const hooks = { rerender: async (d: unknown, s: number) => new Response(JSON.stringify({ rerender: d }), { status: s }), recover: async () => new Response("recovered", { status: 500 }) };
  const run = (actions: any, url: string, body: BodyInit = "a=1", h: Record<string, string> = {}, cfg?: any) => {
    const req = new Request("https://app.test" + url, { method: "POST", headers: { origin: "https://app.test", "content-type": "application/x-www-form-urlencoded", ...h }, body });
    return handleAction({ req: { raw: req } } as any, { actions, actionConfig: cfg }, hooks);
  };
  it("dispatches by name and passes FormData", async () => {
    let seen = "";
    const r = await run({ save: (f: FormData) => { seen = String(f.get("a")); return { ok: 1 }; } }, "/c?/save");
    expect([r.status, await r.json(), seen]).toEqual([200, { rerender: { ok: 1 } }, "1"]);
  });
  it("uses `default` for ?/ and unknown names 404, prototype keys are not actions", async () => {
    expect((await run({ default: () => ({}) }, "/c?/")).status).toBe(200);
    expect((await run({}, "/c?/zzz")).status).toBe(404);
    expect((await run({}, "/c?/toString")).status).toBe(404);
    expect((await run({}, "/c?/__proto__")).status).toBe(404);
  });
  it("undefined -> 303 PRG keeping other params", async () => {
    const r = await run({ a: () => {} }, "/c?q=1&/a");
    expect([r.status, r.headers.get("location")]).toEqual([303, "/c?q=1"]);
  });
  it("redirect() default 307 -> 303; 308 kept", async () => {
    expect((await run({ a: () => redirect("/x") }, "/c?/a")).status).toBe(303);
    expect((await run({ a: () => redirect("/x", 308) }, "/c?/a")).status).toBe(308);
    expect((await run({ a: () => redirect("/x", 303) }, "/c?/a")).headers.get("location")).toBe("/x");
  });
  it("fail() rerenders with its status; notFound -> recover; thrown error -> recover", async () => {
    const f = await run({ a: () => fail(422, { e: 1 }) }, "/c?/a");
    expect([f.status, await f.json()]).toEqual([422, { rerender: { e: 1 } }]);
    expect((await run({ a: () => notFound() }, "/c?/a")).status).toBe(500); // recover hook decides (ssr() renders the 404)
    expect(await (await run({ a: () => { throw new Error("x"); } }, "/c?/a")).text()).toBe("recovered");
  });
  it("Response is passed through", async () => expect((await run({ a: () => new Response("hi", { status: 201 }) }, "/c?/a")).status).toBe(201));
  it("JS mode answers JSON with status 200", async () => {
    const h = { "x-cf-lite-action": "1" };
    expect(await (await run({ a: () => redirect("/x") }, "/c?/a", "a=1", h)).json()).toEqual({ type: "redirect", status: 303, location: "/x" });
    expect(await (await run({ a: () => fail(400, { e: 1 }) }, "/c?/a", "a=1", h)).json()).toEqual({ type: "failure", status: 400, data: { e: 1 } });
    expect(await (await run({ a: () => ({ ok: true }) }, "/c?/a", "a=1", h)).json()).toEqual({ type: "success", status: 200, data: { ok: true } });
    expect(await (await run({ a: () => { throw new Error("secret"); } }, "/c?/a", "a=1", h)).json()).toEqual({ type: "error", status: 500 });
  });
  it("csrf failure never runs the action", async () => {
    let ran = false;
    const r = await run({ a: () => { ran = true; } }, "/c?/a", "a=1", { origin: "https://evil.test" });
    expect([r.status, ran]).toEqual([403, false]);
  });
  it("body cap also holds without a usable Content-Length (chunked / lying header)", async () => {
    const chunked = () => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (let i = 0; i < 10; i++) c.enqueue(e.encode("a=" + "x".repeat(99) + "&")); c.close(); } });
    const chunkedRun = (h: Record<string, string>) => {
      const req = new Request("https://app.test/c?/a", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/x-www-form-urlencoded", ...h }, body: chunked(), duplex: "half" } as RequestInit);
      let ran = false;
      return handleAction({ req: { raw: req } } as any, { actions: { a: () => { ran = true; return {}; } }, actionConfig: { maxBodyBytes: 200 } }, hooks).then((r) => [r.status, ran] as const);
    };
    expect(await chunkedRun({})).toEqual([413, false]);
    expect(await chunkedRun({ "content-length": "abc" })).toEqual([413, false]);
    expect(await chunkedRun({ "content-length": "5" })).toEqual([413, false]); // header understates the body
  });
  it("a within-cap chunked body still parses", async () => {
    const req = new Request("https://app.test/c?/a", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/x-www-form-urlencoded" }, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("a=1")); c.close(); } }), duplex: "half" } as RequestInit);
    let seen = "";
    const r = await handleAction({ req: { raw: req } } as any, { actions: { a: (f: FormData) => { seen = String(f.get("a")); return { ok: 1 }; } }, actionConfig: { maxBodyBytes: 200 } }, hooks);
    expect([r.status, seen]).toEqual([200, "1"]);
  });
  it("body cap", async () => {
    expect((await run({ a: () => ({}) }, "/c?/a", "a=1", { "content-length": String(DEFAULT_MAX_BODY + 1) })).status).toBe(413);
    expect((await run({ a: () => ({}) }, "/c?/a", "a=1", { "content-length": "100" }, { maxBodyBytes: 10 })).status).toBe(413);
  });
  it("malformed multipart -> 400", async () => expect((await run({ a: () => ({}) }, "/c?/a", "garbage", { "content-type": "multipart/form-data; boundary=zz" })).status).toBe(400));
});

describe("validation hook", () => {
  const fd = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.append(k, v), f), new FormData());
  it("function validator: errors -> fail(422) with values minus secrets", async () => {
    const a = defineAction((i) => (i.n ? { value: { n: String(i.n) } } : { errors: { n: "required" } }), () => "ran");
    const r = (await a(fd({ password: "hunter2", x: "y" }), {} as never)) as any;
    expect([r.status, r.data.errors, r.data.values]).toEqual([422, { n: ["required"] }, { x: "y" }]);
    expect(await a(fd({ n: "1" }), {} as never)).toBe("ran");
  });
  it("Standard Schema validators (zod/valibot shape)", async () => {
    const schema = { "~standard": { version: 1, vendor: "t", validate: (v: any) => (v.age >= 18 ? { value: { age: Number(v.age) } } : { issues: [{ message: "too young", path: ["age"] }, { message: "bad" }] }) } };
    const a = defineAction(schema as never, (v: any) => v.age);
    const r = (await a(fd({ age: "3" }), {} as never)) as any;
    expect(r.data.errors).toEqual({ age: ["too young"], _form: ["bad"] });
    expect(await a(fd({ age: "20" }), {} as never)).toBe(20);
  });
  it("formToObject: repeated keys and [] become arrays, __proto__ dropped", () => {
    const f = new FormData(); f.append("a", "1"); f.append("a", "2"); f.append("b[]", "x"); f.append("__proto__", "p");
    const o = formToObject(f);
    expect(o).toEqual({ a: ["1", "2"], b: ["x"] });
    expect(Object.getPrototypeOf(o)).toBe(null);
  });
  it("withActionData keeps object loader data, wraps the rest", () => {
    expect(withActionData({ a: 1 }, 2)).toEqual({ a: 1, actionData: 2 });
    expect(withActionData(undefined, 2)).toEqual({ actionData: 2 });
    expect(withActionData([1], 2)).toEqual({ data: [1], actionData: 2 });
  });
});

describe("saveUpload", () => {
  const bucket = { put: async (_k: string, body: ReadableStream) => { const b = await new Response(body).arrayBuffer(); return { size: b.byteLength, httpEtag: '"e"' }; } } as never;
  it("limits and types", async () => {
    await expect(saveUpload(bucket, "not a file", "k")).rejects.toMatchObject({ status: 400 });
    await expect(saveUpload(bucket, new File(["x"], "a.html", { type: "text/html" }), "k", { allowTypes: ["image/*"] })).rejects.toMatchObject({ status: 415 });
    await expect(saveUpload(bucket, new File(["xxxx"], "a.txt", { type: "text/plain" }), "k", { maxBytes: 2 })).rejects.toMatchObject({ status: 413 });
  });
});

describe("convention", () => {
  const tmp = () => { const r = mkdtempSync(join(tmpdir(), "cfl-act-")); mkdirSync(join(r, "app/routes"), { recursive: true }); return r; };
  it("an ssr route exporting actions gets GET + uncached POST; static route with actions is an error", () => {
    const r = tmp();
    writeFileSync(join(r, "app/routes/c.tsx"), `export const render = "ssr"; export const cache = { ttl: 5 }; export const actions = { a() {} }; export default () => null;`);
    const pages = scanPages(r, "app/routes", [".tsx"]);
    expect(pages[0].hasActions).toBe(true);
    const app = genApp([], pages, { server: "x" });
    expect(app).toMatch(/\.get\("\/c", cacheRoute\(/);
    expect(app).toMatch(/\.post\("\/c", ssr\(s0/);
    expect(app).not.toMatch(/\.post\([^\n]*cacheRoute/);
    const r2 = tmp();
    writeFileSync(join(r2, "app/routes/c.tsx"), `export const render = "static"; export const actions = {}; export default () => null;`);
    expect(() => scanPages(r2, "app/routes", [".tsx"])).toThrow(/only applies to render="ssr"/);
  });
});

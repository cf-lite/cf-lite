import { describe, expect, it, vi } from "vitest";
import { csrfResponse, csrfVerdict } from "../src/modules/csrf.js";
import { github, google, githubPrimaryEmail, safeReturnTo, OAuthError } from "../src/modules/oauth.js";
import { handleAction, formToObject, defineAction, fail, isActionFailure, ACTION_HEADER } from "../src/modules/actions.js";
import { redirect, notFound } from "../src/navigation.js";

const post = (h: Record<string, string> = {}, ct: string | null = "application/x-www-form-urlencoded") =>
  new Request("https://app.test/x", { method: "POST", headers: { ...(ct ? { "content-type": ct } : {}), ...h }, body: "a=1" });

describe("csrfVerdict edge cases", () => {
  it("Origin: null is refused (sandboxed iframe) even without Sec-Fetch-Site", () => expect(csrfVerdict(post({ origin: "null" })).ok).toBe(false));
  it("cross-site fetch metadata is refused unless its Origin is allow-listed", () => {
    expect(csrfVerdict(post({ "sec-fetch-site": "cross-site", origin: "https://evil.test" })).ok).toBe(false);
    expect(csrfVerdict(post({ "sec-fetch-site": "same-site", origin: "https://evil.test" }), { allowedOrigins: ["https://evil.test"] }).ok).toBe(true);
    expect(csrfVerdict(post({ "sec-fetch-site": "cross-site" }), { allowedOrigins: ["https://evil.test"] }).ok).toBe(false); // allow-list needs a matching Origin
  });
  it("Sec-Fetch-Site same-origin cannot be overridden by a spoofed foreign Origin header: metadata wins", () => {
    expect(csrfVerdict(post({ "sec-fetch-site": "same-origin", origin: "https://evil.test" })).ok).toBe(true);
  });
  it("no Origin + no fetch metadata fails closed unless allowMissingOrigin", () => {
    const v = csrfVerdict(post());
    expect(v).toMatchObject({ ok: false, status: 403 });
    expect(csrfVerdict(post(), { allowMissingOrigin: true }).ok).toBe(true);
  });
  it("content-type gate: default refuses JSON / missing / text; contentTypes [] disables; custom list honoured; 415", () => {
    const same = { "sec-fetch-site": "same-origin" };
    expect(csrfVerdict(post(same, "application/json"))).toMatchObject({ ok: false, status: 415 });
    expect(csrfVerdict(post(same, "text/plain"))).toMatchObject({ ok: false, status: 415 });
    expect(csrfVerdict(post(same, null))).toMatchObject({ ok: false, status: 415 });
    expect(csrfVerdict(post(same, "Multipart/Form-Data; boundary=x")).ok).toBe(true);
    expect(csrfVerdict(post(same, "application/json"), { contentTypes: [] }).ok).toBe(true);
    expect(csrfVerdict(post(same, "application/json"), { contentTypes: ["application/json"] }).ok).toBe(true);
  });
  it("every unsafe method is checked; response never leaks the reason", async () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(csrfVerdict(new Request("https://app.test/", { method: m, headers: { origin: "https://evil.test" } })).ok, m).toBe(false);
    const r = csrfResponse({ ok: false, status: 403, reason: "Origin https://evil.test" });
    expect(await r.text()).toBe("Cross-site request blocked");
    expect(await csrfResponse({ ok: false, status: 415, reason: "x" }).text()).toBe("Unsupported Media Type");
  });
});

describe("handleAction hardening", () => {
  const hooks = { rerender: async (d: unknown, s: number) => Response.json({ rerender: d }, { status: s }), recover: async () => new Response("recovered", { status: 500 }) };
  const run = (actions: any, url = "/x?/go", o: { h?: Record<string, string>; body?: BodyInit; ct?: string; cfg?: any } = {}) => {
    const req = new Request("https://app.test" + url, { method: "POST", headers: { origin: "https://app.test", "content-type": o.ct ?? "application/x-www-form-urlencoded", ...o.h }, body: o.body ?? "a=1" });
    return handleAction({ req: { raw: req } } as any, { actions, actionConfig: o.cfg }, hooks);
  };
  it("action names from Object.prototype are never dispatched", async () => {
    for (const n of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect((await run({}, `/x?/${n}`)).status, n).toBe(404);
  });
  it("CSRF-blocked requests never run the action (and log a warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); let ran = false;
    const r = await run({ go: () => { ran = true; } }, "/x?/go", { h: { origin: "https://evil.test" } });
    expect(r.status).toBe(403); expect(ran).toBe(false); expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
  it("malformed multipart body -> 400 and action not run", async () => {
    let ran = false;
    const r = await run({ go: () => { ran = true; } }, "/x?/go", { ct: "multipart/form-data; boundary=zzz", body: "garbage not multipart" });
    expect(r.status).toBe(400); expect(ran).toBe(false);
  });
  it("JS mode: outcomes are HTTP 200 JSON with type; redirect 307->303; notFound; unexpected error -> 500 without message", async () => {
    const h = { [ACTION_HEADER]: "1" };
    expect(await (await run({ go: () => redirect("/to") }, "/x?/go", { h })).json()).toEqual({ type: "redirect", status: 303, location: "/to" });
    expect(await (await run({ go: () => redirect("/to", 301) }, "/x?/go", { h })).json()).toMatchObject({ status: 303 });
    expect(await (await run({ go: () => { throw notFound(); } }, "/x?/go", { h })).json()).toEqual({ type: "error", status: 404 });
    expect(await (await run({ go: () => fail(422, { e: 1 }) }, "/x?/go", { h })).json()).toEqual({ type: "failure", status: 422, data: { e: 1 } });
    expect(await (await run({ go: () => ({ ok: 1 }) }, "/x?/go", { h })).json()).toEqual({ type: "success", status: 200, data: { ok: 1 } });
    expect(await (await run({ go: () => undefined }, "/x?/go&keep=1", { h })).json()).toMatchObject({ type: "redirect", location: "/x?keep=1" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await run({ go: () => { throw new Error("secret detail"); } }, "/x?/go", { h });
    expect(await r.text()).not.toContain("secret detail"); err.mockRestore();
  });
  it("no-JS mode: redirect 303 Location, undefined -> PRG to same page, Response passthrough, thrown error -> recover, notFound -> recover", async () => {
    const r = await run({ go: () => redirect("/to") });
    expect(r.status).toBe(303); expect(r.headers.get("location")).toBe("/to");
    const prg = await run({ go: () => undefined }, "/x?a=1&/go");
    expect(prg.status).toBe(303); expect(prg.headers.get("location")).toBe("/x?a=1");
    expect((await run({ go: () => new Response("raw", { status: 202 }) })).status).toBe(202);
    expect((await run({ go: () => { throw new Error("x"); } })).status).toBe(500);
    expect((await run({ go: () => { throw notFound(); } })).status).toBe(500); // routed to hooks.recover
  });
  it("UploadError thrown by an action becomes a re-render / JSON failure with its status", async () => {
    const { UploadError } = await import("../src/modules/r2.js");
    const r = await run({ go: () => { throw new UploadError(413, "too big"); } });
    expect(r.status).toBe(413); expect(await r.json()).toEqual({ rerender: { error: "too big" } });
    const j = await run({ go: () => { throw new UploadError(415, "bad"); } }, "/x?/go", { h: { [ACTION_HEADER]: "1" } });
    expect(await j.json()).toEqual({ type: "failure", status: 415, data: { error: "bad" } });
  });
  it("default action name + declared oversize + lying Content-Length body cap", async () => {
    expect((await run({ default: () => ({ d: 1 }) }, "/x?/")).status).toBe(200);
    expect((await run({ default: () => ({}) }, "/x", { cfg: { maxBodyBytes: 10 }, h: { "content-length": "500" } })).status).toBe(413);
  });
  it("isActionFailure recognises a duplicated module copy by shape", () => {
    class ActionFailure { constructor(public status: number, public data: unknown) {} }
    expect(isActionFailure(new ActionFailure(400, {}))).toBe(true);
    expect(isActionFailure({ status: 400, data: {} })).toBe(false);
    expect(isActionFailure(null)).toBe(false);
  });
});

describe("formToObject / defineAction", () => {
  it("prototype pollution keys are inert", () => {
    const f = new FormData(); f.append("__proto__", "x"); f.append("constructor", "y"); f.append("a[]", "1"); f.append("a[]", "2"); f.append("b", "1"); f.append("b", "2");
    const o = formToObject(f);
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(({} as any).x).toBeUndefined();
    expect(o).toMatchObject({ a: ["1", "2"], b: ["1", "2"], constructor: "y" });
    expect(Object.keys(o)).not.toContain("__proto__");
  });
  it("invalid input never reaches the handler; secret-looking fields and files are not echoed back", async () => {
    let called = false; const f = new FormData();
    f.append("user", "bob"); f.append("password", "hunter2"); f.append("api_token", "t"); f.append("cvv", "123"); f.append("file", new File(["x"], "f.txt"));
    const act = defineAction((i): any => ({ errors: { user: "bad" } }), () => { called = true; });
    const r = (await act(f, {} as any)) as any;
    expect(called).toBe(false); expect(r.status).toBe(422);
    expect(r.data.values).toEqual({ user: "bob" });
    expect(r.data.errors).toEqual({ user: ["bad"] });
  });
  it("Standard Schema: issue paths become dotted keys; `_form` for root issues; custom status", async () => {
    const schema = { "~standard": { validate: () => ({ issues: [{ message: "m1", path: ["a", { key: "b" }] }, { message: "m2" }, { message: "m3", path: ["a", "b"] }] }) } };
    const r = (await defineAction(schema as any, () => 1, { status: 400 })(new FormData(), {} as any)) as any;
    expect(r.status).toBe(400); expect(r.data.errors).toEqual({ "a.b": ["m1", "m3"], _form: ["m2"] });
    const ok = await defineAction({ "~standard": { validate: (v: any) => ({ value: { n: 1 } }) } } as any, (v: any) => v)(new FormData(), {} as any);
    expect(ok).toEqual({ n: 1 });
  });
});

describe("oauth providers + helpers", () => {
  const cred = { clientId: "id", clientSecret: "s", redirectUri: "https://app.test/cb" };
  it("github profile never claims a verified email (public email is unverified)", () => {
    const p = github(cred).provider.profile({ id: 7, login: "octo", email: "o@x.test", avatar_url: "https://a" });
    expect(p).toMatchObject({ id: "7", email: "o@x.test", emailVerified: false, name: "octo", picture: "https://a" });
    expect(github(cred).provider.profile({ id: 1, email: 5 }).email).toBeUndefined();
  });
  it("google/oidc emailVerified only when strictly true (not the string 'true')", () => {
    const pr = google(cred).provider.profile;
    expect(pr({ sub: "1", email: "a@b", email_verified: true }).emailVerified).toBe(true);
    expect(pr({ sub: "1", email: "a@b", email_verified: "true" }).emailVerified).toBe(false);
    expect(pr({ sub: "1" }).emailVerified).toBe(false);
  });
  it("githubPrimaryEmail: only primary AND verified; failure -> undefined; bearer sent", async () => {
    const f = vi.fn(async () => Response.json([{ email: "a@x", primary: false, verified: true }, { email: "b@x", primary: true, verified: false }]));
    expect(await githubPrimaryEmail("tok", f as any)).toBeUndefined();
    expect((f.mock.calls[0] as any)[1].headers.authorization).toBe("Bearer tok");
    const ok = vi.fn(async () => Response.json([{ email: "c@x", primary: true, verified: true }]));
    expect(await githubPrimaryEmail("t", ok as any)).toBe("c@x");
    expect(await githubPrimaryEmail("t", (async () => new Response("no", { status: 401 })) as any)).toBeUndefined();
  });
  it("OAuthError carries a code; safeReturnTo rejects scheme-relative / backslash / control tricks", () => {
    expect(new OAuthError("state", "m")).toMatchObject({ code: "state", message: "m" });
    for (const v of ["//evil.test", "/\\evil.test", "\\\\evil.test", "https://evil.test", "javascript:alert(1)", "/\t/evil.test", "/%09/evil.test".replace("%09", "\n")]) expect(safeReturnTo(v), JSON.stringify(v)).toBe("/");
  });
});

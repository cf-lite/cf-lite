import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { csrf, d1Store, getSession, requireSession, session, SessionDO, verifyCsrfToken, checkOrigin } from "../src/modules/session.js";

const SECRET = "s".repeat(40);
const setCookie = (r: Response) => r.headers.get("set-cookie") ?? "";

describe("session() hardening", () => {
  it("J1: a handler returning an immutable Response (fetch()/ASSETS) does not crash when the session must write a cookie", async () => {
    const app = new Hono<any>();
    app.use("*", session({ secrets: SECRET, secure: false }));
    app.post("/login", async (c) => {
      await getSession(c).login("u1");
      const upstream = await fetch("data:text/plain,hi"); // headers guard = immutable
      return upstream;
    });
    const r = await app.request("/login", { method: "POST" });
    expect(r.status).toBe(200);
    expect(setCookie(r)).toMatch(/HttpOnly/);
  });
  it("getSession without the middleware throws a clear error", async () => {
    const app = new Hono(); app.get("/", (c) => c.text(String(getSession(c).userId)));
    const r = await app.request("/"); expect(r.status).toBe(500);
  });
  it("login() requires a user id (empty string refused)", async () => {
    const app = new Hono<any>(); app.use("*", session({ secrets: SECRET, secure: false }));
    let err = ""; app.post("/", async (c) => { try { await getSession(c).login(""); } catch (e) { err = (e as Error).message; } return c.text("x"); });
    await app.request("/", { method: "POST" }); expect(err).toMatch(/userId required/);
  });
  it("cookie is HttpOnly + SameSite and Secure by default on https", async () => {
    const app = new Hono<any>(); app.use("*", session({ secrets: SECRET }));
    app.post("/", async (c) => { await getSession(c).login("u"); return c.text("x"); });
    const ck = setCookie(await app.request("https://app.test/", { method: "POST" }));
    expect(ck).toMatch(/HttpOnly/); expect(ck).toMatch(/SameSite=/i); expect(ck).toMatch(/Secure/);
  });
  it("flash messages are one-shot", async () => {
    const app = new Hono<any>(); app.use("*", session({ secrets: SECRET, secure: false }));
    app.post("/set", (c) => { getSession(c).setFlash("m", "hello"); return c.text("ok"); });
    app.get("/get", (c) => c.json({ m: getSession(c).flash("m") ?? null }));
    const r1 = await app.request("/set", { method: "POST" });
    const cookie = setCookie(r1).split(";")[0];
    const r2 = await app.request("/get", { headers: { cookie } });
    expect(await r2.json()).toEqual({ m: "hello" });
    const cookie2 = setCookie(r2).split(";")[0] || cookie;
    expect(await (await app.request("/get", { headers: { cookie: cookie2 } })).json()).toEqual({ m: null });
  });
});

describe("csrf() (session module) + token", () => {
  const mk = (o = {}) => {
    const app = new Hono<any>();
    app.use("*", session({ secrets: SECRET, secure: false }));
    app.get("/t", (c) => c.text(getSession(c).csrfToken()));
    app.use("*", csrf(o));
    app.post("/act", (c) => c.text("done"));
    return app;
  };
  it("bad Origin -> 403 JSON", async () => {
    const r = await mk().request("https://app.test/act", { method: "POST", headers: { origin: "https://evil.test" } });
    expect(r.status).toBe(403);
  });
  it("requireToken: missing/forged token refused; header token and form `_csrf` both accepted", async () => {
    const app = mk({ requireToken: true });
    const t = await app.request("https://app.test/t"); const cookie = setCookie(t).split(";")[0]; const tok = await t.text();
    const h = { origin: "https://app.test", cookie };
    expect((await app.request("https://app.test/act", { method: "POST", headers: h })).status).toBe(403);
    expect((await app.request("https://app.test/act", { method: "POST", headers: { ...h, "x-csrf-token": tok + "x" } })).status).toBe(403);
    expect((await app.request("https://app.test/act", { method: "POST", headers: { ...h, "x-csrf-token": tok } })).status).toBe(200);
    const form = await app.request("https://app.test/act", { method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: "_csrf=" + encodeURIComponent(tok) });
    expect(form.status).toBe(200);
    const badForm = await app.request("https://app.test/act", { method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: "_csrf=nope" });
    expect(badForm.status).toBe(403);
  });
  it("verifyCsrfToken: undefined/empty never matches; checkOrigin handles missing header per policy", () => {
    const s: any = { data: { _csrf: "abc" } };
    expect(verifyCsrfToken(s, undefined)).toBe(false); expect(verifyCsrfToken(s, "")).toBe(false); expect(verifyCsrfToken(s, "abc")).toBe(true);
    expect(verifyCsrfToken({ data: {} } as any, "")).toBe(false);
    expect(checkOrigin(new Request("https://a.test/", { method: "POST", headers: { origin: "https://b.test" } }), ["https://b.test"])).toBe(true);
    expect(checkOrigin(new Request("https://a.test/", { method: "POST", headers: { origin: "null" } }))).toBe(false);
  });
});

describe("requireSession", () => {
  it("401 JSON when anonymous, passes after login", async () => {
    const app = new Hono<any>(); app.use("*", session({ secrets: SECRET, secure: false }));
    app.post("/login", async (c) => { await getSession(c).login("u"); return c.text("ok"); });
    app.get("/priv", requireSession(), (c) => c.text("secret"));
    expect((await app.request("/priv")).status).toBe(401);
    const ck = setCookie(await app.request("/login", { method: "POST" })).split(";")[0];
    expect(await (await app.request("/priv", { headers: { cookie: ck } })).text()).toBe("secret");
  });
});

describe("SessionDO + d1Store guards", () => {
  const mkDo = () => { const st = new Map<string, unknown>(); let alarm = 0; return { st, alarm: () => alarm, o: new SessionDO({ storage: { get: async (k: string) => st.get(k) as never, put: async (k: string, v: unknown) => void st.set(k, v), deleteAll: async () => st.clear(), setAlarm: async (t: number) => { alarm = t; } } }) }; };
  it("GET/PUT/DELETE/405 and alarm wipes the record", async () => {
    const { o, st, alarm } = mkDo();
    expect(await (await o.fetch(new Request("https://do/"))).json()).toBeNull();
    const rec = { data: { a: 1 }, iat: 1, ls: 1, exp: 99 };
    expect((await o.fetch(new Request("https://do/", { method: "PUT", body: JSON.stringify({ rec, ttl: 60 }) }))).status).toBe(204);
    expect(alarm()).toBeGreaterThan(Date.now());
    expect(await (await o.fetch(new Request("https://do/"))).json()).toEqual(rec);
    expect((await o.fetch(new Request("https://do/", { method: "POST" }))).status).toBe(405);
    await o.alarm(); expect(st.size).toBe(0);
    await o.fetch(new Request("https://do/", { method: "PUT", body: JSON.stringify({ rec, ttl: 1 }) }));
    expect((await o.fetch(new Request("https://do/", { method: "DELETE" }))).status).toBe(204); expect(st.size).toBe(0);
  });
  it("d1Store rejects SQL-injection-looking table names", () => {
    for (const t of ["x; DROP TABLE users", "a-b", "1abc", "a b", ""]) expect(() => d1Store({} as any, t), t).toThrow(/bad table name/);
    expect(() => d1Store({} as any, "sessions_2")).not.toThrow();
  });
});

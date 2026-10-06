import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { checkOrigin, csrf, d1Store, doStore, e2eSessionIssuer, getSession, kvStore, requireSession, revokeUser, safeEqual, sealData, session, SessionDO, SESSIONS_SQL, unsealData, type SessionOptions, type SessionStore } from "../src/modules/session.js";
import { e2eLogin } from "../src/modules/e2e-login.js";

const S1 = "a".repeat(40), S2 = "b".repeat(40);

function fakeKv() {
  const m = new Map<string, string>();
  return { m, get: async (k: string, t?: string) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null), put: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k),
    list: async ({ prefix }: { prefix: string }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) } as unknown as KVNamespace & { m: Map<string, string> };
}
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SESSIONS_SQL);
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as never) ?? null,
    run: async () => { const r = db.prepare(sql).run(...(args as never[])); return { meta: { changes: Number(r.changes) } }; },
  });
  return { db, prepare: (s: string) => stmt(s) } as unknown as D1Database & { db: DatabaseSync };
}
function fakeDoNs() {
  const objs = new Map<string, SessionDO>(); const data = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: string) => {
    if (!objs.has(id)) { const st = new Map<string, unknown>(); data.set(id, st); objs.set(id, new SessionDO({ storage: { get: async (k: string) => st.get(k) as never, put: async (k: string, v: unknown) => void st.set(k, v), deleteAll: async () => st.clear(), setAlarm: async () => {} } })); }
    return { fetch: (u: string, init: RequestInit) => objs.get(id)!.fetch(new Request(u, init)) };
  } } as unknown as DurableObjectNamespace;
}

let clock = 1_000_000;
function harness(opts: SessionOptions = {}) {
  const app = new Hono<{ Bindings: { SESSION_SECRETS?: string } }>();
  app.use("*", session({ now: () => clock, ...opts }));
  app.get("/me", (c) => c.json({ uid: getSession(c).userId ?? null, n: getSession(c).get("n") ?? null }));
  app.post("/login", async (c) => { await getSession(c).login(c.req.query("u") ?? "u1", { n: 1 }); return c.text("ok"); });
  app.post("/bump", (c) => { const s = getSession(c); s.set("n", ((s.get("n") as number) ?? 0) + 1); return c.text("ok"); });
  app.post("/logout", async (c) => { await getSession(c).destroy(); return c.text("bye"); });
  app.post("/rotate", async (c) => { await getSession(c).rotate(); return c.text("ok"); });
  app.get("/noop", (c) => c.text("noop"));
  const jar = { cookie: "" };
  const call = async (path: string, method = "GET", env: object = { SESSION_SECRETS: `${S1}` }, url = "http://t.example") => {
    const r = await app.request(url + path, { method, headers: jar.cookie ? { cookie: jar.cookie } : {} }, env);
    const sc = r.headers.get("set-cookie");
    if (sc) { const [kv, ...attrs] = sc.split("; "); jar.cookie = /Max-Age=0/.test(sc) ? "" : kv; return { r, sc, attrs, body: await r.text() }; }
    return { r, sc, attrs: [] as string[], body: await r.text() };
  };
  return { call, jar };
}

describe("seal/unseal", () => {
  it("round-trips, binds aad, unique IVs, rejects tamper/garbage/old key", async () => {
    const a = await sealData({ x: 1 }, S1, "n"), b = await sealData({ x: 1 }, S1, "n");
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]); // IV never reused
    expect(await unsealData(a, S1, "n")).toEqual({ x: 1 });
    expect(await unsealData(a, S1, "other")).toBeNull();
    expect(await unsealData(a, S2, "n")).toBeNull();
    const p = a.split(".");
    const flip = (s: string) => s.slice(0, -2) + (s.slice(-2) === "AA" ? "BB" : "AA");
    expect(await unsealData([p[0], p[1], p[2], flip(p[3])].join("."), S1, "n")).toBeNull();
    expect(await unsealData([p[0], p[1], flip(p[2]), p[3]].join("."), S1, "n")).toBeNull();
    for (const g of ["", "x", "1.2.3", "2.a.b.c", "1.k.iv.ct", "1." + p[1] + ".AAAA." + p[3], "....", "1.a.b.c.d"]) expect(await unsealData(g, S1, "n")).toBeNull();
  });
  it("key rotation: new key seals, old key still unseals; dropping the old key invalidates", async () => {
    const old = await sealData({ v: "old" }, S1, "n");
    expect(await unsealData(old, [S2, S1], "n")).toEqual({ v: "old" });
    const nw = await sealData({ v: "new" }, [S2, S1], "n");
    expect(await unsealData(nw, [S2], "n")).toEqual({ v: "new" });
    expect(await unsealData(old, [S2], "n")).toBeNull();
  });
  it("fails closed on missing or short secrets", async () => {
    await expect(sealData({}, "", "n")).rejects.toThrow(/no secrets/);
    await expect(sealData({}, "short", "n")).rejects.toThrow(/>= 32/);
    expect(await unsealData("1.a.b.c", "short", "n")).toBeNull();
  });
  it("safeEqual", () => { expect(safeEqual("ab", "ab")).toBe(true); expect(safeEqual("ab", "ac")).toBe(false); expect(safeEqual("a", "ab")).toBe(false); });
});

const variants: [string, () => SessionOptions][] = [
  ["sealed", () => ({})],
  ["kv", () => ({ store: kvStore(fakeKv()) })],
  ["d1", () => ({ store: d1Store(fakeD1(), "sessions", () => clock) })],
  ["do", () => ({ store: doStore(fakeDoNs()) })],
];
describe.each(variants)("session (%s store)", (_n, mk) => {
  it("anonymous request sets no cookie; login sets HttpOnly cookie; me sees it; logout clears", async () => {
    const h = harness(mk());
    expect((await h.call("/me")).sc).toBeNull();
    const l = await h.call("/login", "POST");
    expect(l.attrs).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax"]));
    expect(JSON.parse((await h.call("/me")).body)).toEqual({ uid: "u1", n: 1 });
    const out = await h.call("/logout", "POST");
    expect(out.sc).toMatch(/Max-Age=0/);
    expect(JSON.parse((await h.call("/me")).body)).toEqual({ uid: null, n: null });
  });
  it("https uses __Host- prefix + Secure, no Domain", async () => {
    const h = harness(mk());
    const l = await h.call("/login", "POST", undefined, "https://t.example");
    expect(l.sc).toMatch(/^__Host-session=/); expect(l.attrs).toContain("Secure"); expect(l.sc).not.toMatch(/Domain/);
    expect(JSON.parse((await h.call("/me", "GET", undefined, "https://t.example")).body).uid).toBe("u1");
  });
  it("login rotates: fixation-safe (pre-login cookie is dead after login)", async () => {
    const h = harness(mk());
    await h.call("/bump", "POST"); const pre = h.jar.cookie;
    await h.call("/login", "POST"); expect(h.jar.cookie).not.toBe(pre);
    h.jar.cookie = pre; // attacker-planted pre-login cookie
    if (_n === "sealed") return; // a sealed pre-login cookie stays valid anonymously by design; it never carries the new uid
    expect(JSON.parse((await h.call("/me")).body).uid).toBeNull();
  });
  it("expiry: idle ttl and absolute ttl", async () => {
    const h = harness({ ...mk(), ttl: 100, absoluteTtl: 250, updateAge: 0 });
    await h.call("/login", "POST");
    clock += 90; expect(JSON.parse((await h.call("/me")).body).uid).toBe("u1"); // slides
    clock += 90; expect(JSON.parse((await h.call("/me")).body).uid).toBe("u1");
    clock += 90; expect(JSON.parse((await h.call("/me")).body).uid).toBe(null); // past absolute 250 since login (270)
    const h2 = harness({ ...mk(), ttl: 100 });
    await h2.call("/login", "POST"); clock += 101; expect(JSON.parse((await h2.call("/me")).body).uid).toBeNull();
  });
  it("sliding refresh only after updateAge (no Set-Cookie on every read)", async () => {
    const h = harness({ ...mk(), updateAge: 60 });
    await h.call("/login", "POST");
    expect((await h.call("/me")).sc).toBeNull();
    clock += 61; expect((await h.call("/me")).sc).toMatch(/Max-Age=/);
  });
  it("validAfter rejects older sessions", async () => {
    const o = mk(); const h = harness(o);
    await h.call("/login", "POST");
    const h2 = harness({ ...o, validAfter: clock + 1 }); h2.jar.cookie = h.jar.cookie;
    expect(JSON.parse((await h2.call("/me")).body).uid).toBeNull();
  });
  it("garbage and foreign cookies are anonymous, never throw", async () => {
    const h = harness(mk());
    for (const v of ["", "x", "1.a.b.c", "A".repeat(43), "A".repeat(5000)]) { h.jar.cookie = `session=${v}`; expect((await h.call("/me")).r.status).toBe(200); expect(JSON.parse((await h.call("/me")).body).uid).toBeNull(); }
  });
});

describe("sealed specifics", () => {
  it("tampered cookie is anonymous", async () => {
    const h = harness(); await h.call("/login", "POST");
    h.jar.cookie = h.jar.cookie.slice(0, -3) + "AAA";
    expect(JSON.parse((await h.call("/me")).body).uid).toBeNull();
  });
  it("secret rotation keeps sessions; removing the old secret logs out", async () => {
    const h = harness(); await h.call("/login", "POST");
    expect(JSON.parse((await h.call("/me", "GET", { SESSION_SECRETS: `${S2},${S1}` })).body).uid).toBe("u1");
    clock += 301; const r = await h.call("/me", "GET", { SESSION_SECRETS: `${S2},${S1}` }); // sliding refresh re-seals under the new key
    expect(r.sc).toBeTruthy();
    expect(JSON.parse((await h.call("/me", "GET", { SESSION_SECRETS: S2 })).body).uid).toBe("u1");
    expect(JSON.parse((await h.call("/me", "GET", { SESSION_SECRETS: S1 })).body).uid).toBeNull();
  });
  it("cookie sealed for another cookie name does not load (aad)", async () => {
    const a = harness({ cookieName: "a" }), b = harness({ cookieName: "b" });
    await a.call("/login", "POST"); b.jar.cookie = a.jar.cookie.replace(/^a=/, "b=");
    expect(JSON.parse((await b.call("/me")).body).uid).toBeNull();
  });
  it("oversize sealed cookie throws with a pointer to stores", async () => {
    const app = new Hono(); app.use("*", session()); app.post("/big", (c) => { getSession(c).set("x", "y".repeat(5000)); return c.text("x"); });
    const r = await app.request("http://t/big", { method: "POST" }, { SESSION_SECRETS: S1 }); expect(r.status).toBe(500);
  });
  it("missing secret fails closed (500, no cookie)", async () => {
    const h = harness(); const r = await h.call("/login", "POST", {}); expect(r.r.status).toBe(500); expect(r.sc).toBeNull();
  });
});

describe("store specifics / revoke", () => {
  it("store holds SHA-256 of the id, not the cookie value", async () => {
    const kv = fakeKv(); const h = harness({ store: kvStore(kv) }); await h.call("/login", "POST");
    const id = h.jar.cookie.split("=")[1];
    expect([...kv.m.keys()].some((k) => k.includes(id))).toBe(false);
  });
  it("sealed sessions are NOT revocable: a stolen copy survives destroy (documented; use a store)", async () => {
    const h = harness({}); await h.call("/login", "POST"); const stolen = h.jar.cookie;
    await h.call("/logout", "POST"); h.jar.cookie = stolen;
    expect(JSON.parse((await h.call("/me")).body).uid).not.toBeNull();
  });
  it("destroy revokes server-side: a stolen copy of the cookie stops working", async () => {
    const h = harness({ store: kvStore(fakeKv()) }); await h.call("/login", "POST"); const stolen = h.jar.cookie;
    await h.call("/logout", "POST"); h.jar.cookie = stolen;
    expect(JSON.parse((await h.call("/me")).body).uid).toBeNull();
  });
  it.each([["kv", () => kvStore(fakeKv())], ["d1", () => d1Store(fakeD1(), "sessions", () => clock)]] as [string, () => SessionStore][])("revokeUser kills all of a user's sessions (%s)", async (_n, mk) => {
    const store = mk(); const a = harness({ store }), b = harness({ store }), c = harness({ store });
    await a.call("/login?u=alice", "POST"); await b.call("/login?u=alice", "POST"); await c.call("/login?u=bob", "POST");
    expect(await revokeUser(store, "alice")).toBe(2);
    expect(JSON.parse((await a.call("/me")).body).uid).toBeNull(); expect(JSON.parse((await b.call("/me")).body).uid).toBeNull();
    expect(JSON.parse((await c.call("/me")).body).uid).toBe("bob");
  });
  it("DO store has no user index", async () => { await expect(revokeUser(doStore(fakeDoNs()), "x")).rejects.toThrow(); });
  it("d1Store rejects a hostile table name", () => { expect(() => d1Store(fakeD1(), "s; DROP TABLE x")).toThrow(); });
});

describe("guards + csrf + e2e-login", () => {
  it("requireSession", async () => {
    const app = new Hono(); app.use("*", session({ now: () => clock })); app.get("/x", requireSession(), (c) => c.text("in"));
    expect((await app.request("http://t/x", {}, { SESSION_SECRETS: S1 })).status).toBe(401);
  });
  it("checkOrigin: missing/foreign origin, cross-site fetch metadata", () => {
    const r = (headers: Record<string, string>, method = "POST") => new Request("https://a.example/x", { method, headers });
    expect(checkOrigin(r({}, "GET"))).toBe(true);
    expect(checkOrigin(r({ origin: "https://a.example" }))).toBe(true);
    expect(checkOrigin(r({ origin: "https://evil.example" }))).toBe(false);
    expect(checkOrigin(r({ origin: "null" }))).toBe(false);
    expect(checkOrigin(r({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(checkOrigin(r({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(checkOrigin(r({}))).toBe(false);
    expect(checkOrigin(r({ origin: "https://b.example" }), ["https://b.example"])).toBe(true);
  });
  it("csrf token flow (header and form)", async () => {
    const app = new Hono(); app.use("*", session({ now: () => clock })); app.use("*", csrf({ requireToken: true }));
    app.get("/t", (c) => c.text(getSession(c).csrfToken())); app.post("/p", (c) => c.text("done"));
    const env = { SESSION_SECRETS: S1 };
    const g = await app.request("https://a.example/t", {}, env); const tok = await g.text(); const ck = g.headers.get("set-cookie")!.split(";")[0];
    const post = (h: Record<string, string>, body?: BodyInit) => app.request("https://a.example/p", { method: "POST", headers: { origin: "https://a.example", cookie: ck, ...h }, body }, env);
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-csrf-token": "nope" })).status).toBe(403);
    expect((await post({ "x-csrf-token": tok })).status).toBe(200);
    expect((await post({ "content-type": "application/x-www-form-urlencoded" }, `_csrf=${tok}`)).status).toBe(200);
    expect((await app.request("https://a.example/p", { method: "POST", headers: { origin: "https://evil.example", cookie: ck, "x-csrf-token": tok } }, env)).status).toBe(403);
  });
  it("e2e-login logs in through the real session; inert without E2E_LOGIN_SECRET", async () => {
    const app = new Hono<{ Bindings: { SESSION_SECRETS?: string; E2E_LOGIN_SECRET?: string } }>();
    app.use("*", session({ now: () => clock })); app.route("/__e2e", e2eLogin({ issue: e2eSessionIssuer() })); app.get("/me", (c) => c.json(getSession(c).userId ?? null));
    const off = await app.request("http://t/__e2e/login", { method: "POST", headers: { "x-e2e-secret": "s" } }, { SESSION_SECRETS: S1 });
    expect(off.status).toBe(404);
    const env = { SESSION_SECRETS: S1, E2E_LOGIN_SECRET: "s" };
    expect((await app.request("http://t/__e2e/login", { method: "POST", headers: { "x-e2e-secret": "bad" } }, env)).status).toBe(403);
    const on = await app.request("http://t/__e2e/login", { method: "POST", headers: { "x-e2e-secret": "s" }, body: JSON.stringify({ user: "qa" }) }, env);
    expect(on.status).toBe(204);
    const me = await app.request("http://t/me", { headers: { cookie: on.headers.get("set-cookie")!.split(";")[0] } }, env);
    expect(await me.json()).toBe("qa");
  });
});

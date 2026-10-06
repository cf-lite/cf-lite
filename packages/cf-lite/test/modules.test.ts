import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { readSso, requireSso, ssoConfigError, ssoLoginUrl, verifySsoToken } from "../src/modules/sso.js";
import { cached } from "../src/modules/kv-cache.js";
import { d1 } from "../src/modules/d1.js";

const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");

async function mint(claims: object, kid = "k1") {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64");
  const head = b64u(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const body = b64u(JSON.stringify(claims));
  const sig = b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(head + "." + body)));
  return { token: `${head}.${body}.${sig}`, env: { SSO_PUBLIC_KEYS: JSON.stringify({ [kid]: pub }), SSO_ISSUER: "auth.example.com", SSO_AUDIENCE: "example", SSO_AUTH_ORIGIN: "https://auth.example.com" }, pub };
}
const now = Math.floor(Date.now() / 1000);
const good = { sub: "alice", iat: now, exp: now + 600, iss: "auth.example.com", aud: "example" };

describe("sso module", () => {
  it("accepts a valid token", async () => {
    const { token, env } = await mint(good);
    expect(await verifySsoToken(token, env)).toMatchObject({ ok: true, claims: { sub: "alice" } });
  });
  it("rejects expired, wrong aud, disallowed sub, tampering, missing", async () => {
    const a = await mint({ ...good, exp: now - 1 });
    expect(await verifySsoToken(a.token, a.env)).toEqual({ ok: false, reason: "expired" });
    const b = await mint({ ...good, aud: "x" });
    expect(await verifySsoToken(b.token, b.env)).toEqual({ ok: false, reason: "wrong iss/aud" });
    const c = await mint(good);
    expect(await verifySsoToken(c.token, { ...c.env, SSO_ALLOWED_LOGINS: "someone" })).toEqual({ ok: false, reason: "sub not allowed" });
    const t = c.token.split("."); t[1] = b64u(JSON.stringify({ ...good, sub: "evil" }));
    expect(await verifySsoToken(t.join("."), c.env)).toEqual({ ok: false, reason: "bad signature" });
    expect((await verifySsoToken(undefined, c.env)).ok).toBe(false);
  });
  it("requireSso middleware gates a Hono route", async () => {
    const { token, env } = await mint(good);
    const app = new Hono<any>().use("/p", requireSso()).get("/p", (c) => c.text(c.var.sso.sub));
    expect((await app.request("/p", {}, env)).status).toBe(401);
    const r = await app.request("/p", { headers: { cookie: `sso=${token}` } }, env);
    expect(await r.text()).toBe("alice");
  });
});

describe("sso configuration", () => {
  it("nothing is hard-coded: missing issuer / keys are reported, never defaulted", async () => {
    const { token, env } = await mint(good);
    expect(await verifySsoToken(token, { SSO_PUBLIC_KEYS: env.SSO_PUBLIC_KEYS })).toEqual({ ok: false, reason: "SSO_ISSUER not configured", config: true });
    expect(await verifySsoToken(token, { SSO_ISSUER: env.SSO_ISSUER })).toEqual({ ok: false, reason: "SSO_PUBLIC_KEYS not configured", config: true });
    expect(() => ssoLoginUrl("https://a/", {})).toThrow(/SSO_AUTH_ORIGIN/);
  });
  it("issuer must match; audience is required and checked (J4)", async () => {
    const { token, env } = await mint(good);
    expect(await verifySsoToken(token, { ...env, SSO_ISSUER: "other.example" })).toEqual({ ok: false, reason: "wrong iss/aud" });
    expect(await verifySsoToken(token, { ...env, SSO_AUDIENCE: "other" })).toEqual({ ok: false, reason: "wrong iss/aud" });
    const noAud = await mint({ sub: "alice", iat: now, exp: now + 600, iss: "auth.example.com" });
    expect(await verifySsoToken(noAud.token, noAud.env)).toEqual({ ok: false, reason: "wrong iss/aud" });
    const arr = await mint({ ...good, aud: ["x", "example"] });
    expect(await verifySsoToken(arr.token, arr.env)).toMatchObject({ ok: true });
  });
  it("missing/empty SSO_AUDIENCE fails closed as a config error, never 'unchecked'", async () => {
    const { token, env } = await mint(good);
    for (const SSO_AUDIENCE of [undefined, ""]) {
      expect(await verifySsoToken(token, { ...env, SSO_AUDIENCE })).toEqual({ ok: false, reason: "SSO_AUDIENCE not configured", config: true });
      expect(await verifySsoToken(undefined, { ...env, SSO_AUDIENCE })).toMatchObject({ config: true });
      expect(ssoConfigError({ ...env, SSO_AUDIENCE })).toBe("SSO_AUDIENCE not configured");
    }
    expect(ssoConfigError(env)).toBeNull();
    const app = new Hono<any>().use("/p", requireSso()).get("/p", (c) => c.text(c.var.sso.sub));
    const r = await app.request("/p", { headers: { cookie: `sso=${token}` } }, { ...env, SSO_AUDIENCE: undefined });
    expect(r.status).toBe(500);
    expect(await r.json()).toMatchObject({ reason: "SSO_AUDIENCE not configured" });
    expect((await app.request("/p", { headers: { cookie: `sso=${token}` } }, env)).status).toBe(200);
  });
  it("nbf and exp>iat sanity", async () => {
    const a = await mint({ ...good, nbf: now + 3600 });
    expect(await verifySsoToken(a.token, a.env)).toEqual({ ok: false, reason: "not yet valid" });
    const b = await mint({ ...good, nbf: now - 5 });
    expect(await verifySsoToken(b.token, b.env)).toMatchObject({ ok: true });
    const c = await mint({ ...good, iat: now + 30, exp: now + 20 });
    expect(await verifySsoToken(c.token, c.env)).toEqual({ ok: false, reason: "exp not after iat" });
    const d = await mint({ ...good, nbf: "soon" });
    expect(await verifySsoToken(d.token, d.env)).toEqual({ ok: false, reason: "not yet valid" });
  });
  it("accepts a real JWKS (OKP/Ed25519, base64url x)", async () => {
    const { token, env, pub } = await mint(good);
    const x = Buffer.from(pub, "base64").toString("base64url");
    const jwks = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid: "k1", x }, { kty: "RSA", kid: "ignored" }] });
    expect(await verifySsoToken(token, { ...env, SSO_PUBLIC_KEYS: jwks })).toMatchObject({ ok: true });
  });
  it("cookie name and refresh window are configurable", async () => {
    const { token, env } = await mint({ ...good, iat: now - 100 });
    const app = new Hono<any>().use("/p", requireSso()).get("/p", (c) => c.text(c.var.sso.sub));
    const e2 = { ...env, SSO_COOKIE_NAME: "session" };
    expect((await app.request("/p", { headers: { cookie: `sso=${token}` } }, e2)).status).toBe(401);
    expect((await app.request("/p", { headers: { cookie: `session=${token}` } }, e2)).status).toBe(200);
    expect(await verifySsoToken(token, { ...env, SSO_REFRESH_AFTER_S: "50" })).toMatchObject({ ok: true, stale: true });
    expect(await verifySsoToken(token, env)).toMatchObject({ ok: true, stale: false });
  });
});

describe("kv-cache module", () => {
  it("computes once then serves from cache", async () => {
    const store = new Map<string, string>();
    const kv = { get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null), put: async (k: string, v: string) => void store.set(k, v) } as unknown as KVNamespace;
    let n = 0;
    const f = async () => ({ n: ++n });
    expect(await cached(kv, "k", 60, f)).toEqual({ n: 1 });
    expect(await cached(kv, "k", 60, f)).toEqual({ n: 1 });
  });
});

describe("d1 module", () => {
  it("binds params through prepare().bind()", async () => {
    const calls: unknown[][] = [];
    const db = { prepare: (sql: string) => ({ bind: (...p: unknown[]) => (calls.push([sql, ...p]), { all: async () => ({ results: [{ a: 1 }] }), first: async () => ({ a: 1 }), run: async () => ({ meta: { changes: 1 } }) }) }) } as unknown as D1Database;
    const q = d1(db);
    expect(await q.all("select ?", 5)).toEqual([{ a: 1 }]);
    expect(await q.first("select ?", 6)).toEqual({ a: 1 });
    expect(await q.run("update x set y=?", 7)).toEqual({ changes: 1 });
    expect(calls).toEqual([["select ?", 5], ["select ?", 6], ["update x set y=?", 7]]);
  });
});

describe("sso gate helpers", () => {
  it("readSso reads the cookie; ssoLoginUrl can target /refresh", async () => {
    const { token, env } = await mint(good);
    const req = new Request("https://app.example.org/", { headers: { cookie: `sso=${token}` } });
    expect(await readSso(req, env)).toMatchObject({ ok: true, stale: false });
    expect(await readSso(new Request("https://app.example.org/"), env)).toMatchObject({ ok: false });
    const allow = { ...env, SSO_RETURN_ORIGINS: "https://app.example.org" };
    expect(ssoLoginUrl("https://app.example.org/a?b=1", allow)).toBe("https://auth.example.com/login?return=https%3A%2F%2Fapp.example.org%2Fa%3Fb%3D1");
    expect(ssoLoginUrl("https://app.example.org/", allow, true)).toMatch(/^https:\/\/auth\.example\.com\/refresh\?return=/);
  });
});

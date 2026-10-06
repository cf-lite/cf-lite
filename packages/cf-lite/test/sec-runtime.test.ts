/** Runtime security corpus (roadmap-1.0 §2.2): CSRF, sealed sessions, SSO/JWT, open redirect, SSRF, cache poisoning/deception. */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { csrf, csrfVerdict } from "../src/modules/csrf.js";
import { csrf as sessionCsrf, getSession, sealData, session, unsealData, safeEqual } from "../src/modules/session.js";
import { verifySsoToken, ssoLoginUrl } from "../src/modules/sso.js";
import { safeRedirectUrl, safeReturnTo } from "../src/modules/safe-redirect.js";
import { safeReturnTo as oauthSafeReturnTo } from "../src/modules/oauth.js";
import { hostAllowed } from "../src/modules/images.js";
import { createCacheRoute, normalizeUrl, pathTag } from "../src/modules/cache.js";

// ------------------------------------------------------------------ CSRF
describe("CSRF enforcement", () => {
  const U = "https://app.test/act";
  const req = (method: string, h: Record<string, string> = {}, ct = "application/x-www-form-urlencoded", url = U) =>
    new Request(url, { method, headers: { ...(ct ? { "content-type": ct } : {}), ...h }, body: "a=1" });
  const app = new Hono().use("*", csrf()).all("/act", (c) => c.text(`ran ${c.req.method}`));
  const call = (method: string, h: Record<string, string>, ct = "application/x-www-form-urlencoded") => app.request(req(method, h, ct));

  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s without Origin / Sec-Fetch-Site is refused, same-origin passes", async (m) => {
    expect((await call(m, {})).status).toBe(403);
    expect((await call(m, { origin: "https://evil.test" })).status).toBe(403);
    expect((await call(m, { origin: "https://app.test" })).status).toBe(200);
  });
  it("method-override attempts cannot downgrade an unsafe request to a safe one", async () => {
    for (const h of [{ "x-http-method-override": "GET" }, { "x-method-override": "GET" }, { "x-http-method": "HEAD" }])
      expect((await call("POST", { ...h, origin: "https://evil.test" })).status).toBe(403);
    // the reverse: a GET carrying an override to POST stays a GET (no state change, never "ran POST")
    const g = await app.request(new Request(U + "?_method=POST", { headers: { "x-http-method-override": "POST" } }));
    expect(await g.text()).toBe("ran GET");
  });
  it("multipart / text/plain cross-site forms are refused before the body is read", async () => {
    expect((await call("POST", { "sec-fetch-site": "cross-site", origin: "https://evil.test" }, "multipart/form-data; boundary=x")).status).toBe(403);
    expect((await call("POST", { "sec-fetch-site": "cross-site" }, "text/plain")).status).toBe(403);
    expect((await call("POST", { origin: "https://app.test" }, "multipart/form-data; boundary=x")).status).toBe(200);
  });
  it("same-origin metadata cannot be forged around a foreign Origin; content-type tricks do not pass the allow-list", () => {
    expect(csrfVerdict(req("POST", { "sec-fetch-site": "cross-site", origin: "https://app.test" })).ok).toBe(false);
    expect(csrfVerdict(req("POST", { origin: "https://app.test, https://evil.test" })).ok).toBe(false); // folded duplicate Origin headers
    expect(csrfVerdict(req("POST", { origin: "HTTPS://APP.TEST" })).ok).toBe(false); // browsers send lowercase; be strict
    for (const ct of ["application/x-www-form-urlencoded-evil", "multipart/form-data-x", "text/plain;application/x-www-form-urlencoded", "application/json; x=application/x-www-form-urlencoded"])
      expect(csrfVerdict(req("POST", { origin: "https://app.test" }, ct))).toMatchObject({ ok: false, status: 415 });
    expect(csrfVerdict(req("POST", { origin: "https://app.test" }, "Application/X-WWW-Form-Urlencoded; charset=utf-8")).ok).toBe(true);
  });
  it("session.csrf() (token mode) rejects bad origin and a missing/forged token", async () => {
    const a = new Hono<any>().use("*", session({ secrets: "k".repeat(40) })).use("*", sessionCsrf({ requireToken: true })).post("/x", (c) => c.text("ran")).get("/t", (c) => c.text(getSession(c).csrfToken()));
    const t = await a.request("http://t.example/t");
    const cookie = t.headers.get("set-cookie")!.split(";")[0], token = await t.text();
    const post = (h: Record<string, string>) => a.request("http://t.example/x", { method: "POST", headers: { origin: "http://t.example", cookie, ...h } });
    expect((await post({})).status).toBe(403);
    expect((await post({ "x-csrf-token": token + "x" })).status).toBe(403);
    expect((await post({ "x-csrf-token": token })).status).toBe(200);
    expect((await post({ "x-csrf-token": token, origin: "http://evil.test" })).status).toBe(403);
  });
});

// ------------------------------------------------------------------ sealed cookie / sessions
describe("sealed-cookie format review", () => {
  const S = "s".repeat(40);
  it("IV is unique per seal (1000 seals) and ciphertext of equal plaintext differs", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add((await sealData({ a: 1 }, S, "n")).split(".")[2]);
    expect(seen.size).toBe(1000);
  });
  it("format is fixed: version 1 only, 12-byte IV, no algorithm field; every other shape unseals to null", async () => {
    const tok = await sealData({ a: 1 }, S, "n");
    const [v, kid, iv, ct] = tok.split(".");
    expect(v).toBe("1");
    const bad = [`2.${kid}.${iv}.${ct}`, `0.${kid}.${iv}.${ct}`, `1.${kid}.${iv}`, `1.${kid}.${iv}.${ct}.x`, `1.${kid}.${iv.slice(2)}.${ct}`, `1.${kid}.${iv}.${ct.slice(0, -2)}AA`, `1.zzzzzz.${iv}.${ct}`, `1.${kid}.${iv}.${ct}=`, `1.${kid}.${iv} .${ct}`, "", "1....", "null", "{}", "ey" + "JhbGciOiJub25lIn0" + ".e30."];
    for (const b of bad) expect(await unsealData(b, S, "n"), b).toBeNull();
    expect(await unsealData(tok, S, "n")).toEqual({ a: 1 });
  });
  it("plaintext never appears in the cookie; the kid reveals nothing usable (rotation picks the key by kid)", async () => {
    const tok = await sealData({ role: "admin-secret-marker" }, S, "n");
    expect(Buffer.from(tok.replace(/[.\-_]/g, "A"), "base64").toString("latin1")).not.toContain("admin-secret-marker");
    expect(tok).not.toContain("admin");
  });
  it("sealed login mints a new cookie (new iat + IV); the pre-login cookie never becomes authenticated (fixation)", async () => {
    const app = new Hono<any>().use("*", session({ secrets: S })).post("/seed", (c) => { getSession(c).set("planted", "by-attacker"); return c.text("ok"); })
      .post("/login", async (c) => { await getSession(c).login("victim"); return c.text("ok"); }).get("/me", (c) => c.json(getSession(c).userId ?? null));
    const seed = await app.request("http://t.example/seed", { method: "POST" });
    const planted = seed.headers.get("set-cookie")!.split(";")[0];
    const login = await app.request("http://t.example/login", { method: "POST", headers: { cookie: planted } });
    const after = login.headers.get("set-cookie")!.split(";")[0];
    expect(after).not.toBe(planted);
    expect(await (await app.request("http://t.example/me", { headers: { cookie: planted } })).json()).toBeNull(); // attacker still holds the anonymous one
    expect(await (await app.request("http://t.example/me", { headers: { cookie: after } })).json()).toBe("victim");
  });
  it("cookie prefix / flags: https => __Host- + Secure + HttpOnly + SameSite, no Domain; a plain `session` cookie is ignored on https", async () => {
    const app = new Hono<any>().use("*", session({ secrets: S })).post("/login", async (c) => { await getSession(c).login("u"); return c.text("ok"); }).get("/me", (c) => c.json(getSession(c).userId ?? null));
    const r = await app.request("https://t.example/login", { method: "POST" });
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(/^__Host-session=/); expect(sc).toMatch(/; Secure/); expect(sc).toMatch(/; HttpOnly/); expect(sc).toMatch(/; SameSite=Lax/); expect(sc).not.toMatch(/Domain=/);
    const value = sc.split(";")[0].split("=")[1];
    // cookie tossing from a sibling subdomain can only set a non-__Host- cookie: it must not authenticate
    expect(await (await app.request("https://t.example/me", { headers: { cookie: `session=${value}` } })).json()).toBeNull();
    expect(await (await app.request("https://t.example/me", { headers: { cookie: `__Host-session=${value}` } })).json()).toBe("u");
  });
  it("safeEqual: equal-length and different-length inputs both compare correctly (no prefix short-circuit semantics)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    for (const [a, b] of [["abc", "abd"], ["abc", "ab"], ["", "a"], ["abc", "abcd"], ["é", "e"]]) expect(safeEqual(a, b)).toBe(false);
  });
});

// ------------------------------------------------------------------ SSO / JWT
const b64u = (b: ArrayBuffer | string) => Buffer.from(typeof b === "string" ? b : new Uint8Array(b)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const good = { sub: "alice", iat: now, exp: now + 600, iss: "auth.example.com", aud: "example" };
async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { kp, pub: Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64") };
}
describe("SSO / JWT negative corpus", () => {
  const sign = async (kp: CryptoKeyPair, header: object | string, claims: object | string, rawSig?: string) => {
    const h = b64u(typeof header === "string" ? header : JSON.stringify(header)), p = b64u(typeof claims === "string" ? claims : JSON.stringify(claims));
    return `${h}.${p}.${rawSig ?? b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(h + "." + p)))}`;
  };
  const env = (pub: string, extra: object = {}) => ({ SSO_PUBLIC_KEYS: JSON.stringify({ k1: pub }), SSO_ISSUER: "auth.example.com", SSO_AUDIENCE: "example", ...extra });
  const H = { alg: "EdDSA", typ: "JWT", kid: "k1" };

  it("alg pinning: none / HS256 / RS256 / ES256 / lowercase / array / missing are all refused", async () => {
    const { kp, pub } = await keypair();
    for (const alg of ["none", "None", "HS256", "RS256", "ES256", "eddsa", "EdDSA ", ["EdDSA"], undefined, null, 1]) {
      const t = await sign(kp, { ...H, alg }, good);
      expect(await verifySsoToken(t, env(pub)), String(alg)).toEqual({ ok: false, reason: "bad header" });
    }
    expect(await verifySsoToken(`${b64u(JSON.stringify({ ...H, alg: "none" }))}.${b64u(JSON.stringify(good))}.`, env(pub))).toMatchObject({ ok: false });
  });
  it("HS256 key-confusion: a token MAC'd with the public key as the secret does not verify", async () => {
    const { pub } = await keypair();
    const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "k1" })), p = b64u(JSON.stringify(good));
    const k = await crypto.subtle.importKey("raw", Buffer.from(pub, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = b64u(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(h + "." + p)));
    expect(await verifySsoToken(`${h}.${p}.${sig}`, env(pub))).toMatchObject({ ok: false });
  });
  it("kid confusion: unknown / missing / non-string / prototype-key / path-like kids are refused", async () => {
    const { kp, pub } = await keypair();
    for (const kid of ["k2", "", "__proto__", "constructor", "toString", "hasOwnProperty", "../k1", "k1 ", "K1", 1, null, undefined, ["k1"]]) {
      const r = await verifySsoToken(await sign(kp, { ...H, kid }, good), env(pub));
      expect(r.ok, String(kid)).toBe(false);
    }
  });
  it("a token signed by another key, with the right kid, is refused; key rotation by kid works", async () => {
    const a = await keypair(), b = await keypair();
    expect(await verifySsoToken(await sign(b.kp, H, good), env(a.pub))).toEqual({ ok: false, reason: "bad signature" });
    const both = { SSO_PUBLIC_KEYS: JSON.stringify({ k1: a.pub, k2: b.pub }), SSO_ISSUER: "auth.example.com", SSO_AUDIENCE: "example" };
    expect(await verifySsoToken(await sign(b.kp, { ...H, kid: "k2" }, good), both)).toMatchObject({ ok: true });
    expect(await verifySsoToken(await sign(b.kp, { ...H, kid: "k1" }, good), both)).toEqual({ ok: false, reason: "bad signature" });
  });
  it("JWKS form: only OKP/Ed25519 keys are imported (an RSA/Ed448 entry never becomes a verifier)", async () => {
    const { kp, pub } = await keypair();
    const x = Buffer.from(pub, "base64").toString("base64url");
    const jwks = { keys: [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }, { kty: "OKP", crv: "Ed448", kid: "k1", x }, { kty: "OKP", crv: "Ed25519", kid: "k3", x }] };
    const e = { SSO_PUBLIC_KEYS: JSON.stringify(jwks), SSO_ISSUER: "auth.example.com", SSO_AUDIENCE: "example" };
    expect(await verifySsoToken(await sign(kp, H, good), e)).toEqual({ ok: false, reason: "unknown kid" });
    expect(await verifySsoToken(await sign(kp, { ...H, kid: "k3" }, good), e)).toMatchObject({ ok: true });
  });
  it("issuer/audience are required, exact, and fail closed", async () => {
    const { kp, pub } = await keypair();
    const t = await sign(kp, H, good);
    for (const e of [{ SSO_ISSUER: "" }, { SSO_AUDIENCE: "" }, { SSO_AUDIENCE: undefined }, { SSO_ISSUER: undefined }])
      expect(await verifySsoToken(t, { ...env(pub), ...e })).toMatchObject({ ok: false, config: true });
    for (const c of [{ iss: "AUTH.example.com" }, { iss: "auth.example.com/" }, { iss: undefined }, { iss: ["auth.example.com"] }, { aud: undefined }, { aud: "Example" }, { aud: ["a", "b"] }, { aud: 5 }, { aud: {} }, { aud: [["example"]] }])
      expect(await verifySsoToken(await sign(kp, H, { ...good, ...c }), env(pub)), JSON.stringify(c)).toEqual({ ok: false, reason: "wrong iss/aud" });
  });
  it("clock skew: exp is strict, nbf/iat tolerate 60 s, 61 s is refused; exp<=iat refused", async () => {
    const { kp, pub } = await keypair();
    const v = async (c: object) => verifySsoToken(await sign(kp, H, { ...good, ...c }), env(pub), now);
    expect((await v({ exp: now })).ok).toBe(false);
    expect((await v({ exp: now + 1 })).ok).toBe(true);
    expect((await v({ nbf: now + 60 })).ok).toBe(true);
    expect(await v({ nbf: now + 61 })).toEqual({ ok: false, reason: "not yet valid" });
    expect(await v({ nbf: "0" })).toEqual({ ok: false, reason: "not yet valid" });
    expect((await v({ iat: now + 60, exp: now + 900 })).ok).toBe(true);
    expect(await v({ iat: now + 61, exp: now + 900 })).toEqual({ ok: false, reason: "iat in future" });
    expect(await v({ iat: now - 10, exp: now - 10 + 1000, nbf: undefined })).toMatchObject({ ok: true });
    expect(await v({ iat: now + 30, exp: now + 30 })).toMatchObject({ ok: false });
  });
  it("claims: sub / exp / iat must have the right types; allow-list is case-insensitive exact", async () => {
    const { kp, pub } = await keypair();
    for (const c of [{ sub: "" }, { sub: 1 }, { sub: undefined }, { exp: "9999999999" }, { exp: undefined }, { iat: "1" }, { iat: undefined }])
      expect((await verifySsoToken(await sign(kp, H, { ...good, ...c }), env(pub), now)).ok, JSON.stringify(c)).toBe(false);
    const t = await sign(kp, H, good);
    expect((await verifySsoToken(t, env(pub, { SSO_ALLOWED_LOGINS: "ALICE" }))).ok).toBe(true);
    expect((await verifySsoToken(t, env(pub, { SSO_ALLOWED_LOGINS: "alic" }))).ok).toBe(false);
    expect((await verifySsoToken(t, env(pub, { SSO_ALLOWED_LOGINS: "alice2,bob" }))).ok).toBe(false);
  });
  it("malformed tokens never throw: segment counts, non-JSON, non-base64url, padding / whitespace / `+` `/` variants", async () => {
    const { kp, pub } = await keypair();
    const t = await sign(kp, H, good), [h, p, s] = t.split(".");
    const junk = ["", "a", "a.b", "a.b.c.d", "..", `${h}.${p}.`, `${h}.${p}`, `${h}.${p}.${s}.`, `.${p}.${s}`, `${h}..${s}`, `${h}.${p}.${s}=`, `${h}.${p}.${s}%`, `${h} .${p}.${s}`, `${h}.${p}.${s.slice(0, -3)}`, `${h}.${p}.${s.replace(/./, "+")}`,
      `${b64u("not json")}.${p}.${s}`, `${h}.${b64u("[1]")}.${s}`, `${h}.${b64u("null")}.${s}`, `${b64u("null")}.${p}.${s}`];
    for (const j of junk) { const r = await verifySsoToken(j, env(pub)); expect(r.ok, j).toBe(false); }
    expect((await verifySsoToken(t, env(pub))).ok).toBe(true);
    // a valid token with whitespace injected into a segment is NOT accepted (atob would tolerate it)
    expect((await verifySsoToken(`${h}.${p.slice(0, 5)}\n${p.slice(5)}.${s}`, env(pub))).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ open redirect
describe("open-redirect allow-list", () => {
  const evil = ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\u0000/evil.example", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "vbscript:x", "evil.example", "/ /evil.example\u0000", "///evil.example", "/" + "a".repeat(3000), "https:evil.example", "http:/evil.example"];
  it.each(evil)("safeReturnTo / safeRedirectUrl refuse %j", (v) => {
    expect(safeReturnTo(v, "/home")).toBe("/home");
    expect(safeRedirectUrl(v, { fallback: "/home" })).toBe("/home");
    expect(oauthSafeReturnTo(v, "/home")).toBe("/home"); // the oauth module re-exports the same guard
  });
  it("relative paths survive, absolute only from the explicit origin allow-list (exact origin, no credentials)", () => {
    const o = { allowedOrigins: ["https://app.example", "https://www.example:8443/ignored/path"], fallback: "/x" };
    expect(safeRedirectUrl("/a/b?c=1#d", o)).toBe("/a/b?c=1#d");
    expect(safeRedirectUrl("https://app.example/dash?x=1", o)).toBe("https://app.example/dash?x=1");
    expect(safeRedirectUrl("https://www.example:8443/z", o)).toBe("https://www.example:8443/z");
    for (const v of ["https://app.example.evil.example/", "https://evil.example/https://app.example", "https://app.example@evil.example/", "https://user:pw@app.example/", "http://app.example/", "https://app.example:444/", "https://APP.example.evil/", "https://app.example\\@evil.example/", "https://app.example%2F@evil.example", "ftp://app.example/"])
      expect(safeRedirectUrl(v, o), v).toBe("/x");
    expect(safeRedirectUrl("https://app.example/", {})).toBe("/"); // no allow-list = relative only
  });
  it("ssoLoginUrl: secure by default - relative paths only unless the origin is allow-listed", () => {
    const env = { SSO_AUTH_ORIGIN: "https://auth.example.com/" };
    expect(ssoLoginUrl("/dash?x=1", env)).toBe("https://auth.example.com/login?return=%2Fdash%3Fx%3D1");
    // no allow-list: absolute URLs (even a plausible own origin) are refused
    for (const r of ["https://evil.example/x", "https://app.example/dash", "http://evil.example", "javascript:alert(1)"])
      expect(() => ssoLoginUrl(r, env), r).toThrow(/not a relative path/);
    // protocol-relative / backslash / control-char variants, with and without a list
    for (const r of ["//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example", "/\t/evil.example", "/\n/evil.example", ""]) {
      expect(() => ssoLoginUrl(r, env), r).toThrow(/not a relative path/);
      expect(() => ssoLoginUrl(r, env, false, ["https://app.example"]), r).toThrow(/not a relative path/);
      expect(() => ssoLoginUrl(r, { ...env, SSO_RETURN_ORIGINS: "https://app.example" }), r).toThrow(/not a relative path/);
    }
    // explicitly allow-listed origin is accepted (4th arg or SSO_RETURN_ORIGINS)
    expect(ssoLoginUrl("/dash", env, false, ["https://app.example"])).toBe("https://auth.example.com/login?return=%2Fdash");
    expect(ssoLoginUrl("https://app.example/dash", env, true, ["https://app.example"])).toContain("/refresh?return=");
    for (const r of ["https://evil.example/", "javascript:alert(1)", "https://app.example.evil.example/"])
      expect(() => ssoLoginUrl(r, env, false, ["https://app.example"]), r).toThrow(/not a relative path/);
    const list = { ...env, SSO_RETURN_ORIGINS: "https://app.example, https://b.example" };
    expect(() => ssoLoginUrl("https://evil.example/", list)).toThrow();
    expect(ssoLoginUrl("https://b.example/p", list)).toContain("b.example");
    // an explicit empty 4th arg is not "unset": still relative-only
    expect(() => ssoLoginUrl("https://app.example/", env, false, [])).toThrow();
  });
});

// ------------------------------------------------------------------ SSRF
describe("SSRF allow-list (image loader host check)", () => {
  const allow = ["cdn.ok.org", "*.img.ok.org"];
  it("only exact / wildcard-subdomain hosts pass", () => {
    expect(hostAllowed("cdn.ok.org", allow)).toBe(true);
    expect(hostAllowed("CDN.OK.ORG", allow)).toBe(true);
    expect(hostAllowed("a.img.ok.org", allow)).toBe(true);
    expect(hostAllowed("a.b.img.ok.org", allow)).toBe(true);
    for (const h of ["img.ok.org", "ok.org", "cdn.ok.org.evil.com", "evilcdn.ok.org", "xcdn.ok.org", "evil.com", "cdn.ok.org@evil.com", "", "evilimg.ok.org"]) expect(hostAllowed(h, allow), h).toBe(false);
  });
  it("private / loopback / link-local / metadata names are refused even when listed; trailing dots do not bypass", () => {
    const listed = ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "172.16.0.1", "172.31.255.255", "[::1]", "[fd00::1]", "metadata.google.internal", "svc.local", "foo.localhost", "0.0.0.0", "1.2.3.4", "localhost.", "169.254.169.254.", "foo.localhost.", "metadata.google.internal."];
    for (const h of listed) expect(hostAllowed(h, listed), h).toBe(false);
    expect(hostAllowed("172.32.0.1.example.org", ["172.32.0.1.example.org"])).toBe(true); // a real DNS name that merely looks numeric-ish
    expect(hostAllowed("cdn.ok.org.", ["cdn.ok.org"])).toBe(true); // an absolute-FQDN spelling of an allowed host stays allowed
  });
  it("URL parsing normalises numeric host spellings to dotted form before the check", () => {
    for (const u of ["https://2130706433/", "https://0x7f.1/", "https://127.1/", "https://017700000001/", "https://0177.0.0.1/"]) {
      const h = new URL(u).hostname;
      expect(hostAllowed(h, [h]), u + " -> " + h).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ cache poisoning / deception
describe("cache key normalisation + trust boundaries", () => {
  function setup(mod: object, handler?: (req: Request) => Response) {
    const m = new Map<string, { status: number; headers: [string, string][]; body: string }>();
    const cache = { async match(k: Request) { const e = m.get(k.url); return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined; }, async put(k: Request, r: Response) { m.set(k.url, { status: r.status, headers: [...r.headers], body: await r.text() }); } } as unknown as Cache;
    let n = 0;
    const route = createCacheRoute({ cache: () => cache, now: () => 1_000_000, dev: false })(mod as never, async (c) => { n++; return handler ? handler(c.req.raw) : new Response("render " + n + " " + c.req.header("x-forwarded-host"), { headers: { "content-type": "text/html" } }); });
    const app = new Hono().get("*", route);
    const get = async (url: string, h: Record<string, string> = {}) => { const r = await app.request(url, { headers: h }); await r.text(); return r.headers.get("x-cf-lite-cache"); };
    return { get, keys: () => [...m.keys()], renders: () => n };
  }
  const mod = { cache: { maxAge: 60 } };

  it("x-forwarded-* / x-original-url / x-rewrite-url / forwarded headers are neither trusted nor part of the key", async () => {
    const t = setup(mod);
    await t.get("http://t.example/p");
    for (const h of [{ "x-forwarded-host": "evil.example" }, { "x-forwarded-proto": "http" }, { "x-forwarded-for": "6.6.6.6" }, { "x-original-url": "/admin" }, { "x-rewrite-url": "/admin" }, { forwarded: "host=evil.example;proto=http" }, { "x-host": "evil.example" }, { "x-forwarded-prefix": "/evil" }])
      expect(await t.get("http://t.example/p", h), JSON.stringify(h)).toBe("HIT");
    expect(t.keys()).toEqual(["http://t.example/p"]); // exactly one entry, keyed by the real URL
  });
  it("Host is part of the key: one host can never read or poison another host's entry", async () => {
    const t = setup(mod);
    await t.get("http://a.example/p"); await t.get("http://b.example/p");
    expect(t.keys().sort()).toEqual(["http://a.example/p", "http://b.example/p"]);
    expect(await t.get("http://A.EXAMPLE/p")).toBe("HIT"); // hostname is case-folded by URL
    expect(await t.get("http://a.example:8080/p")).toBe("MISS"); // another port = another origin
  });
  it("path / query spellings that mean the same thing share an entry; different things never do", async () => {
    const t = setup(mod);
    await t.get("http://t.example/a/b?x=1&y=2");
    for (const u of ["http://t.example/a/./b?y=2&x=1", "http://t.example/a/c/../b?x=1&y=2", "http://t.example/a/b?x=1&y=2#frag", "http://t.example/a/b?utm_source=z&x=1&y=2", "http://t.example/a/b?x=%31&y=2"]) expect(await t.get(u), u).toBe("HIT");
    for (const u of ["http://t.example/A/b?x=1&y=2", "http://t.example/a/b/?x=1&y=2", "http://t.example/a%2Fb?x=1&y=2", "http://t.example/a/b?x=1&y=2&x=1", "http://t.example/a/b?x=1;y=2"]) expect(await t.get(u), u).toBe("MISS");
  });
  it("the vary-hash param cannot be injected in any spelling; huge / repeated params stay in the key", async () => {
    expect(normalizeUrl("https://a.example/p?__CFLV=1&__cflv=2&a=1").search).toBe("?a=1");
    const t = setup({ cache: { maxAge: 60, vary: ["accept-language"] } });
    await t.get("http://t.example/p?a=1", { "accept-language": "fr" });
    expect(await t.get("http://t.example/p?a=1&__cflv=deadbeef", { "accept-language": "en" })).toBe("MISS");
    expect(await t.get("http://t.example/p?a=1&__cflv=deadbeef", { "accept-language": "fr" })).toBe("HIT");
  });
  it("deception: a response that varies by Cookie/Authorization (or sets a cookie, or is private) is never stored", async () => {
    for (const hdr of [{ vary: "Cookie" }, { vary: "Accept-Encoding, cookie" }, { vary: "Authorization" }, { vary: "*" }, { "set-cookie": "a=b" }, { "cache-control": "private" }, { "cache-control": "no-store" }]) {
      const t = setup(mod, () => new Response("secret page", { headers: { "content-type": "text/html", ...hdr } }));
      expect(await t.get("http://t.example/p"), JSON.stringify(hdr)).toBe("BYPASS");
      expect(await t.get("http://t.example/p"), JSON.stringify(hdr)).toBe("BYPASS");
      expect(t.keys()).toEqual([]);
    }
    const ok = setup(mod, () => new Response("public", { headers: { "content-type": "text/html", vary: "Accept-Encoding" } }));
    await ok.get("http://t.example/p"); expect(await ok.get("http://t.example/p")).toBe("HIT");
  });
  it("authenticated / draft / read-your-writes requests bypass in both directions (never read, never write)", async () => {
    const t = setup(mod);
    await t.get("http://t.example/p");
    for (const c of ["session=x", "__Host-session=x", "sso=x", "a=b; __cfl_preview=1"]) expect(await t.get("http://t.example/p", { cookie: c }), c).toBe("BYPASS");
    expect(await t.get("http://t.example/p", { authorization: "Basic eDp5" })).toBe("BYPASS");
    expect(t.keys()).toHaveLength(1);
    // an authenticated request first can't seed the cache for anonymous users
    const t2 = setup(mod);
    expect(await t2.get("http://t.example/p", { cookie: "session=x" })).toBe("BYPASS");
    expect(await t2.get("http://t.example/p")).toBe("MISS");
    // a cookie whose NAME merely contains an auth name does not count (exact names), but one with a different case also does not (cookies are case-sensitive)
    expect(await t2.get("http://t.example/p", { cookie: "mysession=x" })).toBe("HIT");
  });
  it("purge tags are path-normalised: trailing slash, query and hash cannot dodge a path purge", () => {
    for (const p of ["/a/b", "/a/b/", "https://x.example/a/b?q=1#h", "/a/b?x=/"]) expect(pathTag(p)).toBe("path:/a/b");
    expect(pathTag("/A/b")).not.toBe(pathTag("/a/b"));
  });
});

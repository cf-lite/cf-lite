import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { b64u } from "../src/modules/session.js";
import { d1Accounts, finishLogin, github, oidc, pkce, safeReturnTo, startLogin, OAuthError, type OAuthClient } from "../src/modules/oauth.js";

const SECRET = "s".repeat(40);
let srv: Server, base: string;
let rsa: CryptoKeyPair, rsa2: CryptoKeyPair, ec: CryptoKeyPair, rsaJwk: JsonWebKey, ecJwk: JsonWebKey;
// mock IdP knobs
const idp = { sub: "idp-user-1", email: "a@example.com", verified: true, alg: "RS256" as "RS256" | "ES256" | "none" | "HS256", aud: "", iss: "", nonceOverride: undefined as string | undefined, expired: false, badSig: false, seen: [] as Record<string, string>[], omitIdToken: false, codeOk: true, wrongKey: undefined as CryptoKeyPair | undefined };

async function signJwt(claims: object, alg: string) {
  const head = b64u(new TextEncoder().encode(JSON.stringify({ alg, typ: "JWT", kid: "k" })));
  const body = b64u(new TextEncoder().encode(JSON.stringify(claims)));
  if (alg === "none") return `${head}.${body}.`;
  if (alg === "HS256") return `${head}.${body}.${b64u(new Uint8Array(32))}`;
  const pair = idp.wrongKey ?? (alg === "ES256" ? ec : rsa);
  const algo = alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  let sig = new Uint8Array(await crypto.subtle.sign(algo, pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  if (idp.badSig) sig = sig.map((x) => x ^ 1);
  return `${head}.${body}.${b64u(sig)}`;
}

beforeAll(async () => {
  rsa = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  rsa2 = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  rsaJwk = { ...(await crypto.subtle.exportKey("jwk", rsa.publicKey)), kid: "k" }; ecJwk = { ...(await crypto.subtle.exportKey("jwk", ec.publicKey)), kid: "k" };
  srv = createServer(async (req, res) => {
    const u = new URL(req.url!, base); const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString(); const json = (o: unknown, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/.well-known/openid-configuration") return json({ issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", userinfo_endpoint: base + "/userinfo", jwks_uri: base + "/jwks" });
    if (u.pathname === "/jwks") return json({ keys: [idp.alg === "ES256" ? ecJwk : rsaJwk] });
    if (u.pathname === "/token") {
      const f = Object.fromEntries(new URLSearchParams(body)); idp.seen.push({ ...f, auth: String(req.headers.authorization ?? "") });
      if (!idp.codeOk || f.code !== "good-code") return json({ error: "invalid_grant" }, 400);
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: idp.iss || base, aud: idp.aud || f.client_id, sub: idp.sub, email: idp.email, email_verified: idp.verified, iat: now, exp: idp.expired ? now - 3600 : now + 600, nonce: idp.nonceOverride ?? idp.nonce };
      return json({ access_token: "at-1", token_type: "Bearer", ...(idp.omitIdToken ? {} : { id_token: await signJwt(claims, idp.alg) }) });
    }
    if (u.pathname === "/userinfo") return req.headers.authorization === "Bearer at-1" ? json({ sub: "gh-77", id: 77, login: "octo", email: "o@example.com" }) : json({}, 401);
    json({}, 404);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));
(idp as Record<string, unknown>).nonce = "";

const cb = "https://app.example/auth/callback";
async function client(): Promise<OAuthClient> { return oidc(base, { clientId: "cid", clientSecret: "csec", redirectUri: cb }); }
/** run start -> (provider redirect) -> callback request */
async function flow(cl: OAuthClient, o: { tamperState?: boolean; code?: string; drop?: boolean; returnTo?: string } = {}) {
  const st = await startLogin(cl, { secrets: SECRET, returnTo: o.returnTo });
  const u = new URL(st.url);
  (idp as Record<string, unknown>).nonce = u.searchParams.get("nonce") ?? "";
  const q = new URLSearchParams({ code: o.code ?? "good-code", state: o.tamperState ? "x" + u.searchParams.get("state") : u.searchParams.get("state")! });
  const headers: Record<string, string> = o.drop ? {} : { cookie: st.cookie.split(";")[0] };
  return { st, u, run: () => finishLogin(cl, new Request(cb + "?" + q, { headers }), { secrets: SECRET }) };
}
const reset = () => Object.assign(idp, { alg: "RS256", nonceOverride: undefined, expired: false, badSig: false, omitIdToken: false, codeOk: true, wrongKey: undefined, aud: "", iss: "", seen: [], verified: true });

describe("oauth (mock IdP)", () => {
  it("happy path: PKCE S256 + state + nonce, code exchanged with the verifier, profile from verified id_token", async () => {
    reset(); const f = await flow(await client(), { returnTo: "/dash?x=1" });
    expect(f.u.origin + f.u.pathname).toBe(base + "/authorize");
    expect(f.u.searchParams.get("code_challenge_method")).toBe("S256"); expect(f.u.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(f.u.searchParams.get("redirect_uri")).toBe(cb); expect(f.u.searchParams.get("scope")).toBe("openid email profile");
    expect(f.st.cookie).toMatch(/^__Host-oauth-oidc=.*HttpOnly.*SameSite=Lax.*Secure/);
    const r = await f.run();
    expect(r.profile).toMatchObject({ id: "idp-user-1", email: "a@example.com", emailVerified: true }); expect(r.returnTo).toBe("/dash?x=1"); expect(r.clearCookie).toMatch(/Max-Age=0/);
    const sent = idp.seen[0]; expect(sent.grant_type).toBe("authorization_code"); expect(sent.client_secret).toBe("csec");
    const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sent.code_verifier)));
    expect(challenge).toBe(f.u.searchParams.get("code_challenge"));
  });
  it("ES256 id_tokens verify too", async () => { reset(); idp.alg = "ES256"; expect((await (await flow(await client())).run()).profile.id).toBe("idp-user-1"); });
  it("rejects: tampered state, missing cookie, replayed cookie after clear, bad code, provider error", async () => {
    reset(); const cl = await client();
    await expect((await flow(cl, { tamperState: true })).run()).rejects.toMatchObject({ code: "bad_state" });
    await expect((await flow(cl, { drop: true })).run()).rejects.toMatchObject({ code: "bad_transaction" });
    await expect((await flow(cl, { code: "evil" })).run()).rejects.toMatchObject({ code: "token_exchange_failed" });
    await expect(finishLogin(cl, new Request(cb + "?error=access_denied"), { secrets: SECRET })).rejects.toMatchObject({ code: "provider_error" });
  });
  it("rejects transaction cookie from another secret / expired", async () => {
    reset(); const cl = await client();
    const st = await startLogin(cl, { secrets: SECRET, now: () => 1000 });
    const u = new URL(st.url); const mk = (now: number, secrets = SECRET) => finishLogin(cl, new Request(cb + `?code=good-code&state=${u.searchParams.get("state")}`, { headers: { cookie: st.cookie.split(";")[0] } }), { secrets, now: () => now });
    await expect(mk(1000 + 601)).rejects.toMatchObject({ code: "bad_transaction" });
    await expect(mk(1100, "z".repeat(40))).rejects.toMatchObject({ code: "bad_transaction" });
  });
  it("id_token negative corpus: alg none/HS256, bad signature, foreign key, wrong iss/aud, expired, wrong nonce, missing", async () => {
    const cl = await client();
    const bad = async (mut: () => void, re: RegExp) => { reset(); mut(); await expect((await flow(cl)).run()).rejects.toThrow(re); };
    await bad(() => { idp.alg = "none"; }, /unsupported alg/);
    await bad(() => { idp.alg = "HS256"; }, /unsupported alg/);
    await bad(() => { idp.badSig = true; }, /bad signature/);
    await bad(() => { idp.wrongKey = rsa2; idp.alg = "RS256"; }, /bad signature/);
    await bad(() => { idp.iss = "https://evil.example"; }, /wrong issuer/);
    await bad(() => { idp.aud = "other-client"; }, /wrong audience/);
    await bad(() => { idp.expired = true; }, /expired/);
    await bad(() => { idp.nonceOverride = "attacker"; }, /nonce mismatch/);
    await bad(() => { idp.omitIdToken = true; }, /no id_token/);
    // OAuthError wraps them
    reset(); idp.expired = true; await expect((await flow(cl)).run()).rejects.toBeInstanceOf(OAuthError);
  });
  it("non-OIDC provider (GitHub-style): profile from userinfo, basic/post auth, no nonce", async () => {
    reset();
    const gh = github({ clientId: "cid", clientSecret: "csec", redirectUri: cb });
    gh.provider.authorizeUrl = base + "/authorize"; gh.provider.tokenUrl = base + "/token"; gh.provider.userinfoUrl = base + "/userinfo";
    const f = await flow(gh); expect(f.u.searchParams.has("nonce")).toBe(false);
    const r = await f.run(); expect(r.profile).toMatchObject({ id: "77", email: "o@example.com", emailVerified: false, name: "octo" });
  });
  it("oidc discovery refuses an issuer mismatch", async () => {
    await expect(oidc(base + "/", { clientId: "c", clientSecret: "s", redirectUri: cb, fetch: async () => Response.json({ issuer: "https://evil.example" }) })).rejects.toThrow(/issuer mismatch/);
  });
  it("pkce verifier/challenge shape", async () => { const p = await pkce(); expect(p.verifier.length).toBeGreaterThanOrEqual(43); expect(p.challenge).toMatch(/^[\w-]{43}$/); });
});

describe("safeReturnTo (open redirect corpus)", () => {
  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "/\\/evil.example", "javascript:alert(1)", "evil.example", "\\\\evil", "/a\nb", "/a\r\nSet-Cookie: x", "/%0d%0a", " /x", "", "///x"])("rejects %j", (v) => {
    expect(safeReturnTo(v, "/home")).toBe(v === "/%0d%0a" ? "/%0d%0a" : "/home");
  });
  it("keeps same-site paths", () => { expect(safeReturnTo("/a/b?c=1#d")).toBe("/a/b?c=1#d"); expect(safeReturnTo(undefined)).toBe("/"); expect(safeReturnTo(null, "/x")).toBe("/x"); });
});

describe("d1Accounts linking", () => {
  const sql = readFileSync(new URL("../templates/auth/migrations/0001_auth.sql", import.meta.url), "utf8");
  function db() {
    const d = new DatabaseSync(":memory:"); d.exec(sql);
    const stmt = (s: string, a: unknown[] = []) => ({ bind: (...x: unknown[]) => stmt(s, x), first: async () => (d.prepare(s).get(...(a as never[])) as never) ?? null, run: async () => d.prepare(s).run(...(a as never[])) });
    return { d, db: { prepare: (s: string) => stmt(s) } as unknown as D1Database };
  }
  const p = (id: string, email: string, v: boolean) => ({ id, email, emailVerified: v, raw: {} });
  it("same provider account -> same user; new account -> new user; never links by email by default", async () => {
    const { db: x, d } = db(); const a = d1Accounts(x);
    const u1 = await a.findOrCreate("github", p("1", "a@x.com", true)); expect(u1.created).toBe(true);
    expect((await a.findOrCreate("github", p("1", "a@x.com", true))).userId).toBe(u1.userId);
    const u2 = await a.findOrCreate("google", p("g1", "a@x.com", true)); expect(u2.userId).not.toBe(u1.userId);
    expect((d.prepare("SELECT count(*) c FROM users").get() as { c: number }).c).toBe(2);
  });
  it("linkByVerifiedEmail links only when the IdP verified the email", async () => {
    const { db: x } = db(); const a = d1Accounts(x);
    const u1 = await a.findOrCreate("github", p("1", "a@x.com", true));
    const unverified = await a.findOrCreate("lax", p("z", "A@X.com", false), { linkByVerifiedEmail: true }); expect(unverified.userId).not.toBe(u1.userId);
    const verified = await a.findOrCreate("google", p("g", "a@x.com", true), { linkByVerifiedEmail: true }); expect(verified.userId).toBe(u1.userId);
  });
});

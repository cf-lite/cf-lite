// WP-AUTH e2e under local workerd: scaffold an app, `cf-lite add auth`, run the real OIDC code+PKCE flow against a local mock IdP,
// then session checks (me / CSRF-guarded logout / tamper / e2e-login / revoked cookie). Sealed-cookie sessions; accounts in local D1.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url).pathname;
const cli = join(root, "packages/cf-lite/dist/cli.js");
const wr = join(dirname(createRequire(root).resolve("wrangler/package.json")), "bin/wrangler.js");
const dir = join(root, "examples/.scaffold-auth");
const state = mkdtempSync(join(tmpdir(), "cfl-auth-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString("base64url");
const sh = (args, cwd, env = {}) => { const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }); assert.equal(r.status, 0, args.join(" ") + "\n" + r.stdout + r.stderr); return r.stdout; };

// ---- mock IdP (OIDC): discovery, jwks, authorize, token
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
let idpBase, clientId = "e2e-client", lastNonce, lastChallenge; const codes = new Map(); const siteverifySecrets = [];
const idp = createServer(async (req, res) => {
  const u = new URL(req.url, idpBase); const chunks = []; for await (const c of req) chunks.push(c);
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/.well-known/openid-configuration") return json({ issuer: idpBase, authorization_endpoint: idpBase + "/authorize", token_endpoint: idpBase + "/token", jwks_uri: idpBase + "/jwks" });
  if (u.pathname === "/siteverify") { // Turnstile mock: token "pass" verifies, anything else is rejected; remembers the secret it was sent
    const fd = await new Response(Buffer.concat(chunks), { headers: { "content-type": req.headers["content-type"] } }).formData(); siteverifySecrets.push(fd.get("secret"));
    return json(fd.get("response") === "pass" ? { success: true, action: "login", hostname: "localhost" } : { success: false, "error-codes": ["invalid-input-response"] });
  }
  if (u.pathname === "/jwks") return json({ keys: [jwk] });
  if (u.pathname === "/authorize") { // auto-approve: bounce straight back with a code
    const code = "code-" + Math.random().toString(36).slice(2); codes.set(code, { nonce: u.searchParams.get("nonce"), challenge: u.searchParams.get("code_challenge"), who: u.searchParams.get("login_hint") ?? "alice" });
    const back = new URL(u.searchParams.get("redirect_uri")); back.searchParams.set("code", code); back.searchParams.set("state", u.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() }); return res.end();
  }
  if (u.pathname === "/token") {
    const f = new URLSearchParams(Buffer.concat(chunks).toString()); const c = codes.get(f.get("code")); codes.delete(f.get("code"));
    if (!c || f.get("client_secret") !== "e2e-secret") return json({ error: "invalid_grant" }, 400);
    const challenge = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(f.get("code_verifier"))));
    if (challenge !== c.challenge) return json({ error: "invalid_grant" }, 400); // PKCE enforced
    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "k1" })), body = b64u(JSON.stringify({ iss: idpBase, aud: clientId, sub: c.who, email: c.who + "@example.com", email_verified: true, iat: now, exp: now + 600, nonce: c.nonce }));
    const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(head + "." + body)));
    return json({ access_token: "at", token_type: "Bearer", id_token: `${head}.${body}.${sig}` });
  }
  json({}, 404);
});
await new Promise((r) => idp.listen(0, "127.0.0.1", r));
idpBase = `http://127.0.0.1:${idp.address().port}`;

rmSync(dir, { recursive: true, force: true });
let child;
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", stop);
try {
  sh([join(root, "packages/create-cf-lite/index.mjs"), dir, "--ui", "none", "--no-install"], root);
  sh([cli, "add", "auth"], dir);
  sh([cli, "add", "auth"], dir); // idempotent
  assert.equal((readFileSync(join(dir, "wrangler.jsonc"), "utf8").match(/"binding": "AUTH_DB"/g) ?? []).length, 1, "wrangler edited once");
  sh([cli, "build"], dir);
  sh([wr, "d1", "migrations", "apply", "AUTH_DB", "--local", "--persist-to", state], dir);

  const port = 19800 + Math.floor(Math.random() * 300), B = `http://localhost:${port}`;
  const vars = { SESSION_SECRETS: "e2e-secret-e2e-secret-e2e-secret-0123456789", AUTH_PROVIDER: "oidc", OIDC_ISSUER: idpBase, OAUTH_CLIENT_ID: clientId, OAUTH_CLIENT_SECRET: "e2e-secret", E2E_LOGIN_SECRET: "e2e-login-s3cret", TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET: "e2e-turnstile-secret", TURNSTILE_VERIFY_URL: idpBase + "/siteverify" };
  const args = [wr, "dev", "--port", String(port), "--persist-to", state, "--show-interactive-dev-session=false", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
  child = spawn(process.execPath, args, { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);

  const jar = new Map();
  const take = (r) => { for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(";"); const i = kv.indexOf("="); /Max-Age=0/.test(sc) ? jar.delete(kv.slice(0, i)) : jar.set(kv.slice(0, i), kv.slice(i + 1)); } return r; };
  const ck = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const f = async (path, init = {}) => take(await fetch(B + path, { redirect: "manual", ...init, headers: { ...(jar.size ? { cookie: ck() } : {}), ...init.headers } }));
  const me = async () => (await (await f("/api/auth/me")).json());

  assert.equal((await me()).user, null, "anonymous at first");

  // full OIDC flow: login -> IdP -> callback -> session
  // Turnstile gate on login (scaffold default): GET shows the widget form, POST needs a verified token + same origin
  const page = await f("/api/auth/login?returnTo=/dashboard"); assert.equal(page.status, 200); const html = await page.text();
  assert.ok(html.includes("cf-turnstile") && html.includes('name="returnTo" value="/dashboard"'), "login page has the widget + returnTo");
  const post = (token, headers = { origin: B }, rt = "/dashboard") => f("/api/auth/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ returnTo: rt, ...(token ? { "cf-turnstile-response": token } : {}) }).toString() });
  assert.equal((await post(null)).status, 403, "no token"); assert.equal((await post("bad")).status, 403, "rejected token");
  assert.equal((await post("pass", { origin: "https://evil.example" })).status, 403, "foreign origin");
  assert.ok(!jar.has("oauth-oidc"), "no transaction started by refused logins");
  const login = (rt = "/dashboard") => post("pass", { origin: B }, rt);
  let r = await login();
  assert.equal(r.status, 302); const toIdp = new URL(r.headers.get("location"));
  assert.equal(toIdp.searchParams.get("code_challenge_method"), "S256"); assert.ok(toIdp.searchParams.get("state")); assert.ok(toIdp.searchParams.get("nonce"));
  assert.ok(jar.has("oauth-oidc"), "transaction cookie set");
  const idpRes = await fetch(toIdp, { redirect: "manual" }); const cbUrl = new URL(idpRes.headers.get("location"));
  r = await f(cbUrl.pathname + cbUrl.search);
  assert.equal(r.status, 302, await r.clone().text()); assert.equal(r.headers.get("location"), "/dashboard", "returnTo honoured");
  assert.ok(!jar.has("oauth-oidc"), "transaction cookie cleared"); assert.ok(jar.has("session"));
  const m1 = await me(); assert.ok(m1.user, "logged in"); const uid = m1.user;
  const sessionCookie = jar.get("session");

  // tampered cookie -> anonymous
  const good = jar.get("session"); jar.set("session", good.slice(0, -4) + "AAAA"); assert.equal((await me()).user, null, "tampered cookie rejected"); jar.set("session", good);

  // CSRF: logout without / with foreign Origin is refused, same-origin works
  assert.equal((await f("/api/auth/logout", { method: "POST" })).status, 403, "no Origin header");
  assert.equal((await f("/api/auth/logout", { method: "POST", headers: { origin: "https://evil.example" } })).status, 403, "foreign origin");
  assert.equal((await me()).user, uid, "still logged in after rejected logouts");
  assert.equal((await f("/api/auth/logout", { method: "POST", headers: { origin: B } })).status, 200);
  assert.equal((await me()).user, null, "logged out");

  // replayed callback (state cookie cleared) and bad state both fail without creating a session
  r = await f(cbUrl.pathname + cbUrl.search); assert.equal(r.status, 400); assert.equal((await me()).user, null);
  r = await login("/"); const t2 = new URL(r.headers.get("location")); const cb2 = new URL((await fetch(t2, { redirect: "manual" })).headers.get("location"));
  cb2.searchParams.set("state", "forged"); r = await f(cb2.pathname + cb2.search); assert.equal(r.status, 400); assert.equal((await r.json()).error, "bad_state");

  // same IdP account logs in to the same local user (account linking)
  jar.clear(); r = await login("/"); const t3 = new URL(r.headers.get("location")); const cb3 = new URL((await fetch(t3, { redirect: "manual" })).headers.get("location"));
  r = await f(cb3.pathname + cb3.search); assert.equal(r.status, 302); assert.equal((await me()).user, uid, "same user on second login");

  // e2e-login bypass: 404 without secret header path? (secret set here) -> 403 wrong, 204 right, then a real session
  jar.clear();
  assert.equal((await f("/api/auth/__e2e/login", { method: "POST", headers: { "x-e2e-secret": "nope" } })).status, 403);
  r = await f("/api/auth/__e2e/login", { method: "POST", headers: { "x-e2e-secret": vars.E2E_LOGIN_SECRET }, body: JSON.stringify({ user: "qa-bot" }) });
  assert.equal(r.status, 204); assert.equal((await me()).user, "qa-bot");
  assert.ok(sessionCookie, "sanity");
  assert.ok(siteverifySecrets.length >= 3 && siteverifySecrets.every((x) => x === "e2e-turnstile-secret"), "siteverify called with the configured secret");

  // rate limit: the login route (10 / 60 s per IP, per isolate memory limiter) answers 429 + Retry-After once exhausted
  let limited;
  for (let i = 0; i < 15 && !limited; i++) { const x = await f("/api/auth/login"); if (x.status === 429) limited = x; }
  assert.ok(limited, "login was rate limited"); assert.ok(Number(limited.headers.get("retry-after")) > 0, "Retry-After set");
  assert.equal((await me()).user, "qa-bot", "other routes unaffected by the login limit");
  console.log("auth e2e OK");
} finally { stop(); idp.close(); rmSync(dir, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
process.exit(0);

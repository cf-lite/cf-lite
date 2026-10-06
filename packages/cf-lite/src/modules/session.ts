/**
 * OPTIONAL module (only bundled if imported). Cookie sessions, WebCrypto only, no deps.
 *
 * Two stores behind one API:
 *  - **sealed** (default, no `store`): the whole session lives in the cookie, AES-256-GCM sealed (<4 KB). No revoke
 *    except `validAfter` (invalidate everything issued before a time) - pick a store when you need per-session revoke.
 *  - **store** (`kvStore` read-heavy / `d1Store` listing + revoke-by-user / `doStore` strict consistency, instant revoke):
 *    the cookie holds an opaque random id; the store is keyed by SHA-256(id), so a leaked store is not a set of live cookies.
 *
 *   app.use("*", session());                       // SESSION_SECRETS in env (first = current, rest = old keys)
 *   app.get("/me", (c) => c.json(getSession(c).userId));
 *   await getSession(c).login("user-1", { role: "admin" });   // rotates: new id/cookie, fixation-safe
 *   await getSession(c).destroy();
 *
 * Env: SESSION_SECRETS  comma-separated secrets, each >= 32 chars (`openssl rand -base64 32`). Missing/short = fail closed (throws).
 * Cookie: `__Host-session` on https (Secure, Path=/, no Domain), `session` on plain http (dev). HttpOnly, SameSite=Lax.
 */
import type { Context, MiddlewareHandler } from "hono";

// ---------------------------------------------------------------- bytes / crypto
const enc = new TextEncoder(), dec = new TextDecoder();
export const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
};
export const randomId = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256 = async (s: string) => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));

/** Constant-time string compare (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

interface SealKey { kid: string; key: CryptoKey }
const keyCache = new Map<string, Promise<SealKey[]>>();
const MIN_SECRET = 32;

/** HKDF(secret) -> AES-256-GCM key per secret; `kid` = first 6 bytes of SHA-256(secret) so unseal picks the key without trial decryption. */
function deriveKeys(secrets: string[]): Promise<SealKey[]> {
  const ck = secrets.join("\u0000");
  let p = keyCache.get(ck);
  if (!p) {
    p = Promise.all(secrets.map(async (s) => {
      const base = await crypto.subtle.importKey("raw", enc.encode(s), "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("cf-lite/session/v1"), info: enc.encode("aes-gcm") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      return { kid: (await sha256(s)).slice(0, 8), key };
    }));
    keyCache.set(ck, p);
  }
  return p;
}
export function parseSecrets(raw: string | string[] | undefined): string[] {
  const list = (Array.isArray(raw) ? raw : (raw ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  if (!list.length) throw new Error("cf-lite session: no secrets configured (set SESSION_SECRETS)");
  if (list.some((s) => s.length < MIN_SECRET)) throw new Error(`cf-lite session: every secret must be >= ${MIN_SECRET} chars`);
  return list;
}

/**
 * Seal any JSON value: `1.<kid>.<iv>.<ciphertext+tag>`. Random 96-bit IV per seal (never reused), `aad` (e.g. cookie name) is
 * authenticated so a value sealed for one purpose cannot be replayed for another. Format is versioned; no algorithm agility.
 */
export async function sealData(value: unknown, secrets: string | string[], aad: string): Promise<string> {
  const [k] = await deriveKeys(parseSecrets(secrets));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, k.key, enc.encode(JSON.stringify(value)));
  return `1.${k.kid}.${b64u(iv)}.${b64u(ct)}`;
}
/** Returns the value, or null for anything malformed / tampered / wrong key / wrong `aad`. Never throws on bad input. */
export async function unsealData<T = unknown>(token: string | undefined, secrets: string | string[], aad: string): Promise<T | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "1") return null;
  try {
    const keys = await deriveKeys(parseSecrets(secrets));
    const k = keys.find((x) => x.kid === parts[1]);
    if (!k) return null;
    const iv = unb64u(parts[2]);
    if (iv.length !== 12) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, k.key, unb64u(parts[3]));
    return JSON.parse(dec.decode(pt)) as T;
  } catch { return null; }
}

// ---------------------------------------------------------------- stores
export interface SessionRecord { data: Record<string, unknown>; uid?: string; iat: number; ls: number; exp: number }
export interface SessionStore {
  get(hid: string): Promise<SessionRecord | null>;
  put(hid: string, rec: SessionRecord, ttlS: number): Promise<void>;
  delete(hid: string): Promise<void>;
  /** Optional: revoke every session of a user. KV and D1 implement it; DO (one object per session) does not. */
  deleteByUser?(uid: string): Promise<number>;
}

/** KV: fastest reads, eventually consistent (~60 s to propagate a revoke to other locations). Keeps a per-user index key for deleteByUser. */
export function kvStore(kv: KVNamespace, prefix = "sess:"): SessionStore {
  return {
    async get(hid) { return (await kv.get(prefix + hid, "json")) as SessionRecord | null; },
    async put(hid, rec, ttlS) {
      const ttl = Math.max(60, Math.ceil(ttlS)); // KV minimum expirationTtl is 60 s
      await kv.put(prefix + hid, JSON.stringify(rec), { expirationTtl: ttl });
      if (rec.uid) await kv.put(`${prefix}u/${await sha256(rec.uid)}/${hid}`, "", { expirationTtl: ttl });
    },
    async delete(hid) {
      const rec = await this.get(hid);
      await kv.delete(prefix + hid);
      if (rec?.uid) await kv.delete(`${prefix}u/${await sha256(rec.uid)}/${hid}`);
    },
    async deleteByUser(uid) {
      const p = `${prefix}u/${await sha256(uid)}/`;
      let n = 0, cursor: string | undefined;
      do {
        const page = await kv.list({ prefix: p, cursor });
        for (const k of page.keys) { await kv.delete(prefix + k.name.slice(p.length)); await kv.delete(k.name); n++; }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return n;
    },
  };
}

/** D1 table DDL (also shipped as `templates/auth/migrations/0001_auth.sql`). */
export const SESSIONS_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at);`;

/** D1: strongly consistent on the primary, listable (admin UIs), revoke-by-user. Expired rows are filtered on read; `sweepSessions` deletes them (cron). */
export function d1Store(db: D1Database, table = "sessions", now: () => number = () => Math.floor(Date.now() / 1000)): SessionStore {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("bad table name");
  return {
    async get(hid) {
      const r = await db.prepare(`SELECT user_id, data, created_at, last_seen, expires_at FROM ${table} WHERE id = ?1 AND expires_at > ?2`).bind(hid, now()).first<{ user_id: string | null; data: string; created_at: number; last_seen: number; expires_at: number }>();
      return r ? { data: JSON.parse(r.data), uid: r.user_id ?? undefined, iat: r.created_at, ls: r.last_seen, exp: r.expires_at } : null;
    },
    async put(hid, rec) {
      await db.prepare(`INSERT INTO ${table} (id, user_id, data, created_at, last_seen, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(id) DO UPDATE SET user_id = ?2, data = ?3, last_seen = ?5, expires_at = ?6`).bind(hid, rec.uid ?? null, JSON.stringify(rec.data), rec.iat, rec.ls, rec.exp).run();
    },
    async delete(hid) { await db.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(hid).run(); },
    async deleteByUser(uid) { const r = await db.prepare(`DELETE FROM ${table} WHERE user_id = ?1`).bind(uid).run(); return (r as { meta?: { changes?: number } }).meta?.changes ?? 0; },
  };
}
export const sweepSessions = (db: D1Database, table = "sessions") => db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?1`).bind(Math.floor(Date.now() / 1000)).run();

/**
 * Durable Object class holding ONE session (strict consistency, instant revoke everywhere). Export it from your worker and bind it:
 *   export { SessionDO } from "cf-lite/modules/session";   // wrangler: durable_objects.bindings [{name:"SESSIONS",class_name:"SessionDO"}], migrations new_sqlite_classes
 * Plain class (no `cloudflare:workers` import) so this module stays importable in Node tests.
 */
export class SessionDO {
  constructor(private state: { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; deleteAll(): Promise<void>; setAlarm(t: number): Promise<void> } }) {}
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (req.method === "GET") { const r = await this.state.storage.get<SessionRecord>("r"); return Response.json(r ?? null); }
    if (req.method === "PUT") { const { rec, ttl } = (await req.json()) as { rec: SessionRecord; ttl: number }; await this.state.storage.put("r", rec); await this.state.storage.setAlarm(Date.now() + ttl * 1000); return new Response(null, { status: 204 }); }
    if (req.method === "DELETE") { await this.state.storage.deleteAll(); return new Response(null, { status: 204 }); }
    return new Response("method not allowed" + u.pathname, { status: 405 });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
export function doStore(ns: DurableObjectNamespace): SessionStore {
  const stub = (hid: string) => ns.get(ns.idFromName(hid));
  return {
    async get(hid) { return (await (await stub(hid).fetch("https://session/", { method: "GET" })).json()) as SessionRecord | null; },
    async put(hid, rec, ttlS) { await stub(hid).fetch("https://session/", { method: "PUT", body: JSON.stringify({ rec, ttl: ttlS }) }); },
    async delete(hid) { await stub(hid).fetch("https://session/", { method: "DELETE" }); },
  };
}

// ---------------------------------------------------------------- options + Session
export interface SessionOptions {
  /** Secrets (first seals, all unseal = key rotation). Default: `c.env.SESSION_SECRETS`. */
  secrets?: string | string[];
  /** Omit for the sealed-cookie store. */
  store?: SessionStore;
  /** Base cookie name (default "session"); `__Host-` is prepended automatically on https. */
  cookieName?: string;
  /** Idle (sliding) lifetime in seconds. Default 7 days. */
  ttl?: number;
  /** Absolute lifetime from creation, seconds. Default 30 days. Sliding never extends past it. */
  absoluteTtl?: number;
  /** Re-issue the cookie/record when last-seen is older than this many seconds (default 300). `0` = every request. */
  updateAge?: number;
  sameSite?: "Lax" | "Strict" | "None";
  /** Default: true on https requests, false on http. Forcing `false` on https drops the `__Host-` prefix. */
  secure?: boolean;
  domain?: string;
  /** Reject sessions created before this unix time (global logout / secret compromise response). */
  validAfter?: number;
  now?: () => number;
}
type Env = { SESSION_SECRETS?: string };
const DEFAULTS = { ttl: 7 * 86400, absoluteTtl: 30 * 86400, updateAge: 300 };
const MAX_SEALED = 3800;

export class Session<T extends Record<string, unknown> = Record<string, unknown>> {
  /** @internal */ _dirty = false; /** @internal */ _destroyed = false; /** @internal */ _rotate = false;
  /** @internal */ _hid?: string; /** @internal */ _oldHid?: string; /** @internal */ _touched = false;
  constructor(public data: T, public userId: string | undefined, public iat: number, public ls: number, public exp: number, public isNew: boolean) {}
  get<K extends keyof T>(k: K): T[K] | undefined { return this.data[k]; }
  set<K extends keyof T>(k: K, v: T[K]): void { this.data[k] = v; this._dirty = true; }
  delete<K extends keyof T>(k: K): void { delete this.data[k]; this._dirty = true; }
  get authenticated() { return this.userId !== undefined; }
  /** One-time message: returns it and removes it. */
  flash(k: string): unknown { const v = (this.data as Record<string, unknown>)[`_flash:${k}`]; if (v !== undefined) this.delete(`_flash:${k}` as keyof T); return v; }
  setFlash(k: string, v: unknown) { (this.data as Record<string, unknown>)[`_flash:${k}`] = v; this._dirty = true; }
  /** Attach a user and ROTATE the session id/cookie (session-fixation defence). Keeps existing data unless `data` replaces it. */
  async login(userId: string, data?: Partial<T>): Promise<void> {
    if (!userId) throw new Error("login: userId required");
    this.userId = userId;
    if (data) Object.assign(this.data, data);
    await this.rotate();
  }
  /** Issue a fresh id (store) / fresh iat+IV (sealed) and invalidate the old one. */
  async rotate(): Promise<void> { this._rotate = true; this._dirty = true; }
  /** Clear everything; the cookie is expired and the store record deleted. */
  async destroy(): Promise<void> { this._destroyed = true; this._dirty = true; this.data = {} as T; this.userId = undefined; }
  /** Per-session CSRF token (random, stored in the session). Compare with `verifyCsrfToken`. */
  csrfToken(): string { const d = this.data as Record<string, unknown>; if (typeof d._csrf !== "string") { d._csrf = randomId(24); this._dirty = true; } return d._csrf as string; }
}

function serializeCookie(name: string, value: string, o: { maxAge?: number; secure: boolean; sameSite: string; domain?: string }): string {
  let s = `${name}=${value}; Path=/; HttpOnly; SameSite=${o.sameSite}`;
  if (o.maxAge !== undefined) s += `; Max-Age=${Math.max(0, Math.floor(o.maxAge))}`;
  if (o.secure) s += "; Secure";
  if (o.domain) s += `; Domain=${o.domain}`;
  return s;
}
export function readCookie(req: Request, name: string): string | undefined {
  for (const p of (req.headers.get("cookie") ?? "").split(";")) {
    const i = p.indexOf("=");
    if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim();
  }
}

interface Resolved { secrets: string[]; store?: SessionStore; name: string; secure: boolean; ttl: number; abs: number; updateAge: number; sameSite: string; domain?: string; validAfter: number; now: () => number }
function resolve(req: Request, env: Env | undefined, o: SessionOptions): Resolved {
  const secure = o.secure ?? new URL(req.url).protocol === "https:";
  const base = o.cookieName ?? "session";
  return {
    secrets: parseSecrets(o.secrets ?? env?.SESSION_SECRETS), store: o.store,
    name: secure && !o.domain ? `__Host-${base}` : base, secure,
    ttl: o.ttl ?? DEFAULTS.ttl, abs: o.absoluteTtl ?? DEFAULTS.absoluteTtl, updateAge: o.updateAge ?? DEFAULTS.updateAge,
    sameSite: o.sameSite ?? "Lax", domain: o.domain, validAfter: o.validAfter ?? 0, now: o.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

interface Sealed { d: Record<string, unknown>; u?: string; i: number; l: number; e: number; n: string }

async function load(req: Request, r: Resolved): Promise<Session> {
  const raw = readCookie(req, r.name);
  const fresh = () => new Session({}, undefined, r.now(), r.now(), r.now() + r.ttl, true);
  if (!raw) return fresh();
  const now = r.now();
  let rec: SessionRecord | null = null, hid: string | undefined;
  if (r.store) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return fresh();
    hid = await sha256(raw);
    rec = await r.store.get(hid);
  } else {
    const s = await unsealData<Sealed>(raw, r.secrets, r.name);
    if (s && typeof s === "object" && s.d && typeof s.i === "number" && typeof s.l === "number" && typeof s.e === "number") rec = { data: s.d, uid: s.u, iat: s.i, ls: s.l, exp: s.e };
  }
  if (!rec || rec.exp <= now || rec.iat < r.validAfter || rec.iat > now + 60) return fresh();
  const s = new Session(rec.data, rec.uid, rec.iat, rec.ls, rec.exp, false);
  s._hid = hid;
  if (now - rec.ls >= r.updateAge) s._touched = true;
  return s;
}

/** Write pending changes: returns Set-Cookie header value(s) to append, or none. */
async function commit(s: Session, r: Resolved, req: Request): Promise<string | undefined> {
  const now = r.now();
  const cookie = (v: string, maxAge: number) => serializeCookie(r.name, v, { maxAge, secure: r.secure, sameSite: r.sameSite, domain: r.domain });
  if (s._destroyed) {
    if (r.store && s._hid) await r.store.delete(s._hid);
    return readCookie(req, r.name) !== undefined ? cookie("", 0) : undefined;
  }
  // nothing to persist for an anonymous untouched session
  if (s.isNew && !s._dirty && !s.userId && Object.keys(s.data).length === 0) return undefined;
  if (!s._dirty && !s._touched && !s.isNew) return undefined;
  if (s._rotate) { // rotation = new creation time, new id; old store record deleted
    if (r.store && s._hid) await r.store.delete(s._hid);
    s.iat = now; s.exp = now + r.ttl; s._hid = undefined;
  }
  s.ls = now;
  s.exp = Math.min(s.iat + r.abs, now + r.ttl);
  const rec: SessionRecord = { data: s.data, uid: s.userId, iat: s.iat, ls: s.ls, exp: s.exp };
  const maxAge = s.exp - now;
  if (r.store) {
    let id = readCookie(req, r.name);
    const reuse = !s._rotate && !s.isNew && id && s._hid;
    if (!reuse) id = randomId(32);
    const hid = reuse ? s._hid! : await sha256(id!);
    await r.store.put(hid, rec, maxAge);
    return cookie(id!, maxAge);
  }
  const sealed = await sealData({ d: rec.data, u: rec.uid, i: rec.iat, l: rec.ls, e: rec.exp, n: randomId(6) } satisfies Sealed, r.secrets, r.name);
  if (sealed.length > MAX_SEALED) throw new Error(`cf-lite session: sealed cookie is ${sealed.length} bytes (> ${MAX_SEALED}); use a store (kvStore/d1Store/doStore)`);
  return cookie(sealed, maxAge);
}

type SessionVars = { Bindings: Env; Variables: { session: Session; sessionOptions: SessionOptions } };

/** Hono middleware. Loads the session before the handler and writes the cookie after it (only when something changed or sliding refresh is due). */
export function session(opts: SessionOptions | ((c: Context) => SessionOptions) = {}): MiddlewareHandler<SessionVars> {
  return async (c, next) => {
    const o = typeof opts === "function" ? opts(c as Context) : opts;
    const r = resolve(c.req.raw, c.env, o);
    const s = await load(c.req.raw, r);
    c.set("session", s);
    c.set("sessionOptions", o);
    await next();
    const sc = await commit(s, r, c.req.raw);
    const vary = !!sc || !s.isNew;
    if (!sc && !vary) return;
    try {
      if (sc) c.res.headers.append("set-cookie", sc);
      if (vary) c.res.headers.append("vary", "Cookie");
    } catch { // immutable headers (a Response straight from fetch()/ASSETS): rebuild, like security() does
      const res = new Response(c.res.body, c.res);
      if (sc) res.headers.append("set-cookie", sc);
      if (vary) res.headers.append("vary", "Cookie");
      c.res = res;
    }
  };
}
export function getSession<T extends Record<string, unknown> = Record<string, unknown>>(c: Context): Session<T> {
  const s = c.get("session") as Session<T> | undefined;
  if (!s) throw new Error("cf-lite session: mount session() middleware first");
  return s;
}

/** Revoke all sessions of a user (needs a store that supports it: KV, D1). Sealed sessions: use `validAfter` instead. */
export async function revokeUser(store: SessionStore, uid: string): Promise<number> {
  if (!store.deleteByUser) throw new Error("this session store cannot revoke by user");
  return store.deleteByUser(uid);
}

// ---------------------------------------------------------------- CSRF
/** Origin check for unsafe methods (Origin, else Sec-Fetch-Site must be same-origin/none; neither header = reject). */
export function checkOrigin(req: Request, allowed: string[] = []): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const self = new URL(req.url).origin;
  const origin = req.headers.get("origin");
  if (origin) return origin === self || allowed.includes(origin);
  const sfs = req.headers.get("sec-fetch-site");
  return sfs === "same-origin" || sfs === "none";
}
export function verifyCsrfToken(s: Session, token: string | null | undefined): boolean {
  const t = (s.data as Record<string, unknown>)._csrf;
  return typeof t === "string" && typeof token === "string" && safeEqual(t, token);
}
/**
 * Hono CSRF guard: cross-origin unsafe requests -> 403. With `requireToken`, also demands `x-csrf-token` (or form field `_csrf`)
 * matching `session.csrfToken()`. Mount after `session()`. (WP-ACTIONS will integrate this with `actions`.)
 */
export const csrf = (o: { allowedOrigins?: string[]; requireToken?: boolean } = {}): MiddlewareHandler => async (c, next) => {
  if (!checkOrigin(c.req.raw, o.allowedOrigins)) return c.json({ error: "csrf: bad origin" }, 403);
  if (o.requireToken && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    let tok = c.req.header("x-csrf-token");
    if (!tok && (c.req.header("content-type") ?? "").includes("form")) tok = String((await c.req.raw.clone().formData().catch(() => new FormData())).get("_csrf") ?? "");
    if (!verifyCsrfToken(getSession(c), tok)) return c.json({ error: "csrf: bad token" }, 403);
  }
  await next();
};

/** Guard: 401 JSON unless logged in. */
export const requireSession = (): MiddlewareHandler => async (c, next) => {
  if (!getSession(c).authenticated) return c.json({ error: "unauthorized" }, 401);
  await next();
};

/**
 * Plug into `cf-lite/modules/e2e-login`: `e2eLogin({ issue: e2eSessionIssuer() })` logs the requested user in through the
 * real session (needs `session()` mounted above). Inert in production exactly like e2e-login (no E2E_LOGIN_SECRET => 404).
 */
export const e2eSessionIssuer = () => async (c: Context, who: { user: string }): Promise<void> => { await getSession(c).login(who.user); };

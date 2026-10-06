/**
 * OPTIONAL module (only bundled when a page exports `cache`, or when you import it): edge caching for SSR routes.
 *
 *   // app/routes/posts/[id].tsx
 *   export const render = "ssr";
 *   export const cache = { maxAge: 60, swr: 600, tags: ["posts"] };
 *   // or, data-dependent (runs on a miss, after the loader):
 *   export const cache = ({ params, data }) => ({ maxAge: 60, swr: 600, tags: ["posts", `post:${params.id}`] });
 *
 * How it works (details + limits: docs/caching.md):
 *  - Entries live in the Workers Cache API (`caches.default`) - PER COLO, not global. Freshness/SWR metadata is stored
 *    on the entry itself, so a lookup needs no config. `swr` is implemented here (Cache API ignores the directive).
 *  - Tag purge = a global ledger of "tag -> purged-at" in KV (`CF_CACHE_TAGS`) or D1 (`CF_CACHE_DB`). An entry is served
 *    only if none of its tags (nor its `path:<pathname>` tag) was purged after the entry's render started. Purging is one
 *    O(1) write and works in every colo, because entries are invalidated on read instead of being enumerated.
 *  - Requests carrying an auth cookie (the SSO cookie and the session module's `session` / `__Host-session` by default) or an Authorization header bypass the cache
 *    (never read, never written) unless `allowAuthenticated: true`.
 *  - Keys: URL with tracking params stripped + query sorted; only headers listed in `vary` take part in the key.
 *
 * Env: CF_CACHE_TAGS (KVNamespace) | CF_CACHE_DB (D1Database) | CF_CACHE_STORE ("kv"|"d1" when both are bound),
 *      CACHE_PURGE_TOKEN (secret, for `cachePurge()`), SSO_COOKIE_NAME (auth cookie, default "sso").
 */
import type { Context } from "hono";

/** An SSR handler as produced by `ssr()`: (c) => Response. */
export type SsrHandler = (c: Context) => Response | Promise<Response>;

export interface CacheKeyOptions {
  /** Request headers that become part of the cache key (lower-cased, e.g. ["accept-language"]). Default: none. */
  vary?: string[];
  /** Extra query params to drop from the key, added to the built-in tracking list. `utm_*` style prefix globs allowed. */
  ignoreParams?: string[];
  /** Allow-list: when set, ONLY these query params are part of the key (everything else is dropped). */
  keepParams?: string[];
  /** Serve/store for requests with an auth cookie or Authorization header too. Only for pages that are identical for everyone. */
  allowAuthenticated?: boolean;
  /** Cookie names that mean "authenticated" in addition to the SSO cookie and the session module's default cookies (`session`, `__Host-session`). */
  authCookies?: string[];
}
export interface CachePolicy {
  /** Seconds a stored copy is fresh (served as HIT). Must be > 0. */
  maxAge: number;
  /** Seconds after maxAge during which the stale copy is served while a background revalidation runs. Default 0. */
  swr?: number;
  /** Purge tags (max 16, 1-128 chars, no control chars or commas). Every entry also gets `path:<pathname>`. */
  tags?: string[];
  /** Cache-Control max-age sent to the browser. Default 0 (browsers always revalidate against the Worker). */
  browserMaxAge?: number;
  /** Replace the generated client-facing Cache-Control entirely. */
  cacheControl?: string;
}
export interface CacheCtx { params: Record<string, string>; data: unknown; url: URL; req: Request }
export type CacheFn = (ctx: CacheCtx) => CachePolicy | false | null | undefined | Promise<CachePolicy | false | null | undefined>;
/** `export const cache`: policy object (may also carry key options inline) or function of { params, data } -> policy. */
export type CacheExport = (CachePolicy & CacheKeyOptions) | CacheFn;

export interface CacheEnv {
  CF_CACHE_TAGS?: KVNamespace;
  CF_CACHE_DB?: D1Database;
  CF_CACHE_STORE?: string;
  CACHE_PURGE_TOKEN?: string;
  SSO_COOKIE_NAME?: string;
}
interface RouteModule { cache?: CacheExport; cacheKey?: CacheKeyOptions }

export const MAX_LIFETIME_S = 7 * 24 * 3600;
const LEDGER_TTL_S = MAX_LIFETIME_S + 24 * 3600;
const MAX_TAGS = 16, MAX_TAG_LEN = 128, TAG_MEMO_MS = 3000, HDR = "x-cf-lite-cache";
/** Query params that never change page content. Case-insensitive; a trailing `*` is a prefix glob. */
export const DEFAULT_IGNORE_PARAMS = ["utm_*", "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "igshid", "_ga", "_gl", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "vero_id"];

// ---------- key normalisation ----------

const globMatch = (pat: string, name: string) => (pat.endsWith("*") ? name.startsWith(pat.slice(0, -1)) : name === pat);

/** Drop the hash and ignored params, sort what is left. Pure; exported for tests and for building purge URLs. */
export function normalizeUrl(input: string | URL, o: Pick<CacheKeyOptions, "ignoreParams" | "keepParams"> = {}): URL {
  const u = new URL(input);
  u.hash = "";
  const ignore = [...DEFAULT_IGNORE_PARAMS, ...(o.ignoreParams ?? [])].map((s) => s.toLowerCase());
  const keep = o.keepParams?.map((s) => s.toLowerCase());
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (lk === "__cflv") continue;
    if (keep ? !keep.includes(lk) : ignore.some((p) => globMatch(p, lk))) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u;
}

/** The auto tag every entry carries; `purgePaths` purges exactly these. */
export function pathTag(path: string): string {
  const p = new URL(path, "http://x").pathname;
  return "path:" + (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
}

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildKey(req: Request, o: CacheKeyOptions): Promise<Request> {
  const u = normalizeUrl(req.url, o);
  const vary = [...new Set((o.vary ?? []).map((h) => h.toLowerCase()))].sort();
  if (vary.length) u.searchParams.set("__cflv", await sha256Hex(vary.map((h) => `${h}:${(req.headers.get(h) ?? "").trim().toLowerCase()}`).join("\n")));
  return new Request(u.toString(), { method: "GET" });
}

// ---------- tags ----------

/** Validate + dedupe. Throws on invalid input when `strict` (purge API); silently drops bad ones otherwise (route config). */
export function cleanTags(tags: unknown, strict = false): string[] {
  const out = new Set<string>();
  for (const t of Array.isArray(tags) ? tags : tags === undefined ? [] : [tags]) {
    const s = typeof t === "string" ? t.trim() : "";
    if (!s || s.length > MAX_TAG_LEN || /[\u0000-\u001f\u007f,]/.test(s)) {
      if (strict) throw new Error(`cf-lite cache: invalid tag ${JSON.stringify(t)} (1-${MAX_TAG_LEN} chars, no control chars or commas)`);
      continue;
    }
    out.add(s);
  }
  return [...out];
}

/** Ledger of tag -> purged-at (epoch ms). `maxPurged(tags)` is the newest purge among them (0 = never). */
export interface TagStore {
  maxPurged(tags: string[]): Promise<number>;
  purge(tags: string[], at: number): Promise<void>;
}

export function kvStore(kv: KVNamespace): TagStore {
  return {
    async maxPurged(tags) {
      // cacheTtl 30 = KV's minimum edge-cache time for reads: purges reach other colos within ~30-60s (KV is eventually consistent).
      const v = await Promise.all(tags.map((t) => kv.get("cfl:tag:" + t, { cacheTtl: 30 })));
      return Math.max(0, ...v.map((x) => Number(x) || 0));
    },
    async purge(tags, at) {
      await Promise.all(tags.map((t) => kv.put("cfl:tag:" + t, String(at), { expirationTtl: LEDGER_TTL_S })));
    },
  };
}

export function d1Store(db: D1Database): TagStore {
  let ready: Promise<unknown> | undefined;
  const ensure = () => (ready ??= db.exec("CREATE TABLE IF NOT EXISTS cf_lite_cache_tags (tag TEXT PRIMARY KEY, purged_at INTEGER NOT NULL)").catch((e) => { ready = undefined; throw e; }));
  return {
    async maxPurged(tags) {
      await ensure();
      const r = await db.prepare(`SELECT MAX(purged_at) AS m FROM cf_lite_cache_tags WHERE tag IN (${tags.map(() => "?").join(",")})`).bind(...tags).first<{ m: number | null }>();
      return r?.m ?? 0;
    },
    async purge(tags, at) {
      await ensure();
      const up = db.prepare("INSERT INTO cf_lite_cache_tags (tag, purged_at) VALUES (?1, ?2) ON CONFLICT(tag) DO UPDATE SET purged_at = MAX(purged_at, excluded.purged_at)");
      await db.batch([...tags.map((t) => up.bind(t, at)), db.prepare("DELETE FROM cf_lite_cache_tags WHERE purged_at < ?1").bind(at - LEDGER_TTL_S * 1000)]);
    },
  };
}

const stores = new WeakMap<object, TagStore>();
/** KV or D1 ledger from env bindings (CF_CACHE_STORE picks one when both are bound; KV wins otherwise). null = none bound. */
export function tagStoreFor(env: CacheEnv | undefined): TagStore | null {
  if (!env) return null;
  const pref = env.CF_CACHE_STORE?.toLowerCase();
  const b = pref === "d1" ? env.CF_CACHE_DB : pref === "kv" ? env.CF_CACHE_TAGS : (env.CF_CACHE_TAGS ?? env.CF_CACHE_DB);
  if (!b) return null;
  let s = stores.get(b);
  if (!s) { s = typeof (b as D1Database).prepare === "function" ? d1Store(b as D1Database) : kvStore(b as KVNamespace); stores.set(b, s); }
  return s;
}

// Per-isolate read memo: a hit needs the ledger, this keeps it to ~1 read per tag-set per few seconds. A purge made in the
// same isolate refreshes it immediately; other isolates see it after TAG_MEMO_MS (+ the store's own propagation delay).
const memoOf = new WeakMap<TagStore, Map<string, { v: number; exp: number }>>();
const memoFor = (s: TagStore) => { let m = memoOf.get(s); if (!m) memoOf.set(s, (m = new Map())); return m; };

async function purgedSince(store: TagStore, tags: string[], since: number, now: number): Promise<boolean> {
  const m = memoFor(store), k = tags.join("\n"), hit = m.get(k);
  if (hit && hit.exp > now) return hit.v >= since;
  const v = await store.maxPurged(tags);
  if (m.size > 500) m.clear();
  m.set(k, { v, exp: now + TAG_MEMO_MS });
  return v >= since;
}

export interface PurgeResult { purgedAt: number; tags: string[] }
/** Invalidate every cached entry carrying any of `tags`, in all colos (subject to the ledger store's propagation delay). */
export async function purgeTags(env: CacheEnv, tags: string | string[], now = Date.now()): Promise<PurgeResult> {
  const list = cleanTags(tags, true);
  if (!list.length) throw new Error("cf-lite cache: purgeTags needs at least one tag");
  if (list.length > 100) throw new Error("cf-lite cache: at most 100 tags per purge");
  const store = tagStoreFor(env);
  if (!store) throw new Error("cf-lite cache: no tag store bound - add a KV namespace binding CF_CACHE_TAGS (or a D1 binding CF_CACHE_DB)");
  await store.purge(list, now);
  const m = memoFor(store);
  for (const k of [...m.keys()]) if (k.split("\n").some((t) => list.includes(t))) m.delete(k); // next hit in this isolate re-reads the ledger
  return { purgedAt: now, tags: list };
}
/** Invalidate every cached variant (query strings, `vary` variants) of these paths. Paths are pathnames like "/posts/1". */
export function purgePaths(env: CacheEnv, paths: string | string[], now = Date.now()): Promise<PurgeResult> {
  return purgeTags(env, (Array.isArray(paths) ? paths : [paths]).map(pathTag), now);
}

// ---------- protected purge endpoint ----------

async function tokenOk(given: string, want: string): Promise<boolean> {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([h(given), h(want)]);
  const sub = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  if (sub.timingSafeEqual) return sub.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * Hono handler for `POST` with `Authorization: Bearer <CACHE_PURGE_TOKEN>` and JSON `{ "tags": [...], "paths": [...] }`.
 * Fails closed: no CACHE_PURGE_TOKEN configured -> 503 and nothing is purged. Mount it yourself, e.g. server/api/cache.ts:
 *   export default new Hono<{ Bindings: Env }>().post("/purge", cachePurge());
 */
export const cachePurge = (): ((c: Context) => Promise<Response>) => async (c: Context) => {
  const env = c.env as CacheEnv;
  if (!env.CACHE_PURGE_TOKEN) return c.json({ error: "purge disabled: CACHE_PURGE_TOKEN not configured" }, 503);
  const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
  if (!m || !(await tokenOk(m[1], env.CACHE_PURGE_TOKEN))) return c.json({ error: "unauthorized" }, 401);
  let body: { tags?: unknown; paths?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "body must be JSON" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
  try {
    const paths = body.paths === undefined ? [] : Array.isArray(body.paths) ? body.paths : null;
    if (!paths || paths.some((p) => typeof p !== "string" || !p.startsWith("/"))) return c.json({ error: "paths must be an array of pathnames starting with /" }, 400);
    const r = await purgeTags(env, [...cleanTags(body.tags, true), ...paths.map(pathTag)]);
    return c.json({ ok: true, ...r });
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, /no tag store/.test(msg) ? 503 : 400);
  }
};

// ---------- the cache route wrapper ----------

export interface CacheDeps { cache(): Cache; now(): number; dev: boolean }
const realDeps: CacheDeps = { cache: () => (caches as unknown as { default: Cache }).default, now: () => Date.now(), dev: !!(import.meta as any).env?.DEV };

const lifeOf = (p: CachePolicy) => Math.min(MAX_LIFETIME_S, p.maxAge + Math.max(0, p.swr ?? 0));
const validPolicy = (p: unknown): p is CachePolicy => !!p && typeof p === "object" && Number.isFinite((p as CachePolicy).maxAge) && (p as CachePolicy).maxAge > 0;

/** `cf-lite/modules/session` default cookie names (plain http / https): a session may carry per-user page content. */
const SESSION_COOKIES = ["session", "__Host-session"];
function authed(req: Request, env: CacheEnv, extra: string[] | undefined): boolean {
  if (req.headers.has("authorization")) return true;
  const names = new Set([env?.SSO_COOKIE_NAME || "sso", ...SESSION_COOKIES, ...(extra ?? [])]);
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && names.has(part.slice(0, i).trim())) return true;
  }
  return false;
}

/**
 * Read-your-writes (`updateTag`): the writer's browser carries `__cfl_upd=<epoch ms of the purge>` for UPDATE_WINDOW_S seconds, and a request
 * carrying a fresh one never reads or writes a shared cache. Why: the tag ledger is a KV namespace (eventually consistent, ~30-60 s to reach
 * other colos), so right after the write the writer could still be served the stale page from the cache of another colo. Everybody else
 * converges through the ledger as usual. Presence + age only, no crypto: the cookie can only make its own holder bypass the cache.
 */
export const UPDATE_COOKIE = "__cfl_upd";
export const UPDATE_WINDOW_S = 60;
export function hasUpdateCookie(req: Request, now = Date.now()): boolean {
  const m = /(?:^|;\s*)__cfl_upd=(\d{10,15})(?:;|$)/.exec(req.headers.get("cookie") ?? "");
  return !!m && now - Number(m[1]) < UPDATE_WINDOW_S * 1000 && Number(m[1]) - now < 60_000;
}
/** `Set-Cookie` value for an update made at `at` (Secure only on https, so it also works on `http://localhost`). */
export const updateCookieHeader = (url: string, at: number): string => `${UPDATE_COOKIE}=${at}; Path=/; Max-Age=${UPDATE_WINDOW_S}; HttpOnly; SameSite=Lax${new URL(url).protocol === "https:" ? "; Secure" : ""}`;

/**
 * `updateTag` (Next.js: read-your-writes after a mutation). Use it in a form action / route handler right after the write:
 * expires every cached entry carrying `tags` (like `purgeTags`) AND makes the caller's own next requests bypass the shared caches for
 * UPDATE_WINDOW_S seconds, so the redirect back to the page shows the new data even if the ledger has not reached that colo yet.
 * For a webhook / cron (no browser to carry the cookie) use `purgeTags`, which is the `revalidateTag` equivalent.
 */
export async function updateTag(c: Context, tags: string | string[]): Promise<PurgeResult> {
  const r = await purgeTags(c.env as CacheEnv, tags);
  c.header("set-cookie", updateCookieHeader(c.req.url, r.purgedAt), { append: true });
  return r;
}
/** `updateTag` for paths (`updatePath(c, "/posts/1")`). */
export const updatePath = (c: Context, paths: string | string[]): Promise<PurgeResult> => updateTag(c, (Array.isArray(paths) ? paths : [paths]).map(pathTag));

/** Draft mode (`cf-lite/modules/draft`) cookie present -> a previewer: never read or write a shared cache. Presence only, no crypto (fails toward bypass). Dependency-free on purpose. */
export const hasDraftCookie = (req: Request): boolean => /(?:^|;\s*)__cfl_preview=/.test(req.headers.get("cookie") ?? "");

function withHeaders(res: Response, h: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}

function clientCacheControl(p: CachePolicy): string {
  if (p.cacheControl) return p.cacheControl;
  const swr = Math.max(0, p.swr ?? 0);
  return `public, max-age=${Math.max(0, p.browserMaxAge ?? 0)}, s-maxage=${p.maxAge}${swr ? `, stale-while-revalidate=${swr}` : ""}`;
}

const inflight = new Map<string, Promise<void>>();

/** Build the wrapper used by generated apps. `deps` is injectable for tests. */
export function createCacheRoute(deps: CacheDeps) {
  return function cacheRoute(mod: RouteModule, handler: SsrHandler): SsrHandler {
    const exp = mod.cache;
    const staticOpts: CacheKeyOptions & Partial<CachePolicy> = { ...mod.cacheKey, ...(typeof exp === "function" ? {} : exp) };
    return async (c: Context) => {
      const req = c.req.raw, env = c.env as CacheEnv;
      const bypass = async (why: string, priv = false) => withHeaders(await handler(c), { [HDR]: "BYPASS", ...(priv ? { "cache-control": "private, no-cache" } : {}), "x-cf-lite-cache-why": why });
      if (deps.dev) return bypass("dev");
      if (req.method !== "GET") return bypass("method");
      if (c.get("cspNonce")) return bypass("csp-nonce"); // `security()` nonce: the HTML is stamped per request, so a stored copy would carry a stale nonce
      if (hasDraftCookie(req)) return bypass("draft", true); // draft mode (modules/draft): never read or write the shared cache for a previewer
      if (hasUpdateCookie(req, deps.now())) return bypass("updated", true); // updateTag(): read-your-writes for the writer
      if (!staticOpts.allowAuthenticated && authed(req, env, staticOpts.authCookies)) return bypass("auth", true);

      const cache = deps.cache(), key = await buildKey(req, staticOpts), store = tagStoreFor(env);
      const vary: Record<string, string> = staticOpts.vary?.length ? { vary: [...new Set(staticOpts.vary.map((h) => h.toLowerCase()))].join(", ") } : {};
      const waitUntil = (p: Promise<unknown>) => { const q = p.catch((e) => console.warn("[cf-lite cache]", (e as Error).message)); try { c.executionCtx.waitUntil(q); } catch { /* no ExecutionContext (tests) */ } };

      // Render + store. Returns the client response (miss) - or, for revalidation, just refreshes the entry.
      const render = async (): Promise<{ res: Response; store?: Promise<void> }> => {
        const t0 = deps.now();
        const res = await handler(c);
        const fail = (why: string) => ({ res: withHeaders(res, { [HDR]: "BYPASS", "x-cf-lite-cache-why": why, ...vary }) });
        if (res.status !== 200 || res.headers.has("set-cookie") || /\b(no-store|private)\b/i.test(res.headers.get("cache-control") ?? "") || /\*|\b(cookie|authorization)\b/i.test(res.headers.get("vary") ?? "")) return fail("uncacheable-response");
        let policy: CachePolicy | false | null | undefined;
        try { policy = typeof exp === "function" ? await exp({ params: c.req.param() as Record<string, string>, data: c.get("cflData"), url: new URL(req.url), req }) : (exp as CachePolicy); }
        catch (e) { console.warn("[cf-lite cache] cache() threw:", (e as Error).message); return fail("policy-error"); }
        if (!validPolicy(policy)) return fail("no-policy");
        const tags = [...cleanTags(policy.tags).slice(0, MAX_TAGS), pathTag(req.url)];
        const life = lifeOf(policy);
        const body = res.clone();
        const stored = new Headers(res.headers);
        stored.set("cache-control", `public, max-age=${life}`);
        stored.set("x-cfl-t", String(t0)); stored.set("x-cfl-max", String(policy.maxAge)); stored.set("x-cfl-swr", String(Math.max(0, policy.swr ?? 0)));
        stored.set("x-cfl-tags", tags.map(encodeURIComponent).join(",")); stored.set("x-cfl-cc", clientCacheControl(policy));
        const put = cache.put(key, new Response(body.body, { status: 200, headers: stored }));
        return { res: withHeaders(res, { [HDR]: "MISS", "cache-control": clientCacheControl(policy), ...vary }), store: put };
      };

      const hit = await cache.match(key);
      if (hit) {
        const t = Number(hit.headers.get("x-cfl-t")), max = Number(hit.headers.get("x-cfl-max")), swr = Number(hit.headers.get("x-cfl-swr")) || 0;
        const tags = (hit.headers.get("x-cfl-tags") ?? "").split(",").filter(Boolean).map(decodeURIComponent);
        const now = deps.now(), age = (now - t) / 1000;
        let ok = Number.isFinite(t) && Number.isFinite(max) && age < max + swr;
        if (ok && store) {
          try { ok = !(await purgedSince(store, tags, t, now)); }
          catch (e) { console.warn("[cf-lite cache] tag store read failed, rendering fresh:", (e as Error).message); ok = false; }
        }
        if (ok) {
          const h = new Headers(hit.headers);
          const cc = h.get("x-cfl-cc")!;
          for (const k of [...h.keys()]) if (k.startsWith("x-cfl-") || k === "cf-cache-status" || k === "age") h.delete(k);
          h.set("cache-control", cc); h.set("age", String(Math.max(0, Math.floor(age)))); h.set(HDR, age < max ? "HIT" : "STALE");
          if (vary.vary) h.set("vary", vary.vary);
          if (age >= max && !inflight.has(key.url)) {
            // stale-while-revalidate: answer now, refresh in the background (once per key per isolate)
            const p = render().then(async (r) => { await r.res.arrayBuffer().catch(() => {}); await r.store; }).finally(() => inflight.delete(key.url));
            inflight.set(key.url, p);
            waitUntil(p);
          }
          return new Response(hit.body, { status: hit.status, headers: h });
        }
      }
      const { res, store: put } = await render();
      if (put) waitUntil(put);
      return res;
    };
  };
}

/** Wraps an SSR handler with the route's `export const cache` (used by the generated app). */
export const cacheRoute = createCacheRoute(realDeps);

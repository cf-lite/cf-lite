/**
 * OPTIONAL module: "durable static" ISR. Regenerated HTML lives in R2 (`_isr/...`), is served by the Worker, and is
 * rebuilt in the background by a Queue consumer - globally consistent, no redeploy (details, limits, cost: docs/isr.md).
 *
 *   // server/api/... or any Hono route, e.g. the SSR app's catch-all
 *   app.get("/posts/:id", isr({ maxAge: 300, swr: 3600, tags: (c) => ["posts", `post:${c.req.param("id")}`] }), handler);
 *   // server/queues/isr.ts
 *   export default isrConsumer({ render: (req, env, ctx) => app.fetch(req, env, ctx) });
 *   // after an edit (action, webhook, queue):  await revalidateTag(env, "post:42")
 *
 * Request path: R2 hit fresh -> serve; older than maxAge (within swr) or tag purged -> serve the stored copy AND enqueue one
 * regeneration; miss -> render inline and store. A regeneration that fails never touches the stored object, so the last good
 * copy keeps being served (stale-if-error up to `maxStale`). Requests with an Authorization header or auth cookie bypass.
 *
 * Env: ISR_BUCKET (R2Bucket), ISR_QUEUE (Queue, optional: without it stale copies are refreshed with waitUntil and
 *      `revalidateTag` deletes the entries instead), ISR_REVALIDATE_TOKEN (secret for `isrRevalidate()`, falls back to
 *      CACHE_PURGE_TOKEN), CF_CACHE_TAGS | CF_CACHE_DB (optional tag ledger shared with cf-lite/modules/cache).
 */
import type { Context, MiddlewareHandler } from "hono";
import { cleanTags, hasDraftCookie, hasUpdateCookie, normalizeUrl, pathTag, purgeTags, tagStoreFor, type CacheEnv, type TagStore } from "./cache.js";
import { backoff, defineQueue, type QueueBatchHandler } from "./queue.js";

export interface IsrEnv extends CacheEnv {
  ISR_BUCKET?: R2Bucket;
  ISR_QUEUE?: Queue<IsrMessage>;
  ISR_REVALIDATE_TOKEN?: string;
  SSO_COOKIE_NAME?: string;
}
export interface IsrMessage {
  v: 1;
  /** pathname + normalised search to regenerate */
  path: string;
  /** epoch ms of the revalidation; skipped when the stored copy is already newer */
  at: number;
  reason: "tag" | "stale" | "purged";
}
export interface IsrPolicy {
  /** Seconds a stored copy is fresh. > 0. */
  maxAge: number;
  /** Extra seconds a stale copy is served while a regeneration is queued. Default 0. */
  swr?: number;
  /** How long a stale copy may still be served when regeneration/inline render fails. Default 7 days. */
  maxStale?: number;
  /** Tags (max 16) or a function of the request context; every entry also carries `path:<pathname>`. */
  tags?: string[] | ((c: Context) => string[]);
  /** Client-facing Cache-Control. Default `public, max-age=0, s-maxage=<maxAge>, stale-while-revalidate=<swr>`. */
  cacheControl?: string;
  /** Serve/store for requests with auth cookie/header too (only for pages identical for everyone). */
  allowAuthenticated?: boolean;
  authCookies?: string[];
  ignoreParams?: string[];
  keepParams?: string[];
}

const PREFIX = "_isr", TAG_PREFIX = "_isr-tags/", HDR = "x-cf-lite-isr", REGEN_HDR = "x-cf-lite-isr-regen";
const MAX_TAGS = 16, DEFAULT_MAX_STALE = 7 * 24 * 3600, LIST_PAGE = 1000;

// nonces handed to the in-process regeneration fetch; a client can never guess one, so it cannot trigger a store
const nonces = new Set<string>();
const inflight = new Set<string>();

async function sha256Hex(s: string, bytes = 12): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].slice(0, bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** R2 object key for a pathname+search (already normalised). Query strings are hashed so keys stay short and safe. */
export async function isrKey(pathWithSearch: string): Promise<string> {
  const u = new URL(pathWithSearch, "http://x");
  const p = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname;
  return PREFIX + encodeURI(decodeURI(p)).replace(/[?#]/g, encodeURIComponent) + (u.search ? "?" + (await sha256Hex(u.search)) : "");
}
const tagKeyPrefix = (tag: string) => TAG_PREFIX + encodeURIComponent(tag) + "/";

function authed(req: Request, env: IsrEnv, extra: string[] | undefined): boolean {
  if (req.headers.has("authorization")) return true;
  const names = new Set([env?.SSO_COOKIE_NAME || "sso", "session", "__Host-session", ...(extra ?? [])]); // + the session module's cookies
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && names.has(part.slice(0, i).trim())) return true;
  }
  return false;
}

interface Meta { t: number; maxAge: number; swr: number; maxStale: number; tags: string[]; cc: string; path: string }
const readMeta = (o: R2Object | null | undefined): Meta | null => {
  const m = o?.customMetadata;
  if (!m || !m.t) return null;
  const t = Number(m.t);
  if (!Number.isFinite(t)) return null;
  return { t, maxAge: Number(m.max), swr: Number(m.swr) || 0, maxStale: Number(m.stale) || DEFAULT_MAX_STALE, tags: (m.tags ?? "").split(",").filter(Boolean).map(decodeURIComponent), cc: m.cc ?? "", path: m.path ?? "" };
};

/** Hono's `c.res =` merges the previous response's headers over the new one; drop the old one first (failed render -> stored copy). */
function replaceRes(c: Context, res: Response): void { (c as { res: Response | undefined }).res = undefined; c.res = res; }

function withHeaders(res: Response, h: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}
const clientCc = (p: IsrPolicy) => p.cacheControl ?? `public, max-age=0, s-maxage=${p.maxAge}${p.swr ? `, stale-while-revalidate=${p.swr}` : ""}`;
const uncacheable = (res: Response) =>
  res.status !== 200 || res.headers.has("set-cookie") || /\b(no-store|private)\b/i.test(res.headers.get("cache-control") ?? "") || /\*/.test(res.headers.get("vary") ?? "");

export interface IsrDeps { now(): number }
const realDeps: IsrDeps = { now: () => Date.now() };

/** Write a rendered response into R2 + the tag index. Returns false (and writes nothing) when the response is not storable. */
async function store(env: IsrEnv, pathKey: string, path: string, res: Response, policy: IsrPolicy, tags: string[], t: number, prev: Meta | null): Promise<boolean> {
  const bucket = env.ISR_BUCKET!;
  const meta: Record<string, string> = {
    t: String(t), max: String(policy.maxAge), swr: String(policy.swr ?? 0), stale: String(policy.maxStale ?? DEFAULT_MAX_STALE),
    tags: tags.map(encodeURIComponent).join(","), cc: clientCc(policy), path,
  };
  const body = await res.arrayBuffer();
  const headers: Record<string, string> = {};
  for (const h of ["content-type", "content-language", "link", "x-robots-tag"]) { const v = res.headers.get(h); if (v) headers[h] = v; }
  // never replace a newer copy with an older render (concurrent regenerations)
  if (prev && prev.t > t) return true;
  await bucket.put(pathKey, body, { httpMetadata: { contentType: headers["content-type"] ?? "text/html; charset=utf-8" }, customMetadata: { ...meta, h: JSON.stringify(headers) } });
  // tag index: only written for tags the previous copy did not have (Class A ops are the cost driver)
  const known = new Set(prev?.tags ?? []);
  const id = pathKey.slice(PREFIX.length).replace(/\//g, "%2F");
  await Promise.all(tags.filter((g) => !known.has(g)).map((g) => bucket.put(tagKeyPrefix(g) + id, "", { customMetadata: { path, key: pathKey } })));
  return true;
}

function respond(obj: R2ObjectBody, meta: Meta, state: "HIT" | "STALE", now: number, headers?: string): Response {
  const h = new Headers();
  try { for (const [k, v] of Object.entries(JSON.parse(headers ?? "{}") as Record<string, string>)) h.set(k, v); } catch { /* ignore corrupt metadata */ }
  if (!h.has("content-type")) h.set("content-type", obj.httpMetadata?.contentType ?? "text/html; charset=utf-8");
  h.set("cache-control", meta.cc);
  h.set("age", String(Math.max(0, Math.floor((now - meta.t) / 1000))));
  h.set("etag", obj.httpEtag);
  h.set(HDR, state);
  return new Response(obj.body, { status: 200, headers: h });
}

async function enqueue(env: IsrEnv, msgs: IsrMessage[]): Promise<void> {
  const q = env.ISR_QUEUE!;
  if (msgs.length === 1) { await q.send(msgs[0]); return; }
  for (let i = 0; i < msgs.length; i += 100) await q.sendBatch(msgs.slice(i, i + 100).map((body) => ({ body })));
}

/** Hono middleware implementing the R2-backed regeneration cache for the route it guards. `deps` is injectable for tests. */
export function createIsr(deps: IsrDeps = realDeps) {
  return function isr(policy: IsrPolicy): MiddlewareHandler {
    if (!(policy.maxAge > 0)) throw new Error("cf-lite isr: maxAge must be > 0");
    return async (c, next) => {
      const req = c.req.raw, env = c.env as IsrEnv;
      const bypass = async (why: string) => { await next(); c.res = withHeaders(c.res, { [HDR]: "BYPASS", "x-cf-lite-isr-why": why }); };
      const nonce = req.headers.get(REGEN_HDR);
      const regen = !!nonce && nonces.has(nonce);
      if (!regen) {
        if (req.method !== "GET") return bypass("method");
        if (!env.ISR_BUCKET) { console.warn("[cf-lite isr] ISR_BUCKET is not bound: serving uncached"); return bypass("no-bucket"); }
        if (hasDraftCookie(req)) { await next(); c.res = withHeaders(c.res, { [HDR]: "BYPASS", "cache-control": "private, no-store", "x-cf-lite-isr-why": "draft" }); return; } // draft mode: never touch R2 for a previewer
        if (hasUpdateCookie(req)) { await next(); c.res = withHeaders(c.res, { [HDR]: "BYPASS", "cache-control": "private, no-cache", "x-cf-lite-isr-why": "updated" }); return; } // updateTag(): read-your-writes for the writer
        if (c.get("cspNonce")) return bypass("csp-nonce"); // `security()` nonce is stamped per request: a stored copy would replay a stale one
        if (!policy.allowAuthenticated && authed(req, env, policy.authCookies)) { await next(); c.res = withHeaders(c.res, { [HDR]: "BYPASS", "cache-control": "private, no-cache", "x-cf-lite-isr-why": "auth" }); return; }
      }
      const bucket = env.ISR_BUCKET!;
      const u = normalizeUrl(req.url, policy);
      const path = u.pathname + u.search, key = await isrKey(path);
      const waitUntil = (p: Promise<unknown>) => { const q = p.catch((e) => console.warn("[cf-lite isr]", (e as Error).message)); try { c.executionCtx.waitUntil(q); } catch { /* no ExecutionContext (tests) */ } };
      const now = deps.now();

      const renderAndStore = async (prev: Meta | null): Promise<Response> => {
        const t0 = deps.now();
        await next();
        const res = c.res;
        if (uncacheable(res)) { c.res = withHeaders(res, { [HDR]: "BYPASS", "x-cf-lite-isr-why": "uncacheable-response" }); return c.res; }
        const tags = [...cleanTags(typeof policy.tags === "function" ? policy.tags(c) : policy.tags).slice(0, MAX_TAGS - 1), pathTag(u.pathname)];
        const copy = res.clone();
        waitUntil(store(env, key, path, copy, policy, tags, t0, prev));
        c.res = withHeaders(res, { [HDR]: regen ? "REGEN" : "MISS", "cache-control": clientCc(policy) });
        return c.res;
      };

      if (regen) {
        // queue consumer path: always render, never serve from R2; a failure must throw so the message retries
        const prev = readMeta(await bucket.head(key));
        const t0 = deps.now();
        await next();
        const res = c.res;
        if (uncacheable(res)) throw new Error(`isr regeneration of ${path} returned an uncacheable response (status ${res.status})`);
        const tags = [...cleanTags(typeof policy.tags === "function" ? policy.tags(c) : policy.tags).slice(0, MAX_TAGS - 1), pathTag(u.pathname)];
        await store(env, key, path, res.clone(), policy, tags, t0, prev);
        c.res = withHeaders(res, { [HDR]: "REGEN" });
        return;
      }

      const obj = await bucket.get(key);
      const meta = readMeta(obj);
      if (obj && meta) {
        const age = (now - meta.t) / 1000;
        let purged = false;
        const ledger = tagStoreFor(env);
        if (ledger) { try { purged = (await ledger.maxPurged(meta.tags)) >= meta.t; } catch (e) { console.warn("[cf-lite isr] tag ledger read failed:", (e as Error).message); } }
        const fresh = age < meta.maxAge && !purged;
        if (fresh) { c.res = respond(obj, meta, "HIT", now, obj.customMetadata?.h); return; }
        if (age < meta.maxAge + meta.swr || purged) {
          // stale-while-regenerate: answer from R2 now, refresh behind the scenes (once per key per isolate)
          if (!inflight.has(key)) {
            inflight.add(key);
            const job = (env.ISR_QUEUE
              ? enqueue(env, [{ v: 1, path, at: now, reason: purged ? "purged" : "stale" }])
              : Promise.resolve().then(() => renderInBackground(c, path, env))).finally(() => inflight.delete(key));
            waitUntil(job);
          }
          c.res = respond(obj, meta, "STALE", now, obj.customMetadata?.h);
          return;
        }
        if (age < meta.maxStale) {
          // too old for swr: render inline; if that fails, fall back to the last good copy
          try {
            const res = await renderAndStore(meta);
            if (res.status < 500) return;
          } catch (e) { console.warn("[cf-lite isr] inline render failed, serving last good copy:", (e as Error).message); }
          replaceRes(c, respond(obj, meta, "STALE", now, obj.customMetadata?.h));
          return;
        }
      }
      await renderAndStore(meta);
    };
  };
}

/** No-queue fallback: refresh via an in-process re-fetch of the same URL with a one-shot nonce. */
async function renderInBackground(c: Context, path: string, env: IsrEnv): Promise<void> {
  if (!regenerator) return; // no isrConsumer registered in this isolate: a later request renders inline
  const nonce = crypto.randomUUID();
  nonces.add(nonce);
  try {
    const res = await regenerator(new Request(new URL(c.req.url).origin + path, { headers: { [REGEN_HDR]: nonce, accept: "text/html" } }), env, c.executionCtx as unknown as ExecutionContext);
    await res.arrayBuffer().catch(() => {});
  } finally { nonces.delete(nonce); }
}
let regenerator: ((req: Request, env: any, ctx: ExecutionContext) => Response | Promise<Response>) | undefined;

export const isr = createIsr();

/**
 * Route convention (`export const isr = {...}` in an ssr page, docs/isr.md): wraps the page's GET handler with `isr()`. The generated app
 * calls this; the policy is read once at startup, so a bad policy (`maxAge` <= 0) fails fast.
 */
export function isrRoute(mod: { isr?: IsrPolicy }, handler: (c: Context) => Response | Promise<Response>): (c: Context) => Promise<Response> {
  if (!mod.isr || typeof mod.isr !== "object") throw new Error("cf-lite isr: `export const isr` must be a policy object ({ maxAge, swr?, tags? })");
  const mw = isr(mod.isr);
  return async (c) => {
    await mw(c, async () => { c.res = await handler(c); });
    return c.res;
  };
}

export interface IsrConsumerOptions {
  /** Render a request through the app (normally `app.fetch`). The request carries the nonce header `isr()` needs. */
  render(req: Request, env: any, ctx: ExecutionContext): Response | Promise<Response>;
  /** Origin used to build regeneration URLs. Default: `SITE_URL` env, else the origin remembered from the last served request. */
  origin?: string;
  /** Attempts before a message is given up on (last good copy stays). Default 5. */
  maxAttempts?: number;
  retry?: { base?: number; factor?: number; max?: number };
}

let lastOrigin: string | undefined;
/** Hono middleware remembering the public origin so a queue consumer (no request) can build absolute URLs. Applied by `isr()` users via `app.use(isrOrigin())`. */
export const isrOrigin = (): MiddlewareHandler => async (c, next) => { lastOrigin = new URL(c.req.url).origin; await next(); };

/** Queue consumer for ISR messages: `export default isrConsumer({ render: (r, e, x) => app.fetch(r, e, x) })`. */
export function isrConsumer(opts: IsrConsumerOptions): QueueBatchHandler<IsrMessage> {
  regenerator = opts.render;
  return defineQueue<IsrMessage>({
    each: async (msg, _m, env: IsrEnv, ctx) => {
      if (!msg || msg.v !== 1 || typeof msg.path !== "string" || !msg.path.startsWith("/")) { console.error("[cf-lite isr] dropping malformed message"); return; }
      const bucket = env.ISR_BUCKET;
      if (!bucket) throw new Error("ISR_BUCKET is not bound");
      const cur = readMeta(await bucket.head(await isrKey(msg.path)));
      if (cur && cur.t >= msg.at) return; // already regenerated after this revalidation was requested (dedupe)
      const origin = opts.origin ?? (env as { SITE_URL?: string }).SITE_URL ?? lastOrigin;
      if (!origin) throw new Error("isr consumer has no origin: set SITE_URL, pass `origin`, or use isrOrigin() middleware");
      const nonce = crypto.randomUUID();
      nonces.add(nonce);
      try {
        const res = await opts.render(new Request(new URL(msg.path, origin), { headers: { [REGEN_HDR]: nonce, accept: "text/html" } }), env, ctx);
        await res.arrayBuffer();
        if (res.headers.get(HDR) !== "REGEN") throw new Error(`isr regeneration of ${msg.path} was not handled by an isr() route (status ${res.status})`);
      } finally { nonces.delete(nonce); }
    },
    maxAttempts: opts.maxAttempts ?? 5,
    retryDelay: backoff(opts.retry ?? { base: 10, factor: 2, max: 600 }),
    onDead: (msg, _m, err) => console.error(`[cf-lite isr] giving up regenerating ${msg?.path}; last good copy stays:`, err),
  });
}

export interface RevalidateResult { tags: string[]; enqueued: number; deleted: number; purgedAt: number }

async function entriesForTag(bucket: R2Bucket, tag: string): Promise<{ indexKey: string; path: string; key: string }[]> {
  const out: { indexKey: string; path: string; key: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: tagKeyPrefix(tag), limit: LIST_PAGE, cursor, include: ["customMetadata"] });
    for (const o of page.objects) { const m = o.customMetadata; if (m?.path && m.key) out.push({ indexKey: o.key, path: m.path, key: m.key }); }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/**
 * Invalidate every regenerated page carrying `tags`: regeneration is queued (one message per page, deduped) and the shared tag
 * ledger is purged too when bound (so the Cache API tier from cf-lite/modules/cache is invalidated). Without ISR_QUEUE the
 * stored entries are deleted instead, so the next request renders fresh.
 */
export async function revalidateTag(env: IsrEnv, tags: string | string[], now = Date.now()): Promise<RevalidateResult> {
  const list = cleanTags(tags, true);
  if (!list.length) throw new Error("cf-lite isr: revalidateTag needs at least one tag");
  if (list.length > 100) throw new Error("cf-lite isr: at most 100 tags per call");
  const bucket = env.ISR_BUCKET;
  if (!bucket) throw new Error("cf-lite isr: no ISR_BUCKET bound");
  if (tagStoreFor(env)) await purgeTags(env, list, now);
  const seen = new Map<string, { path: string; key: string }>();
  for (const tag of list) for (const e of await entriesForTag(bucket, tag)) seen.set(e.key, e);
  let enqueued = 0, deleted = 0;
  if (env.ISR_QUEUE) {
    const msgs = [...seen.values()].map((e): IsrMessage => ({ v: 1, path: e.path, at: now, reason: "tag" }));
    if (msgs.length) await enqueue(env, msgs);
    enqueued = msgs.length;
  } else {
    const keys = [...seen.keys()];
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    deleted = keys.length;
  }
  return { tags: list, enqueued, deleted, purgedAt: now };
}
/** Invalidate exact pathnames (every query variant carries the `path:` tag, so this is `revalidateTag` on `path:` tags). */
export const revalidatePath = (env: IsrEnv, paths: string | string[], now = Date.now()) =>
  revalidateTag(env, (Array.isArray(paths) ? paths : [paths]).map(pathTag), now);

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
 * `POST` + `Authorization: Bearer <ISR_REVALIDATE_TOKEN | CACHE_PURGE_TOKEN>` + JSON `{ tags?: string[], paths?: string[] }`.
 * Fails closed (503) when no token is configured. Mount: `new Hono().post("/revalidate", isrRevalidate())`.
 */
export const isrRevalidate = (): ((c: Context) => Promise<Response>) => async (c) => {
  const env = c.env as IsrEnv;
  const want = env.ISR_REVALIDATE_TOKEN || env.CACHE_PURGE_TOKEN;
  if (!want) return c.json({ error: "revalidate disabled: ISR_REVALIDATE_TOKEN not configured" }, 503);
  const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
  if (!m || !(await tokenOk(m[1], want))) return c.json({ error: "unauthorized" }, 401);
  let body: { tags?: unknown; paths?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "body must be JSON" }, 400); }
  if (!body || typeof body !== "object") return c.json({ error: "body must be a JSON object" }, 400);
  const paths = body.paths === undefined ? [] : Array.isArray(body.paths) ? body.paths : null;
  if (!paths || paths.some((p) => typeof p !== "string" || !p.startsWith("/"))) return c.json({ error: "paths must be an array of pathnames starting with /" }, 400);
  try {
    const r = await revalidateTag(env, [...cleanTags(body.tags, true), ...paths.map(pathTag)]);
    return c.json({ ok: true, ...r });
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, /no ISR_BUCKET/.test(msg) ? 503 : 400);
  }
};
export type { TagStore };

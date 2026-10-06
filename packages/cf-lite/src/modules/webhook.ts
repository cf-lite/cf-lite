/**
 * OPTIONAL module: CMS publish webhook -> cache purge / ISR regeneration (docs/webhooks.md, design: docs/design/cms-webhook.md).
 *
 *   // server/api/webhooks.ts - receiver: verify -> dedupe -> enqueue -> 200 (no purge work on the request path)
 *   export default new Hono<{ Bindings: Env }>().post("/cms", webhookReceiver({ adapter: genericAdapter() }));
 *   // server/queues/cms-webhook.ts - consumer: payload -> tags/paths -> purgeTags / revalidateTag
 *   export default webhookConsumer();
 *   // a loader / page: record which content it rendered, so a publish of that content purges the page
 *   const post = await getPost(id); trackContent(c, "post", post.id);
 *   export const isr = { maxAge: 300, swr: 3600, tags: (c) => contentTags(c) };
 *
 * Env: CMS_WEBHOOK_SECRET (string, or comma-separated list to rotate), WEBHOOK_QUEUE (Queue), WEBHOOK_KV | CF_CACHE_TAGS (KV, idempotency),
 *      plus whatever cache/isr need (CF_CACHE_TAGS | CF_CACHE_DB, ISR_BUCKET, ISR_QUEUE).
 */
import type { Context } from "hono";
import { cleanTags, pathTag, purgeTags, tagStoreFor, type CacheEnv } from "./cache.js";
import { revalidateTag, type IsrEnv } from "./isr.js";
import { backoff, defineQueue, type QueueBatchHandler } from "./queue.js";

// ---------- change events (what every adapter produces) ----------

export interface ChangeEvent {
  /** `publish` = new/updated live content, `unpublish` = expired/unpublished/deleted. Both invalidate the same tags. */
  action: "publish" | "unpublish";
  /** Content type, e.g. "post". Omit for a coarse "something changed" event (then `all` or `tags` should be set). */
  type?: string;
  /** Content id (stable CMS identifier). */
  id?: string;
  /** Locale of the changed variant, when the CMS reports one. */
  locale?: string;
  /** URL path(s) known to the CMS (slug-derived); purged via `path:` tags. */
  paths?: string[];
  /** Explicit extra tags (already in the app's own tag vocabulary). */
  tags?: string[];
  /** Coarse event (e.g. bulk sync with no ids): purge everything tagged `content:*` (`ALL_TAG`). */
  all?: boolean;
}

/** A provider adapter turns a verified raw request into change events. Pure: no I/O. */
export interface WebhookAdapter {
  name: string;
  /** Header (lower-case) carrying the delivery id for idempotency, if the provider sends one. */
  deliveryIdHeader?: string;
  /** Throw to reject the payload with 400. Return [] for events that need no action (ack + ignore). */
  parse(body: unknown, req: Request): ChangeEvent[];
  /** Provider-native delivery id from the body when there is no header (falls back to sha256 of the body). */
  deliveryId?(body: unknown): string | undefined;
}

// ---------- dependency tags (the tag ledger) ----------

/** Max tags the cache/isr modules keep per entry is 16; the `path:` tag takes one, leave one for app tags. */
export const MAX_CONTENT_TAGS = 14;
export const ALL_TAG = "content:*";
/** Tag for one piece of content. Locale-agnostic on purpose: a publish of any locale refreshes pages that rendered any variant. */
export const contentTag = (type: string, id: string) => `content:${type}:${id}`;
/** Tag meaning "any content of this type" (list pages: `trackContent(c, "post", "*")`). */
export const typeTag = (type: string) => `content:${type}:*`;

type Ledger = Map<string, Set<string>>; // type -> ids
const ledgers = new WeakMap<Request, Ledger>();
const reqOf = (c: Context | Request): Request => (c instanceof Request ? c : c.req.raw);

/**
 * Record that the current request's page rendered this content. Call from loaders/handlers; `id` may be "*" for "any of this type".
 * Keyed by the request object, so it works with cf-lite's `c` (loader), isr `tags: (c) =>` and cache `({ req }) =>`.
 */
export function trackContent(c: Context | Request, type: string, ids: string | number | Iterable<string | number>): void {
  const req = reqOf(c);
  let l = ledgers.get(req);
  if (!l) ledgers.set(req, (l = new Map()));
  let s = l.get(type);
  if (!s) l.set(type, (s = new Set()));
  for (const id of typeof ids === "string" || typeof ids === "number" ? [ids] : ids) s.add(String(id));
}

/**
 * Tags for everything tracked on this request. Over `max` tags, the types with the most ids collapse into the coarse
 * `content:<type>:*` tag first (every publish of that type then purges the page) - never silently drops a dependency.
 * `all: true` also adds `content:*`, the tag a coarse event (`ChangeEvent.all`, e.g. a bulk sync with no ids) purges: use it on pages that must follow bulk imports.
 */
export function contentTags(c: Context | Request, opts: { max?: number; all?: boolean } = {}): string[] {
  const max = (opts.max ?? MAX_CONTENT_TAGS) - (opts.all ? 1 : 0), l = ledgers.get(reqOf(c));
  if (!l) return opts.all ? [ALL_TAG] : [];
  const per = new Map<string, string[]>(); // type -> tags ("*" or collapsed => single type tag)
  for (const [type, ids] of l) per.set(type, ids.has("*") ? [typeTag(type)] : [...ids].map((id) => contentTag(type, id)));
  let total = [...per.values()].reduce((n, t) => n + t.length, 0);
  for (const [type, tags] of [...per].sort((a, b) => b[1].length - a[1].length)) {
    if (total <= max || tags.length < 2) break;
    per.set(type, [typeTag(type)]);
    total -= tags.length - 1;
  }
  return cleanTags([...per.values()].flat().concat(opts.all ? [ALL_TAG] : []));
}

/** Tags a publish of `ev` must purge: exact content, its type-wide tag, the coarse tag for collapsed pages, explicit tags, path tags. */
export function eventTags(ev: ChangeEvent): string[] {
  const out: string[] = [...(ev.tags ?? [])];
  if (ev.all) out.push(ALL_TAG);
  if (ev.type) { out.push(typeTag(ev.type)); if (ev.id) out.push(contentTag(ev.type, ev.id)); }
  for (const p of ev.paths ?? []) out.push(pathTag(p));
  return cleanTags(out);
}

// ---------- verification ----------

export interface VerifyOptions {
  /**
   * `hmac` (canonical): header `x-cms-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<rawBody>")>`; several `v1=` allowed
   * (sender-side rotation). `secret`: `signatureHeader` equals the secret (constant-time), e.g. Optimizely's `x-api-key`.
   */
  mode: "hmac" | "secret";
  signatureHeader: string;
  /** Default 300. hmac only. */
  toleranceSeconds?: number;
}
export type VerifyResult = { ok: true } | { ok: false; status: 400 | 401 | 503; error: string };

export const DEFAULT_VERIFY: VerifyOptions = { mode: "hmac", signatureHeader: "x-cms-signature" };
export const DELIVERY_HEADER = "x-cms-delivery";
const enc = new TextEncoder();
async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
/** Constant-time string compare: both sides are hashed first so length never leaks, then compared without early exit. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  const sub = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  if (sub.timingSafeEqual) return sub.timingSafeEqual(x, y);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
/** `secret` may be "new,old" to rotate without downtime. */
const secretsOf = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Verify an incoming webhook against the raw body text. Pure apart from `now`. Fails closed when no secret is configured. */
export async function verifyWebhook(req: Request, rawBody: string, secret: string | undefined, o: VerifyOptions = DEFAULT_VERIFY, now = Date.now()): Promise<VerifyResult> {
  const secrets = secretsOf(secret);
  if (!secrets.length) return { ok: false, status: 503, error: "webhook disabled: secret not configured" };
  const given = (req.headers.get(o.signatureHeader) ?? "").trim();
  if (!given) return { ok: false, status: 401, error: "missing signature" };
  if (o.mode === "secret") {
    let ok = false;
    for (const s of secrets) ok = (await safeEqual(given, s)) || ok; // no early exit
    return ok ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
  }
  let t = "";
  const sigs: string[] = [];
  for (const part of given.split(",")) {
    const i = part.indexOf("="), k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v1") sigs.push(v.toLowerCase());
  }
  if (!/^\d{9,11}$/.test(t) || !sigs.length) return { ok: false, status: 401, error: "malformed signature" };
  if (Math.abs(now - Number(t) * 1000) > (o.toleranceSeconds ?? 300) * 1000) return { ok: false, status: 401, error: "timestamp outside tolerance" };
  let ok = false;
  for (const s of secrets) {
    const want = toHex(await hmac(s, `${t}.${rawBody}`));
    for (const g of sigs) ok = (await safeEqual(g, want)) || ok;
  }
  return ok ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
}
/** Sign exactly like the canonical sender (tests, mock CMS in examples/cms-head). Returns the headers to send, incl. `x-cms-delivery` when `delivery` is given. */
export async function signWebhook(body: string, secret: string, now = Date.now(), delivery?: string): Promise<Record<string, string>> {
  const t = Math.floor(now / 1000);
  return { [DEFAULT_VERIFY.signatureHeader]: `t=${t},v1=${toHex(await hmac(secret, `${t}.${body}`))}`, ...(delivery ? { [DELIVERY_HEADER]: delivery } : {}) };
}

// ---------- idempotency ----------

/** Seen-delivery store. KV is not atomic: two simultaneous duplicates may both pass - harmless, purges are idempotent. */
export interface DedupeStore { seen(id: string): Promise<boolean>; mark(id: string): Promise<void> }
export const DEDUPE_TTL_S = 24 * 3600;
export function kvDedupe(kv: KVNamespace, ttl = DEDUPE_TTL_S): DedupeStore {
  return {
    async seen(id) { return (await kv.get("cfl:wh:" + id)) !== null; },
    async mark(id) { await kv.put("cfl:wh:" + id, "1", { expirationTtl: Math.max(60, ttl) }); },
  };
}

// ---------- generic JSON adapter ----------

/**
 * Generic adapter. Body: `{ "id"?: "delivery-id", "events": [ChangeEvent-ish...] }`, or one event object, where an event is
 * `{ action?: "publish"|"unpublish", type, id, locale?, paths?, tags? }`. Unknown fields are ignored; `action` defaults to "publish".
 */
export function genericAdapter(): WebhookAdapter {
  const str = (v: unknown, what: string, max = 256) => {
    if (typeof v !== "string" || !v || v.length > max) throw new Error(`${what} must be a non-empty string (<= ${max} chars)`);
    return v;
  };
  return {
    name: "generic",
    deliveryIdHeader: DELIVERY_HEADER,
    deliveryId: (b) => (b && typeof b === "object" && typeof (b as { id?: unknown }).id === "string" ? (b as { id: string }).id : undefined),
    parse(body) {
      if (!body || typeof body !== "object") throw new Error("body must be a JSON object");
      const list = Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : [body];
      if (list.length > 100) throw new Error("at most 100 events per delivery");
      return list.map((e): ChangeEvent => {
        if (!e || typeof e !== "object") throw new Error("event must be an object");
        const x = e as Record<string, unknown>;
        const action = x.action === undefined ? "publish" : x.action;
        if (action !== "publish" && action !== "unpublish") throw new Error("event.action must be publish|unpublish");
        const paths = x.paths === undefined ? undefined : Array.isArray(x.paths) ? x.paths.map((p) => { if (typeof p !== "string" || !p.startsWith("/")) throw new Error("event.paths must be pathnames starting with /"); return p; }) : (() => { throw new Error("event.paths must be an array"); })();
        const tags = x.tags === undefined ? undefined : cleanTags(x.tags, true);
        const ev: ChangeEvent = { action, ...(paths ? { paths } : {}), ...(tags ? { tags } : {}) };
        if (x.type !== undefined || x.id !== undefined) { ev.type = str(x.type, "event.type", 64); ev.id = str(typeof x.id === "number" ? String(x.id) : x.id, "event.id"); }
        if (typeof x.locale === "string") ev.locale = x.locale.slice(0, 35);
        if (!ev.type && !ev.paths && !ev.tags) throw new Error("event needs type+id, paths or tags");
        return ev;
      });
    },
  };
}

// ---------- receiver ----------

export interface WebhookMessage {
  v: 1;
  /** Delivery id used for dedupe. */
  delivery: string;
  provider: string;
  /** epoch ms the webhook was accepted. */
  at: number;
  events: ChangeEvent[];
}
export interface WebhookEnv extends IsrEnv {
  CMS_WEBHOOK_SECRET?: string;
  WEBHOOK_QUEUE?: Queue<WebhookMessage>;
  WEBHOOK_KV?: KVNamespace;
}
export interface ReceiverOptions {
  adapter: WebhookAdapter;
  verify?: VerifyOptions;
  /** Max body bytes (default 256 KiB). */
  maxBytes?: number;
  /** Override the secret lookup (default `env.CMS_WEBHOOK_SECRET`). */
  secret?(env: WebhookEnv): string | undefined;
  /** Override the dedupe store (default: KV `WEBHOOK_KV` | `CF_CACHE_TAGS`; none bound = no dedupe, a warning is logged once). */
  dedupe?(env: WebhookEnv): DedupeStore | undefined;
  now?(): number;
}

async function sha256Hex(s: string) { return toHex((await digest(s)).slice(0, 16)); }
let warnedNoDedupe = false;

/**
 * Hono handler: verify -> parse -> dedupe -> enqueue -> 200. Status: 401 bad signature, 413 too big, 400 bad payload,
 * 503 no secret / no queue (fail closed, the CMS retries), 200 `{ ok, duplicate?, events }`. Nothing is purged here.
 */
export const webhookReceiver = (o: ReceiverOptions): ((c: Context) => Promise<Response>) => async (c) => {
  const env = c.env as WebhookEnv, now = o.now?.() ?? Date.now(), req = c.req.raw;
  if (!env.WEBHOOK_QUEUE) return c.json({ error: "webhook disabled: WEBHOOK_QUEUE not bound" }, 503);
  const max = o.maxBytes ?? 256 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > max) return c.json({ error: "payload too large" }, 413);
  const raw = await req.text();
  if (raw.length > max) return c.json({ error: "payload too large" }, 413);
  const v = await verifyWebhook(req, raw, (o.secret ?? ((e) => e.CMS_WEBHOOK_SECRET))(env), o.verify ?? DEFAULT_VERIFY, now);
  if (!v.ok) return c.json({ error: v.error }, v.status);
  let body: unknown, events: ChangeEvent[];
  try { body = JSON.parse(raw); events = o.adapter.parse(body, req); } catch (e) { return c.json({ error: "bad payload: " + (e as Error).message }, 400); }
  if (!events.length) return c.json({ ok: true, ignored: true, events: 0 });
  const delivery = (o.adapter.deliveryIdHeader && req.headers.get(o.adapter.deliveryIdHeader)) || o.adapter.deliveryId?.(body) || (await sha256Hex(raw));
  const store = (o.dedupe ?? ((e) => { const kv = e.WEBHOOK_KV ?? e.CF_CACHE_TAGS; return kv ? kvDedupe(kv) : undefined; }))(env);
  if (!store && !warnedNoDedupe) { warnedNoDedupe = true; console.warn("[cf-lite webhook] no WEBHOOK_KV/CF_CACHE_TAGS bound: duplicate deliveries are re-processed (harmless, but wasteful)"); }
  const key = o.adapter.name + ":" + delivery;
  if (store && (await store.seen(key))) return c.json({ ok: true, duplicate: true, events: 0 });
  // enqueue first, mark second: a crash between the two means a re-delivery is re-enqueued (safe), never a lost event
  await env.WEBHOOK_QUEUE.send({ v: 1, delivery: key, provider: o.adapter.name, at: now, events });
  if (store) await store.mark(key);
  return c.json({ ok: true, events: events.length });
};

// ---------- consumer ----------

export interface ConsumerOptions {
  /** Map an event to extra tags/paths on top of the defaults (`eventTags`). Return `null`/`undefined` for the defaults. */
  resolve?(ev: ChangeEvent, env: WebhookEnv): { tags?: string[]; paths?: string[] } | null | undefined | Promise<{ tags?: string[]; paths?: string[] } | null | undefined>;
  maxAttempts?: number;
  retry?: { base?: number; factor?: number; max?: number };
  now?(): number;
}
export interface WebhookOutcome { tags: string[]; mode: "isr" | "cache" | "none" }

/** Purge/regenerate everything an event batch touches: ISR (`revalidateTag`: queue regen + ledger purge) when ISR_BUCKET is bound, else `purgeTags`. */
export async function applyEvents(env: WebhookEnv, events: ChangeEvent[], opts: ConsumerOptions = {}, now = Date.now()): Promise<WebhookOutcome> {
  const all = new Set<string>();
  for (const ev of events) {
    for (const t of eventTags(ev)) all.add(t);
    const extra = await opts.resolve?.(ev, env);
    for (const t of cleanTags([...(extra?.tags ?? []), ...(extra?.paths ?? []).map(pathTag)])) all.add(t);
  }
  const tags = [...all];
  if (!tags.length) return { tags, mode: "none" };
  for (let i = 0; i < tags.length; i += 100) {
    const chunk = tags.slice(i, i + 100);
    if (env.ISR_BUCKET) await revalidateTag(env, chunk, now);
    else if (tagStoreFor(env)) await purgeTags(env as CacheEnv, chunk, now);
    else throw new Error("cf-lite webhook: nothing to purge into - bind CF_CACHE_TAGS/CF_CACHE_DB (and ISR_BUCKET for ISR pages)");
  }
  return { tags, mode: env.ISR_BUCKET ? "isr" : "cache" };
}

/** Queue consumer: `export default webhookConsumer()`. Retries with backoff; a purge is idempotent so redelivery is safe. */
export function webhookConsumer(opts: ConsumerOptions = {}): QueueBatchHandler<WebhookMessage> {
  return defineQueue<WebhookMessage>({
    each: async (msg, _m, env: WebhookEnv) => {
      if (!msg || msg.v !== 1 || !Array.isArray(msg.events)) { console.error("[cf-lite webhook] dropping malformed message"); return; }
      await applyEvents(env, msg.events, opts, opts.now?.() ?? Date.now());
    },
    maxAttempts: opts.maxAttempts ?? 6,
    retryDelay: backoff(opts.retry ?? { base: 5, factor: 2, max: 300 }),
    onDead: (msg, _m, err) => console.error(`[cf-lite webhook] giving up on delivery ${msg?.delivery}:`, err),
  });
}

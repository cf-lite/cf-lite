/**
 * Rate limiting (`cf-lite/modules/ratelimit`).
 *
 * Three limiters behind one interface `{ limit(key) -> { ok, remaining, retryAfter } }`:
 *  - `bindingLimiter(env.RATE_LIMITER)`: the Workers `ratelimit` binding. Per-location and eventually consistent ("approximate" by design):
 *    right for abuse dampening, wrong for "exactly 5 login tries". Its limit/period live in wrangler config (period is 10 or 60 s), so pass
 *    the same `period` here only to fill `Retry-After`.
 *  - `doLimiter(env.LIMITER_DO, { limit, period })`: a Durable Object per key, fixed window, exact and global. For login/OTP/password reset.
 *  - `memoryLimiter({ limit, period })`: per-isolate Map. Dev/tests, and the fallback when no binding is configured.
 *
 *   app.use("/api/*", rateLimit({ binding: "RATE_LIMITER", key: "ip", period: 60 }));
 *   app.post("/login", rateLimit({ limiter: (c) => doLimiter(c.env.LIMITER_DO, { limit: 5, period: 300 }), key: (c) => c.req.json().then(b => b.email) }), ...);
 *   // server action: save: rateLimited({ key: "ip", limit: 3, period: 60 }, async (form, c) => ...)
 */
import type { Context, MiddlewareHandler } from "hono";

export interface LimitResult { ok: boolean; remaining?: number; /** seconds until the window resets */ retryAfter: number }
export interface Limiter { limit(key: string): Promise<LimitResult> | LimitResult }

// ---------------------------------------------------------------- limiters
/** Workers ratelimit binding. */
export function bindingLimiter(binding: { limit(o: { key: string }): Promise<{ success: boolean }> }, period = 60): Limiter {
  return { async limit(key) { const r = await binding.limit({ key }); return { ok: r.success, retryAfter: period }; } };
}

/** Fixed-window counter in this isolate's memory. `now` is injectable for tests. */
export function memoryLimiter(o: { limit: number; period: number; now?: () => number; max?: number }): Limiter {
  const hits = new Map<string, { n: number; reset: number }>();
  const now = o.now ?? Date.now;
  return {
    limit(key) {
      const t = now();
      if (hits.size > (o.max ?? 10_000)) for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      let h = hits.get(key);
      if (!h || h.reset <= t) { h = { n: 0, reset: t + o.period * 1000 }; hits.set(key, h); }
      h.n++;
      return { ok: h.n <= o.limit, remaining: Math.max(0, o.limit - h.n), retryAfter: Math.max(1, Math.ceil((h.reset - t) / 1000)) };
    },
  };
}

/**
 * Durable Object class for `doLimiter`: one object per key, fixed window kept in storage, cleaned by an alarm.
 *   export { RateLimiterDO } from "cf-lite/modules/ratelimit";
 *   // wrangler: durable_objects.bindings [{ name: "LIMITER_DO", class_name: "RateLimiterDO" }], migrations [{ tag: "v1", new_sqlite_classes: ["RateLimiterDO"] }]
 */
export class RateLimiterDO {
  constructor(private state: { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void>; deleteAll(): Promise<void>; setAlarm(t: number): Promise<void> } }) {}
  async fetch(req: Request): Promise<Response> {
    const { limit, period } = (await req.json()) as { limit: number; period: number };
    const now = Date.now();
    let w = await this.state.storage.get<{ n: number; reset: number }>("w");
    if (!w || w.reset <= now) { w = { n: 0, reset: now + period * 1000 }; await this.state.storage.setAlarm(w.reset + 1000); }
    w.n++;
    await this.state.storage.put("w", w);
    return Response.json({ ok: w.n <= limit, remaining: Math.max(0, limit - w.n), retryAfter: Math.max(1, Math.ceil((w.reset - now) / 1000)) } satisfies LimitResult);
  }
  async alarm() { await this.state.storage.deleteAll(); }
}

/** Exact, global limiter over a `RateLimiterDO` namespace. Rejected attempts count (a flood cannot reset its own window). */
export function doLimiter(ns: { idFromName(n: string): unknown; get(id: any): { fetch(u: string, i?: RequestInit): Promise<Response> } }, o: { limit: number; period: number }): Limiter {
  return { async limit(key) { return (await (await ns.get(ns.idFromName(key)).fetch("https://ratelimit/", { method: "POST", body: JSON.stringify(o) })).json()) as LimitResult; } };
}

// ---------------------------------------------------------------- middleware / action wrapper
export type KeySource = "ip" | "session" | ((c: Context) => string | undefined | Promise<string | undefined>);

export interface RateLimitOptions {
  /** Explicit limiter (DO, memory, custom). Wins over `binding`. */
  limiter?: Limiter | ((c: Context) => Limiter);
  /** Name of a ratelimit binding in `env` (e.g. "RATE_LIMITER"). Without it (or when missing from env) the memory limiter applies. */
  binding?: string;
  /** What to count: client IP (`CF-Connecting-IP`), the session user id (falls back to IP), or a function. Default "ip". */
  key?: KeySource;
  /** Prefix to keep counters of different rules apart. Default: request pathname for "ip"/"session", none for functions. */
  scope?: string;
  /** Memory-fallback + `Retry-After` sizing: requests per `period` seconds (binding limits live in wrangler config). Default 60 / 60. */
  limit?: number;
  period?: number;
  /** Let the request through when the limiter itself fails. Default true (availability over strictness); use false for auth paths. */
  failOpen?: boolean;
  /** Response body. Default "Too Many Requests". */
  message?: string;
}

export async function keyOf(c: Context, src: KeySource = "ip"): Promise<string> {
  const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (typeof src === "function") return (await src(c)) ?? ip;
  if (src === "session") { const s = (c.get as (k: string) => { userId?: string } | undefined)("session"); return s?.userId ? `u:${s.userId}` : `ip:${ip}`; }
  return `ip:${ip}`;
}

export function tooMany(retryAfter: number, message = "Too Many Requests"): Response {
  return new Response(message, { status: 429, headers: { "retry-after": String(retryAfter), "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/** Resolve the limiter + key and count one hit. Returns a 429 Response when over the limit, otherwise undefined (headers for success in `extra`). */
export async function check(c: Context, o: RateLimitOptions, fallback: { mem?: Limiter }): Promise<{ res?: Response; result?: LimitResult }> {
  const period = o.period ?? 60, limit = o.limit ?? 60;
  try {
    let lim: Limiter | undefined = typeof o.limiter === "function" ? o.limiter(c) : o.limiter;
    const b = o.binding ? (c.env as Record<string, any> | undefined)?.[o.binding] : undefined;
    if (!lim && b) lim = bindingLimiter(b, period);
    lim ??= (fallback.mem ??= memoryLimiter({ limit, period }));
    const scope = o.scope ?? (typeof o.key === "function" ? "" : new URL(c.req.url).pathname);
    const r = await lim.limit(`${scope}|${await keyOf(c, o.key)}`);
    return r.ok ? { result: r } : { res: tooMany(r.retryAfter, o.message), result: r };
  } catch (e) {
    if (o.failOpen === false) return { res: tooMany(period, o.message) };
    console.warn("[cf-lite] ratelimit failed open:", (e as Error)?.message ?? e);
    return {};
  }
}

/** Hono middleware. 429 + `Retry-After` when over the limit. */
export function rateLimit(o: RateLimitOptions = {}): MiddlewareHandler {
  const fb: { mem?: Limiter } = {};
  return async (c, next) => {
    const { res } = await check(c, o, fb);
    if (res) return res;
    await next();
  };
}

/** Wrap a server action handler: over the limit -> `fail(429, { error })` (page re-rendered with 429, `Retry-After` is sent on JSON/JS mode via the body). */
export function rateLimited<F extends (form: FormData, c: Context) => unknown>(o: RateLimitOptions, handler: F): (form: FormData, c: Context) => Promise<unknown> {
  const fb: { mem?: Limiter } = {};
  return async (form, c) => {
    const { res } = await check(c, o, fb);
    if (res) return res; // a Response from an action is sent as-is (see modules/actions.ts)
    return handler(form, c);
  };
}

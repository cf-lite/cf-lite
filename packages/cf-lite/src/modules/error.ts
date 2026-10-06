/**
 * Error reporting (`cf-lite/modules/error`): the `onError` of the generated app plus a reporter interface. docs/observability.md.
 *
 * `server/error.ts` (optional) picks reporters; without it nothing here is bundled:
 *
 *   import { sentry, fetchSink } from "cf-lite/modules/error";
 *   export default { reporters: [sentry({ dsn: (env) => env.SENTRY_DSN })] };
 *
 * The handler logs a structured error line carrying the digest (= request id), hands the error to every reporter through
 * `waitUntil` (a failing reporter never changes the response), and answers 500 - HTML with the digest for browsers, problem+json
 * for `Accept: application/json` and `/api/*`. No stack or message reaches the client unless `dev: true`.
 */
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { log as defaultLog, requestId, serializeError, type Logger } from "./log.js";

export interface ErrorReport {
  error: unknown;
  /** Request id shown to the user as the digest and present on every log line of the request. */
  digest: string;
  method: string;
  url: string;
  status: number;
  /** Extra tags (route, user id ...) a caller attached via `c.set("errorTags", {...})`. */
  tags?: Record<string, string>;
}
export type Reporter = (report: ErrorReport, env: unknown) => void | Promise<void>;

export interface ErrorOptions {
  reporters?: Reporter[];
  /** Include message + stack in the response. Default false (never in production). */
  dev?: boolean;
  logger?: Logger;
  /** Skip logging/reporting these errors (the response is still 500). `HTTPException`s below 500 are never reported. */
  ignore?: (error: unknown) => boolean;
}

const SYM = Symbol.for("cf-lite.report");
type Info = { digest: string; method: string; url: string; status?: number };
type GlobalHook = (e: unknown, info: Info, env?: unknown, ctx?: { waitUntil(p: Promise<unknown>): void }) => void;

/** `ssr()` calls this for render errors it recovers from itself; a no-op until `errorHandler()` ran (i.e. `server/error.ts` exists). */
export function reportError(e: unknown, info: Info, env?: unknown, ctx?: { waitUntil(p: Promise<unknown>): void }): void {
  (globalThis as unknown as Record<symbol, GlobalHook | undefined>)[SYM]?.(e, info, env, ctx);
}

function run(reporters: Reporter[], report: ErrorReport, env: unknown, ctx?: { waitUntil(p: Promise<unknown>): void }) {
  if (!reporters.length) return;
  const p = Promise.allSettled(reporters.map((r) => Promise.resolve().then(() => r(report, env)))).then((rs) => {
    for (const r of rs) if (r.status === "rejected") console.error(JSON.stringify({ level: "error", msg: "reporter failed", err: serializeError(r.reason, false) }));
  });
  try { ctx?.waitUntil(p); } catch { /* no ExecutionContext (unit tests) */ }
}

const wantsJson = (c: Context) => {
  const a = c.req.header("accept") ?? "";
  return c.req.path.startsWith("/api/") || (a.includes("json") && !a.includes("html"));
};
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Build the function for `app.onError(...)`. */
export function errorHandler(o: ErrorOptions = {}) {
  const reporters = o.reporters ?? [];
  (globalThis as unknown as Record<symbol, GlobalHook>)[SYM] = (e, info, env, ctx) => run(reporters, { error: e, status: 500, ...info }, env, ctx);
  return (err: Error, c: Context): Response => {
    if (err instanceof HTTPException && err.status < 500) return err.getResponse();
    const digest = requestId(c);
    const status = err instanceof HTTPException ? err.status : 500;
    if (!o.ignore?.(err)) {
      ((c.get("log") as Logger | undefined) ?? o.logger ?? defaultLog).error("unhandled error", { digest, method: c.req.method, path: c.req.path, status, err: serializeError(err) });
      let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
      try { ctx = c.executionCtx; } catch { /* none */ }
      run(reporters, { error: err, digest, method: c.req.method, url: c.req.url, status, tags: c.get("errorTags" as never) as Record<string, string> | undefined }, c.env, ctx);
    }
    const headers: Record<string, string> = { "x-request-id": digest, "cache-control": "no-store" };
    if (wantsJson(c)) {
      const detail = o.dev ? { message: err.message, stack: err.stack } : {};
      return new Response(JSON.stringify({ type: "about:blank", title: "Internal Server Error", status, digest, ...detail }), { status, headers: { ...headers, "content-type": "application/problem+json" } });
    }
    const extra = o.dev ? `<pre>${esc(err.stack ?? err.message)}</pre>` : "";
    return new Response(`<!doctype html><meta charset="utf-8"><title>Something went wrong</title><h1>Something went wrong</h1><p>Error digest: <code>${esc(digest)}</code></p>${extra}`, { status, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
  };
}

// ---- reporters ---------------------------------------------------------------------------------------------------------------

type Fetch = typeof fetch;
const resolve = <T>(v: T | ((env: any) => T), env: unknown): T => (typeof v === "function" ? (v as (e: unknown) => T)(env) : v);

export interface FetchSinkOptions {
  url: string | undefined | ((env: any) => string | undefined);
  headers?: Record<string, string>;
  fetch?: Fetch;
  timeoutMs?: number;
}
/** POST the report as JSON (stack included - it goes to your backend, not the client). No url -> skipped. */
export function fetchSink(o: FetchSinkOptions): Reporter {
  return async (r, env) => {
    const url = resolve(o.url, env);
    if (!url) return;
    await (o.fetch ?? fetch)(url, {
      method: "POST", headers: { "content-type": "application/json", ...o.headers },
      body: JSON.stringify({ digest: r.digest, method: r.method, url: r.url, status: r.status, tags: r.tags, error: serializeError(r.error), time: new Date().toISOString() }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
  };
}

export interface SentryOptions {
  dsn: string | undefined | ((env: any) => string | undefined);
  environment?: string;
  release?: string;
  fetch?: Fetch;
}
/**
 * Sentry without an SDK: one envelope POST per error. Fine for "tell me it broke"; for breadcrumbs/source maps use `toucan-js`
 * (recipe in docs/observability.md). DSN unset -> no-op.
 */
export function sentry(o: SentryOptions): Reporter {
  return async (r, env) => {
    const dsn = resolve(o.dsn, env);
    if (!dsn) return;
    const u = new URL(dsn);
    const e = serializeError(r.error);
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId, timestamp: Date.now() / 1000, platform: "javascript", level: "error", environment: o.environment, release: o.release,
      exception: { values: [{ type: e.name ?? "Error", value: e.message }] },
      request: { url: r.url, method: r.method }, tags: { digest: r.digest, ...r.tags }, extra: { stack: e.stack },
    };
    const body = [JSON.stringify({ event_id: eventId, dsn }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    await (o.fetch ?? fetch)(`${u.protocol}//${u.host}/api/${u.pathname.replace(/^\/+/, "")}/envelope/`, {
      method: "POST", body, headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=cf-lite/1` },
      signal: AbortSignal.timeout(5000),
    });
  };
}

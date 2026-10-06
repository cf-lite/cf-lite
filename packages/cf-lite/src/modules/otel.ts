/**
 * Tracing (`cf-lite/modules/otel`): W3C `traceparent` propagation + a tiny OTLP/HTTP-JSON span exporter. Imported only by apps that
 * use it. docs/observability.md. (Cloudflare's automatic Workers tracing, where available, needs no code: `observability.traces`.)
 *
 *   app.use("*", tracing({ service: "web", endpoint: (env) => env.OTLP_URL, headers: (env) => ({ authorization: env.OTLP_AUTH }) }));
 *   const rows = await span("load-posts", () => db.all());     // child span of the request
 *   await tracedFetch("https://api.example.com/x");            // child span + traceparent on the outgoing call
 *
 * `span()`/`tracedFetch()` take `{ c }` to attach to a specific request; without it they use the request currently being traced
 * (best-effort under concurrency; pass `{ c }` for exactness).
 */
import type { Context, MiddlewareHandler } from "hono";
import { requestId } from "./log.js";

export interface TraceContext { traceId: string; spanId: string; sampled: boolean }

export function parseTraceparent(h: string | null | undefined): TraceContext | null {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec((h ?? "").trim());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], spanId: m[2], sampled: (parseInt(m[3], 16) & 1) === 1 };
}
export const formatTraceparent = (t: TraceContext) => `00-${t.traceId}-${t.spanId}-${t.sampled ? "01" : "00"}`;
const rand = (bytes: number) => { const a = crypto.getRandomValues(new Uint8Array(bytes)); return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); };
export const newSpanId = () => rand(8);
export const newTraceId = () => rand(16);
/** Same trace, fresh span id. */
export const childContext = (p: TraceContext): TraceContext => ({ ...p, spanId: newSpanId() });

export interface SpanRecord {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startMs: number; endMs: number; attributes: Record<string, string | number | boolean>; error?: string;
}

export interface OtelOptions {
  service: string;
  /** OTLP/HTTP traces endpoint, e.g. `https://otlp.example.com/v1/traces`. Unset (or resolving to undefined) = propagate only, export nothing. */
  endpoint?: string | ((env: any) => string | undefined);
  headers?: Record<string, string> | ((env: any) => Record<string, string>);
  /** Fraction of *new* traces (no inbound decision) to sample. Default 1. */
  sampleRate?: number;
  fetch?: typeof fetch;
}

const attrs = (a: SpanRecord["attributes"]) => Object.entries(a).map(([key, v]) => ({ key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }));
const nano = (ms: number) => String(Math.round(ms * 1e6));

/** OTLP/HTTP JSON body (`ExportTraceServiceRequest`). */
export function otlpBody(service: string, spans: SpanRecord[]) {
  return {
    resourceSpans: [{
      resource: { attributes: attrs({ "service.name": service }) },
      scopeSpans: [{ scope: { name: "cf-lite" }, spans: spans.map((s) => ({
        traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name, kind: s.kind,
        startTimeUnixNano: nano(s.startMs), endTimeUnixNano: nano(s.endMs), attributes: attrs(s.attributes),
        status: s.error ? { code: 2, message: s.error } : { code: 1 },
      })) }],
    }],
  };
}

export interface RequestTrace {
  ctx: TraceContext;
  spans: SpanRecord[];
  opts: OtelOptions;
  env: unknown;
}

declare module "hono" {
  interface ContextVariableMap { trace: RequestTrace }
}

const now = () => Date.now();

/** Run `fn` as a child span of the request's trace (or of `parent`). No active trace -> just runs `fn`. */
export async function span<T>(name: string, fn: () => T | Promise<T>, o: { c?: Context; attributes?: SpanRecord["attributes"]; kind?: number } = {}): Promise<T> {
  const rt = o.c?.get("trace") as RequestTrace | undefined ?? current;
  if (!rt || !rt.ctx.sampled) return fn();
  const s: SpanRecord = { traceId: rt.ctx.traceId, spanId: newSpanId(), parentSpanId: rt.ctx.spanId, name, kind: o.kind ?? 1, startMs: now(), endMs: 0, attributes: { ...o.attributes } };
  try { return await fn(); } catch (e) { s.error = (e as Error)?.message ?? String(e); throw e; } finally { s.endMs = now(); rt.spans.push(s); }
}

/** fetch with a child span and `traceparent` forwarded. */
export async function tracedFetch(input: RequestInfo | URL, init: RequestInit = {}, o: { c?: Context; fetch?: typeof fetch } = {}): Promise<Response> {
  const rt = o.c?.get("trace") as RequestTrace | undefined ?? current;
  const f = o.fetch ?? fetch;
  if (!rt) return f(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const spanId = newSpanId();
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("traceparent", formatTraceparent({ ...rt.ctx, spanId }));
  const s: SpanRecord = { traceId: rt.ctx.traceId, spanId, parentSpanId: rt.ctx.spanId, name: `fetch ${method}`, kind: 3, startMs: now(), endMs: 0, attributes: { "http.request.method": method, "url.full": url.split("?")[0] } };
  try {
    const res = await f(input, { ...init, headers });
    s.attributes["http.response.status_code"] = res.status;
    if (res.status >= 500) s.error = `HTTP ${res.status}`;
    return res;
  } catch (e) { s.error = (e as Error)?.message ?? String(e); throw e; } finally { s.endMs = now(); if (rt.ctx.sampled) rt.spans.push(s); }
}

// `span()` without a Context: the most recent request trace (Workers run one request per isolate turn often enough for a
// best-effort default; pass `{ c }` for exactness under concurrency).
let current: RequestTrace | undefined;

/** Middleware: continue the inbound trace (or start one), record a server span, export through `waitUntil`, echo `traceparent`. */
export function tracing(opts: OtelOptions): MiddlewareHandler {
  return async (c, next) => {
    const inbound = parseTraceparent(c.req.header("traceparent"));
    const sampled = inbound ? inbound.sampled : Math.random() < (opts.sampleRate ?? 1);
    const ctx: TraceContext = { traceId: inbound?.traceId ?? newTraceId(), spanId: newSpanId(), sampled };
    const rt: RequestTrace = { ctx, spans: [], opts, env: c.env };
    c.set("trace", rt);
    current = rt;
    const root: SpanRecord = { traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: inbound?.spanId, name: `${c.req.method} ${c.req.path}`, kind: 2, startMs: now(), endMs: 0, attributes: { "http.request.method": c.req.method, "url.path": c.req.path, "cf_lite.request_id": safeId(c) } };
    c.header("traceparent", formatTraceparent(ctx));
    try { await next(); } catch (e) { root.error = (e as Error)?.message ?? String(e); throw e; } finally {
      root.endMs = now();
      root.attributes["http.response.status_code"] = c.res?.status ?? 0;
      if (c.res && c.res.status >= 500 && !root.error) root.error = `HTTP ${c.res.status}`;
      if (current === rt) current = undefined;
      if (sampled) exportSpans(c, rt, [root, ...rt.spans]);
    }
  };
}
const safeId = (c: Context) => { try { return requestId(c); } catch { return ""; } };

function exportSpans(c: Context, rt: RequestTrace, spans: SpanRecord[]) {
  const url = typeof rt.opts.endpoint === "function" ? rt.opts.endpoint(c.env) : rt.opts.endpoint;
  if (!url) return;
  const headers = typeof rt.opts.headers === "function" ? rt.opts.headers(c.env) : rt.opts.headers;
  const p = (rt.opts.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(otlpBody(rt.opts.service, spans)), signal: AbortSignal.timeout(5000) })
    .then((r) => { if (!r.ok) console.warn(`[cf-lite] otlp export ${r.status}`); }, (e) => console.warn("[cf-lite] otlp export failed:", e?.message ?? e));
  try { c.executionCtx.waitUntil(p); } catch { /* no ExecutionContext */ }
}


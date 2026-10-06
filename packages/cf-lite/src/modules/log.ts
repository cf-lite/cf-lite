/**
 * Structured JSON logging (`cf-lite/modules/log`). One line of JSON per call, which is what Workers Logs
 * (`observability.enabled`) indexes field-by-field. docs/observability.md.
 *
 *   import { log, logging, requestId } from "cf-lite/modules/log";
 *   app.use("*", logging());                      // request id + access line; `c.var.log` is a child logger
 *   log.info("signup", { plan: "pro" });          // {"level":"info","msg":"signup","plan":"pro"}
 *
 * Redaction: keys matching `redact` (default: password/secret/token/authorization/cookie/api key ...) at any depth are replaced
 * with "[redacted]" before serialising. Request id: `x-request-id` if well-formed, else `cf-ray`, else a fresh UUID.
 */
import type { Context, MiddlewareHandler } from "hono";
import { requestId } from "./request-id.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const DEFAULT_REDACT: RegExp[] = [/pass(word|wd)?/i, /secret/i, /token/i, /authorization/i, /cookie/i, /api[-_]?key/i, /credential/i, /session/i, /private[-_]?key/i, /^otp$/i];

export interface LoggerOptions {
  /** Minimum level emitted. Default "info". */
  level?: LogLevel;
  /** Key patterns (RegExp, or exact string) whose values are replaced. Replaces the default list; spread `DEFAULT_REDACT` to extend. */
  redact?: (RegExp | string)[];
  /** Fields on every line (service name, version ...). */
  base?: Record<string, unknown>;
  /** Output sink; default `console.log`/`console.error` by level. Receives the final JSON line. */
  write?: (line: string, level: LogLevel) => void;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown> | unknown): void;
  /** A logger that adds `fields` to every line. */
  child(fields: Record<string, unknown>): Logger;
}

const REDACTED = "[redacted]";

/** Serialise an Error (Error properties are non-enumerable, so plain JSON loses them). `stack` only when asked. */
export function serializeError(e: unknown, stack = true): Record<string, unknown> {
  if (e instanceof Error) {
    const o: Record<string, unknown> = { name: e.name, message: e.message };
    if (stack && e.stack) o.stack = e.stack;
    if ((e as { cause?: unknown }).cause !== undefined) o.cause = serializeError((e as { cause?: unknown }).cause, stack);
    return o;
  }
  return { message: typeof e === "string" ? e : safeString(e) };
}
const safeString = (v: unknown) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

export function redactValue(value: unknown, patterns: (RegExp | string)[] = DEFAULT_REDACT, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return typeof value === "bigint" ? value.toString() : value;
  if (value instanceof Error) return redactValue(serializeError(value), patterns, depth, seen);
  if (seen.has(value) || depth > 8) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, patterns, depth + 1, seen));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = patterns.some((p) => (typeof p === "string" ? p.toLowerCase() === k.toLowerCase() : p.test(k))) ? REDACTED : redactValue(v, patterns, depth + 1, seen);
  }
  return out;
}

export function createLogger(o: LoggerOptions = {}, bound: Record<string, unknown> = {}): Logger {
  const min = RANK[o.level ?? "info"];
  const patterns = o.redact ?? DEFAULT_REDACT;
  const write = o.write ?? ((line, level) => (level === "error" ? console.error(line) : level === "warn" ? console.warn(line) : console.log(line)));
  const emit = (level: LogLevel, msg: string, fields?: unknown) => {
    if (RANK[level] < min) return;
    const extra = fields instanceof Error ? { err: fields } : fields && typeof fields === "object" ? (fields as Record<string, unknown>) : fields === undefined ? {} : { detail: fields };
    // fixed keys last so a caller cannot overwrite `level`/`msg`
    const rec = redactValue({ ...o.base, ...bound, ...extra }, patterns) as Record<string, unknown>;
    write(safeString({ ...rec, level, msg, time: new Date().toISOString() }), level);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (f) => createLogger(o, { ...bound, ...f }),
  };
}

/** Default logger: level from nothing (info), default redaction. Configure by `createLogger` or `configureLog`. */
export let log: Logger = createLogger();
export function configureLog(o: LoggerOptions): Logger { return (log = createLogger(o)); }

export { requestId };

declare module "hono" {
  interface ContextVariableMap { requestId: string; log: Logger }
}

/**
 * Middleware: assigns `requestId`, exposes `c.var.log` (child logger with `requestId`), echoes `x-request-id` on the response (set before `next()`, so errors carry it too) and
 * writes one access line (method, path, status, ms). `access: false` to skip the line.
 */
export function logging(o: { logger?: Logger; access?: boolean } = {}): MiddlewareHandler {
  return async (c, next) => {
    const id = requestId(c);
    c.set("requestId", id);
    c.header("x-request-id", id);
    const l = (o.logger ?? log).child({ requestId: id });
    c.set("log", l);
    const t0 = Date.now();
    try { await next(); } finally {
      if (o.access !== false) l.info("request", { method: c.req.method, path: c.req.path, status: c.res?.status, ms: Date.now() - t0 });
    }
  };
}

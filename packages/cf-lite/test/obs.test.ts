import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { builtinConventions, metrics } from "../src/conventions/index.js";
import { runConventions } from "../src/generate.js";
import { createLogger, logging, redactValue, requestId, serializeError } from "../src/modules/log.js";
import { errorHandler, fetchSink, sentry } from "../src/modules/error.js";
import { formatTraceparent, otlpBody, parseTraceparent, span, tracedFetch, tracing } from "../src/modules/otel.js";
import { metric, metricsHandler, vitalsBeacon } from "../src/modules/metrics.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const gen = (files: Record<string, string>, extra: any[] = []) => {
  const root = mkdtempSync(join(here, ".tmp-obs-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return runConventions(root, undefined, [...builtinConventions, ...extra]);
};
const lines = () => { const out: Record<string, any>[] = []; return { out, write: (l: string) => void out.push(JSON.parse(l)) }; };

describe("zero bytes when unused", () => {
  it("no server/error.ts -> no onError, no obs imports", () => {
    const g = gen({ "server/api/hello.ts": "" });
    expect(g.files["app.ts"]).not.toMatch(/onError|modules\/error|modules\/log|otel|metrics/);
  });
  it("server/error.ts wires onError", () => {
    const g = gen({ "server/error.ts": "export default {};" });
    expect(g.files["app.ts"]).toContain(`import { errorHandler } from "cf-lite/modules/error";`);
    expect(g.files["app.ts"]).toContain(`.onError(errorHandler(errorOpts))`);
  });
  it("metrics() convention: route, worker-first glob, binding check", () => {
    const g = gen({ "server/api/a.ts": "" }, [metrics({ binding: "M" })]);
    expect(g.files["app.ts"]).toContain(`.post("/_m", metricsHandler({"binding":"M"}))`);
    expect(g.workerFirst).toContain("/_m");
    const run = (w: object) => g.checks.flatMap((c) => c(w as never));
    expect(run({})[0]).toMatch(/binding "M"/);
    expect(run({ analytics_engine_datasets: [{ binding: "M" }] })).toEqual([]);
  });
});

describe("log: redaction + shape", () => {
  it("redacts sensitive keys at any depth, keeps the rest", () => {
    const { out, write } = lines();
    const l = createLogger({ write });
    l.info("login", { user: "a", password: "hunter2", nested: { Authorization: "Bearer x", list: [{ apiKey: "k", ok: 1 }] }, cookie: "s=1" });
    const r = out[0];
    expect(r).toMatchObject({ level: "info", msg: "login", user: "a" });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|Bearer|"k"|s=1/);
    expect(r.nested.list[0]).toEqual({ apiKey: "[redacted]", ok: 1 });
  });
  it("custom redact list, levels, child fields, caller cannot overwrite level/msg", () => {
    const { out, write } = lines();
    const l = createLogger({ write, level: "warn", redact: ["ssn"] }).child({ requestId: "r1" });
    l.info("skipped"); l.warn("w", { ssn: "1", password: "visible", level: "debug", msg: "x" });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ level: "warn", msg: "w", requestId: "r1", ssn: "[redacted]", password: "visible" });
  });
  it("errors serialise with stack and cause; circular safe", () => {
    const e = new Error("outer", { cause: new TypeError("inner") });
    expect(serializeError(e)).toMatchObject({ name: "Error", message: "outer", cause: { name: "TypeError" } });
    const o: any = { a: 1 }; o.self = o;
    expect(redactValue(o)).toEqual({ a: 1, self: "[circular]" });
  });
  it("request id: inbound (well-formed) > cf-ray > uuid", () => {
    const r = (h: Record<string, string>) => requestId(new Request("http://x/", { headers: h }));
    expect(r({ "x-request-id": "abc-12345678" })).toBe("abc-12345678");
    expect(r({ "x-request-id": "bad id!", "cf-ray": "8a1b-SJC" })).toBe("8a1b-SJC");
    expect(r({})).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("request id in logs and in the error page digest", () => {
  const mk = (reporters: any[] = []) => {
    const { out, write } = lines();
    const logger = createLogger({ write });
    const app = new Hono();
    app.use("*", logging({ logger }));
    app.get("/boom", () => { throw new Error("secret detail"); });
    app.get("/api/boom", () => { throw new Error("secret detail"); });
    app.get("/ok", (c) => c.text("ok"));
    app.onError(errorHandler({ reporters, logger }));
    return { app, out };
  };
  it("the digest shown to the user is the request id on every log line", async () => {
    const { app, out } = mk();
    const res = await app.request("/boom", { headers: { "x-request-id": "req-abcdef12", accept: "text/html" } });
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain("req-abcdef12");
    expect(html).not.toMatch(/secret detail|at .*\.ts/);
    expect(res.headers.get("x-request-id")).toBe("req-abcdef12");
    const errLine = out.find((l) => l.msg === "unhandled error")!;
    expect(errLine).toMatchObject({ digest: "req-abcdef12", requestId: "req-abcdef12", status: 500 });
    expect(errLine.err.message).toBe("secret detail"); // in the log, not to the client
    expect(out.find((l) => l.msg === "request")).toMatchObject({ requestId: "req-abcdef12", status: 500 });
  });
  it("/api/* gets problem+json with the digest", async () => {
    const { app } = mk();
    const res = await app.request("/api/boom", { headers: { "x-request-id": "req-abcdef12" } });
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({ type: "about:blank", title: "Internal Server Error", status: 500, digest: "req-abcdef12" });
  });
  it("reporters receive the report; a failing one never changes the response", async () => {
    const got: any[] = [];
    const { app } = mk([async (r: any) => { got.push(r); }, () => { throw new Error("reporter down"); }]);
    const waits: Promise<unknown>[] = [];
    const res = await app.request("/boom", {}, {}, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any);
    await Promise.all(waits);
    expect(res.status).toBe(500);
    expect(got[0]).toMatchObject({ method: "GET", status: 500 });
    expect(got[0].error.message).toBe("secret detail");
  });
  it("sentry and fetchSink build the requests; unset dsn/url is a no-op", async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 }));
    const rep = { error: new Error("x"), digest: "d1", method: "GET", url: "https://a/b", status: 500 };
    await sentry({ dsn: (env) => env.DSN, fetch: f as any })(rep, {});
    expect(f).not.toHaveBeenCalled();
    await sentry({ dsn: "https://pub@o1.ingest.sentry.io/42", fetch: f as any })(rep, {});
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
    expect(init.headers["x-sentry-auth"]).toContain("sentry_key=pub");
    expect(init.body.split("\n")).toHaveLength(3);
    await fetchSink({ url: "https://sink/x", fetch: f as any })(rep, {});
    expect(JSON.parse((f.mock.calls[1] as any)[1].body)).toMatchObject({ digest: "d1", error: { message: "x" } });
  });
});

describe("otel: traceparent", () => {
  const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  it("parse/format roundtrip, rejects malformed and all-zero", () => {
    expect(formatTraceparent(parseTraceparent(tp)!)).toBe(tp);
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00")!.sampled).toBe(false);
    for (const bad of ["", "garbage", "00-" + "0".repeat(32) + "-b7ad6b7169203331-01", "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]) expect(parseTraceparent(bad)).toBeNull();
  });
  it("continues the inbound trace, exports spans, forwards traceparent on outgoing fetch", async () => {
    const exported: any[] = [];
    const outgoing: Headers[] = [];
    const exportFetch = vi.fn(async (_u: any, init: any) => { exported.push(JSON.parse(init.body)); return new Response(null); });
    const app = new Hono();
    app.use("*", tracing({ service: "svc", endpoint: "https://otlp/v1/traces", fetch: exportFetch as any }));
    app.get("/x", async (c) => {
      await span("work", async () => "r", { c });
      await tracedFetch("https://up/stream?q=1", {}, { c, fetch: (async (_i: any, init: any) => { outgoing.push(new Headers(init.headers)); return new Response("u"); }) as any });
      return c.text("ok");
    });
    const waits: Promise<unknown>[] = [];
    const res = await app.request("/x", { headers: { traceparent: tp } }, {}, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any);
    await Promise.all(waits);
    const sent = parseTraceparent(outgoing[0].get("traceparent"))!;
    expect(sent.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(sent.spanId).not.toBe("b7ad6b7169203331");
    expect(parseTraceparent(res.headers.get("traceparent"))!.traceId).toBe(sent.traceId);
    const spans = exported[0].resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s: any) => s.name).sort()).toEqual(["GET /x", "fetch GET", "work"]);
    const root = spans.find((s: any) => s.name === "GET /x");
    expect(root.parentSpanId).toBe("b7ad6b7169203331");
    expect(spans.find((s: any) => s.name === "work").parentSpanId).toBe(root.spanId);
    expect(spans.find((s: any) => s.name === "fetch GET").spanId).toBe(sent.spanId);
    expect(JSON.stringify(spans)).not.toContain("q=1"); // query string stripped from url.full
  });
  it("unsampled inbound: propagates, exports nothing; no endpoint: nothing exported", async () => {
    const f = vi.fn(async () => new Response(null));
    const app = new Hono();
    app.use("*", tracing({ service: "s", endpoint: "https://otlp", fetch: f as any }));
    app.get("/", (c) => c.text("ok"));
    const res = await app.request("/", { headers: { traceparent: tp.replace(/-01$/, "-00") } });
    expect(res.headers.get("traceparent")).toMatch(/-00$/);
    expect(f).not.toHaveBeenCalled();
    expect(otlpBody("s", []).resourceSpans[0].resource.attributes[0].key).toBe("service.name");
  });
});

describe("metrics", () => {
  it("metric(): data point layout; missing binding / NaN / throwing dataset are no-ops", () => {
    const pts: any[] = [];
    metric({ writeDataPoint: (p) => void pts.push(p) }, "signup", 1, { route: "/p", plan: "pro" });
    expect(pts[0]).toEqual({ blobs: ["signup", "/p", "pro"], doubles: [1], indexes: ["signup"] });
    metric(undefined, "x", 1); metric({ writeDataPoint: (p) => void pts.push(p) }, "x", NaN);
    expect(() => metric({ writeDataPoint() { throw new Error("no"); } }, "x", 1)).not.toThrow();
    expect(pts).toHaveLength(1);
  });
  it("/_m beacon: accepts vitals same-origin, rejects unknown names, cross-site, oversize, junk", async () => {
    const pts: any[] = [];
    const app = new Hono<{ Bindings: any }>();
    app.post("/_m", metricsHandler());
    const post = (body: string, h: Record<string, string> = {}) => app.request("http://a.test/_m", { method: "POST", body, headers: h }, { METRICS: { writeDataPoint: (p: any) => pts.push(p) } });
    expect((await post(JSON.stringify({ name: "lcp", value: 1200, route: "/" }), { "sec-fetch-site": "same-origin" })).status).toBe(204);
    expect(pts[0]).toMatchObject({ blobs: ["lcp", "/", ""], doubles: [1200] });
    expect((await post(JSON.stringify({ name: "evil", value: 1 }))).status).toBe(400);
    expect((await post(JSON.stringify({ name: "lcp", value: -1 }))).status).toBe(400);
    expect((await post(JSON.stringify({ name: "lcp", value: 1 }), { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(JSON.stringify({ name: "lcp", value: 1 }), { origin: "https://evil.test" })).status).toBe(403);
    expect((await post("x".repeat(2000))).status).toBe(413);
    expect((await post("not json")).status).toBe(400);
    expect(pts).toHaveLength(1);
    expect(vitalsBeacon()).toContain('"/_m"');
    expect(vitalsBeacon().length).toBeLessThan(1200);
  });
});

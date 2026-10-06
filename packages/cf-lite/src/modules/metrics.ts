/**
 * Custom metrics + Web Vitals on **Analytics Engine** (`cf-lite/modules/metrics`). docs/observability.md.
 *
 *   wrangler:  "analytics_engine_datasets": [{ "binding": "METRICS", "dataset": "myapp" }]
 *   metric(env.METRICS, "signup", 1, { route: "/pricing" });
 *
 * Data point layout (stable, query it with SQL API): blobs = [name, route, ...extra labels], doubles = [value], index = name.
 * The vitals beacon (`metricsHandler` on `POST /_m`, wired by the `metrics()` convention; `vitalsBeacon()` = the ~500 B client script)
 * accepts only known metric names with a finite numeric value, caps the body and labels, and answers 204.
 */
import type { Handler } from "hono";

export interface MetricsDataset { writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }

/** Write one data point. Never throws (a metrics failure must not fail a request); `ds` undefined (binding missing) is a no-op. */
export function metric(ds: MetricsDataset | undefined, name: string, value: number, labels: { route?: string; [k: string]: string | undefined } = {}): void {
  if (!ds || !Number.isFinite(value)) return;
  try {
    const { route = "", ...rest } = labels;
    ds.writeDataPoint({ blobs: [name, route, ...Object.values(rest).map((v) => v ?? "")], doubles: [value], indexes: [name.slice(0, 96)] });
  } catch { /* ignore */ }
}

export const VITALS = ["lcp", "cls", "inp", "fcp", "ttfb"] as const;

export interface MetricsHandlerOptions {
  /** Env binding name of the Analytics Engine dataset. Default "METRICS". */
  binding?: string;
  /** Accepted metric names. Default: the Core Web Vitals + fcp/ttfb. */
  names?: readonly string[];
  /** Max body bytes. Default 1024. */
  maxBytes?: number;
}

/** `POST /_m` with `{ name, value, route }` (JSON, `sendBeacon` text/plain also fine). Same-origin only. */
export function metricsHandler(o: MetricsHandlerOptions = {}): Handler {
  const names = new Set(o.names ?? VITALS);
  const max = o.maxBytes ?? 1024;
  return async (c) => {
    if (c.req.method !== "POST") return c.body(null, 405);
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin") return c.body(null, 403);
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) return c.body(null, 403);
    const text = await c.req.text();
    if (text.length > max) return c.body(null, 413);
    let b: { name?: unknown; value?: unknown; route?: unknown };
    try { b = JSON.parse(text); } catch { return c.body(null, 400); }
    if (typeof b.name !== "string" || !names.has(b.name) || typeof b.value !== "number" || !Number.isFinite(b.value) || b.value < 0 || b.value > 1e7) return c.body(null, 400);
    const route = typeof b.route === "string" ? b.route.slice(0, 120) : "";
    metric((c.env as Record<string, MetricsDataset | undefined>)[o.binding ?? "METRICS"], b.name, b.value, { route, country: (c.req.raw as { cf?: { country?: string } }).cf?.country });
    return c.body(null, 204);
  };
}

/** Client script (inline it in `head.script` or import in app code): reports LCP/CLS/INP/FCP/TTFB once, on page hide, via `sendBeacon`. */
export function vitalsBeacon(endpoint = "/_m"): string {
  return `(()=>{var v={},e=${JSON.stringify(endpoint)},r=location.pathname,o=(t,f)=>{try{new PerformanceObserver(l=>f(l.getEntries())).observe({type:t,buffered:true})}catch(_){}};` +
    `o("largest-contentful-paint",l=>{v.lcp=l[l.length-1].startTime});` +
    `o("layout-shift",l=>{for(var x of l)if(!x.hadRecentInput)v.cls=(v.cls||0)+x.value});` +
    `o("paint",l=>{for(var x of l)if(x.name==="first-contentful-paint")v.fcp=x.startTime});` +
    `o("event",l=>{for(var x of l)if(x.interactionId)v.inp=Math.max(v.inp||0,x.duration)});` +
    `var n=performance.getEntriesByType("navigation")[0];if(n)v.ttfb=n.responseStart;` +
    `var s=0,f=()=>{if(s)return;s=1;for(var k in v)navigator.sendBeacon(e,JSON.stringify({name:k,value:v[k],route:r}))};` +
    `addEventListener("visibilitychange",()=>{document.visibilityState==="hidden"&&f()});addEventListener("pagehide",f)})();`;
}

# Observability

All modules are opt-in imports: an app that imports none of them ships none of the bytes.

## Logs: `cf-lite/modules/log`

Structured JSON lines, indexed per field by Workers Logs. The scaffold's `wrangler.jsonc` enables `observability: { enabled: true, head_sampling_rate: 1 }`; lower the rate on busy apps.

```ts
import { log, logging, configureLog } from "cf-lite/modules/log";
root.use(logging());                 // request id, c.var.log, x-request-id header, one access line
log.info("order placed", { orderId });
c.var.log.warn("slow", { ms });      // child logger already carries requestId
configureLog({ level: "info", redact: [/ssn/i] });
```

- Fixed keys (`level`, `msg`, `time`) always win over caller fields.
- Redaction: keys matching `DEFAULT_REDACT` (password, secret, token, authorization, cookie, api key, session, ...) are replaced with `[redacted]`, recursively, cycle-safe. Add patterns via `redact`.
- Request id: `cf-ray`, falling back to a random id (`requestId(c)` from `modules/request-id`).

## Error reporting: `server/error.ts`

```ts
// server/error.ts
import { sentry, fetchSink } from "cf-lite/modules/error";
export default { reporters: [sentry({ dsn: (env) => env.SENTRY_DSN }), fetchSink({ url: "https://logs.example.com/e" })] };
```

If the file exists, the generated app gets `.onError(errorHandler(opts))`: it logs a structured error with a digest (= request id), sends the report to each reporter through `waitUntil`, and returns a generic 500 with the digest (no stack unless `dev: true`). `HTTPException`s below 500 are not reported. The SSR `_error.tsx` boundary receives the same `digest`; render errors that `ssr()` recovers from are reported too. No file = nothing emitted, nothing imported. `sentry()` is a minimal envelope sender (no `toucan-js` dependency).

## Custom metrics + Web Vitals: `metrics()` convention

```ts
// cf-lite.config / vite config
import { metrics } from "cf-lite/conventions";
cfLite({ conventions: [metrics({ binding: "METRICS" })] });
```

Mounts `POST /_m` (same-origin, 1 KiB cap, allow-listed names: lcp, cls, inp, fcp, ttfb) and adds only that path to `run_worker_first`. Add an `analytics_engine_datasets` binding named `METRICS` in wrangler (the build warns if missing). Server side: `metric(c.env.METRICS, "checkout", 1, { route })`. Client: inline `vitalsBeacon("/_m")` (tiny, opt-in script string).

## Tracing: `cf-lite/modules/otel`

Platform automatic tracing is the baseline (beta, verify in the dashboard). Optional OTLP/HTTP exporter:

```ts
root.use(tracing({ service: "my-app", endpoint: (env) => env.OTLP_URL, headers: (env) => ({ authorization: env.OTLP_AUTH }) }));
await span("load-user", () => db.get(id), { c });
const res = await tracedFetch(url, {}, { c });   // injects W3C traceparent
```

Inbound `traceparent` is honoured (sampling decision included); no `endpoint` = propagate only. Spans are exported through `waitUntil`.

## Needs the owner / not done here

Logpush and Tail Workers are paid-plan features: documented only. Sentry/OTLP accounts and DSNs are the app owner's.

/**
 * `after(fn)`: run work after the response has been sent, bound to the current request's ExecutionContext (`waitUntil`), with
 * error capture. The Next.js `after()` shape; Cloudflare-native underneath.
 *
 *   import { after } from "cf-lite/modules/after";
 *   app.post("/x", async (c) => { after(() => audit.log(...)); return c.json({ ok: true }); });
 *
 * Works anywhere in a request (Hono handler, loader, action) with no context threading: uses `waitUntil` from `cloudflare:workers`.
 * Inside a queue/cron/workflow handler there is no request - just await the work. Limits (docs/background-jobs.md): the work
 * must finish within the post-response budget (Workers: 30 s of wall time after the response *(verify)*) and is not retried.
 */
import { waitUntil } from "cloudflare:workers";

let onError: (error: unknown) => void = (e) => console.error("[cf-lite] after() task failed:", e);
/** Replace the default `console.error` capture (e.g. forward to your error reporter). */
export function setAfterErrorHandler(fn: (error: unknown) => void): void { onError = fn; }

export type AfterTask = (() => unknown | Promise<unknown>) | Promise<unknown>;

export function after(task: AfterTask, ctx?: { waitUntil(p: Promise<unknown>): void }): void {
  const p = Promise.resolve()
    .then(() => (typeof task === "function" ? task() : task))
    .catch((e) => { try { onError(e); } catch { /* the reporter must not crash the request */ } });
  (ctx ? ctx.waitUntil.bind(ctx) : waitUntil)(p);
}

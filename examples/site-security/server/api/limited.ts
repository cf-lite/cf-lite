import { Hono } from "hono";
import { rateLimit, doLimiter } from "cf-lite/modules/ratelimit";

export default new Hono<{ Bindings: Env }>()
  // approximate (in this example: memory fallback, 3 per 60 s per IP)
  .get("/soft", rateLimit({ limit: 3, period: 60 }), (c) => c.json({ ok: true }))
  // exact + global: Durable Object, 2 per 60 s per key
  .get("/exact", rateLimit({ limiter: (c) => doLimiter((c.env as Env).LIMITER_DO, { limit: 2, period: 60 }), key: (c) => c.req.query("who") }), (c) => c.json({ ok: true }));

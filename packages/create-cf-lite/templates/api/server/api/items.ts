import { Hono } from "hono";
import { rateLimit } from "cf-lite/modules/ratelimit";

const items = new Map<string, { id: string; name: string }>();

/** Typed in the client with `hc<ApiType>` from `.cf-lite/app`. Per-IP limit 30/min (memory limiter; add a `ratelimits` binding for exact limits). */
export default new Hono<{ Bindings: Env }>()
  .use("*", rateLimit({ limit: 30, period: 60 }))
  .get("/", (c) => c.json({ items: [...items.values()] }))
  .post("/", async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({ name: undefined }));
    if (typeof body.name !== "string" || !body.name || body.name.length > 100) return c.json({ error: "name required (max 100 chars)" }, 400);
    const item = { id: crypto.randomUUID(), name: body.name };
    items.set(item.id, item);
    return c.json(item, 201);
  });

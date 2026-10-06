import { Hono } from "hono";
// test seam: POST /api/content/<key> body=<text> sets published text; the page loaders read it (drafts read `draft:<key>` first)
export default new Hono<{ Bindings: Env }>().post("/:key", async (c) => { await c.env.CONTENT.put(c.req.param("key"), await c.req.text()); return c.json({ ok: true }); });

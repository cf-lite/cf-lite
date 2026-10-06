import { Hono } from "hono";

// WebSocket upgrade -> Durable Object. Plain Hono route, nothing wrapped.
export default new Hono<{ Bindings: Env }>().get("/:name", (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected websocket", 426);
  return c.env.ROOM.get(c.env.ROOM.idFromName(c.req.param("name"))).fetch(c.req.raw);
});

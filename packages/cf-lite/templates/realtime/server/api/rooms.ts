import { Hono } from "hono";
import { durableObjects } from "../../.cf-lite/do";

// GET /api/rooms/:room (WebSocket upgrade) -> that room's Durable Object.
export default new Hono<{ Bindings: Env }>().get("/:room", (c) => {
  if (c.req.header("upgrade") !== "websocket") return c.text("expected a WebSocket upgrade", 426);
  return durableObjects.chat.fetch(c.req.param("room"), c.req.raw);
});

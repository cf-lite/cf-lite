import { Hono } from "hono";
import { getSession } from "cf-lite/modules/session";
// Writes session state on every call (fresh session each time: seals an AES-GCM cookie) - the cost of a stateful route.
export default new Hono<{ Bindings: Env }>().get("/", async (c) => {
  const s = getSession(c);
  s.set("n", Number(s.get("n") ?? 0) + 1);
  return c.json({ n: s.get("n") });
});

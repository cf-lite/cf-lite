import { Hono } from "hono";
import { revalidateTag } from "cf-lite/modules/isr";

// The "edit content" action: write to KV, then invalidate the pages carrying the tag (-> queue -> regeneration).
export default new Hono<{ Bindings: Env }>().post("/edit/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.CONTENT.put(`post:${id}`, await c.req.text());
  return c.json(await revalidateTag(c.env, `post:${id}`));
});

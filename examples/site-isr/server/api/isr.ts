import { Hono } from "hono";
import { isr, isrOrigin, isrRevalidate, revalidateTag } from "cf-lite/modules/isr";

// A "page" rendered from content in KV. `isr()` stores the HTML in R2; edits call revalidateTag -> queue -> regenerate.
let failNext = false; // demo switch: make the next render throw, to show the last good copy keeps being served
export default new Hono<{ Bindings: Env }>()
  .use(isrOrigin())
  .get(
    "/page/:id",
    isr({ maxAge: 300, swr: 3600, tags: (c) => ["posts", `post:${c.req.param("id")}`] }),
    async (c) => {
      if (failNext) { failNext = false; throw new Error("render failed"); }
      const id = c.req.param("id");
      const title = (await c.env.CONTENT.get(`post:${id}`)) ?? "untitled";
      return c.html(`<!doctype html><title>${title}</title><h1 id="t">${title}</h1><p>rendered at ${Date.now()}</p>`);
    },
  )
  // the "edit content" action: write content, then invalidate
  .post("/edit/:id", async (c) => {
    const id = c.req.param("id");
    await c.env.CONTENT.put(`post:${id}`, await c.req.text());
    return c.json(await revalidateTag(c.env, `post:${id}`));
  })
  .post("/fail-next", (c) => { failNext = true; return c.json({ ok: true }); })
  .post("/revalidate", isrRevalidate());

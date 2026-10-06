import { Hono } from "hono";
import { after } from "cf-lite/modules/after";
import { queues } from "../../.cf-lite/queues";
import { workflows } from "../../.cf-lite/workflows";

export default new Hono<{ Bindings: Env }>()
  .post("/enqueue", async (c) => {
    const { id, fail } = await c.req.json<{ id: string; fail?: boolean }>();
    await queues.jobs.send({ id, fail });
    // @ts-expect-error typed producer: `id` must be a string (this line is a compile test, see `npm run typecheck`)
    const _bad: Parameters<typeof queues.jobs.send>[0] = { id: 1 };
    void _bad;
    return c.json({ queued: id });
  })
  .post("/workflow", async (c) => {
    const { userId } = await c.req.json<{ userId: string }>();
    const inst = await workflows.onboarding.create({ id: `wf-${userId}`, params: { userId } });
    return c.json({ id: inst.id });
  })
  .post("/after", (c) => {
    after(async () => { await new Promise((r) => setTimeout(r, 300)); await c.env.STATE.put("after:done", "1"); });
    return c.json({ accepted: true });
  })
  .get("/state", async (c) => {
    const list = await c.env.STATE.list();
    const out: Record<string, string | null> = {};
    for (const k of list.keys) out[k.name] = await c.env.STATE.get(k.name);
    return c.json(out);
  });

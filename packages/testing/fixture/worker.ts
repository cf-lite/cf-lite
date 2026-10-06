// A gated app in the shape of a real cf-lite service: session cookie gate, D1, queue producer, workflow producer, cron.
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { e2eLogin } from "cf-lite/modules/e2e-login";

type Bindings = { DB: D1Database; KV: KVNamespace; JOBS?: Queue; FLOW?: Workflow; E2E_LOGIN_SECRET?: string };
const app = new Hono<{ Bindings: Bindings; Variables: { user: string } }>();

app.route("/__e2e", e2eLogin({ issue: (c, who) => { setCookie(c, "sid", who.user, { path: "/", httpOnly: true }); } }));

// the gate
app.use("/api/*", async (c, next) => {
  const user = getCookie(c, "sid");
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});
app.post("/api/notes", async (c) => {
  const { body } = await c.req.json<{ body: string }>();
  await c.env.DB.prepare("INSERT INTO notes (owner, body) VALUES (?, ?)").bind(c.get("user"), body).run();
  await c.env.JOBS?.send({ kind: "note", owner: c.get("user") });
  await c.env.FLOW?.create({ params: { owner: c.get("user") } });
  return c.json({ ok: true }, 201);
});
app.get("/api/notes", async (c) =>
  c.json((await c.env.DB.prepare("SELECT body FROM notes WHERE owner = ?").bind(c.get("user")).all()).results));

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Bindings) { await env.KV.put("last-cron", "ran"); },
  async queue(batch: MessageBatch<{ owner: string }>, env: Bindings) {
    for (const m of batch.messages) { await env.KV.put(`seen:${m.body.owner}`, "1"); m.ack(); }
  },
} satisfies ExportedHandler<Bindings>;

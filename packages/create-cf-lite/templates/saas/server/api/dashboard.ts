import { Hono } from "hono";
import { getSession, session } from "cf-lite/modules/session";
import { sessionOptions, type AuthEnv } from "../auth";

/** Protected example: 401 without a session. Queue a job with `await c.env.EMAILS_QUEUE?.send({ id })` (handler in server/queues/emails.ts). */
export default new Hono<{ Bindings: Env & AuthEnv }>()
  .use("*", session((c) => sessionOptions(c.env)))
  .get("/", (c) => {
    const s = getSession(c);
    if (!s.userId) return c.json({ error: "sign in" }, 401, { "cache-control": "private, no-store" });
    return c.json({ user: s.userId }, 200, { "cache-control": "private, no-store" });
  });

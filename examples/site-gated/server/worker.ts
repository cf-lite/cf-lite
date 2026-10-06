// Ordering: this file's own Hono `root` runs first; `app` (generated) then runs server/middleware.ts before /api and pages.
import { Hono } from "hono";
import app from "../.cf-lite/app";

const root = new Hono<{ Bindings: Env }>();
root.use(async (c, next) => {
  console.log("[worker]", c.req.path); // scripts/middleware-e2e.mjs reads this to prove which requests reach the Worker
  await next();
});
root.route("/", app);
root.notFound((c) => c.env.ASSETS.fetch(c.req.raw)); // gated static files: serve from assets once past the gate

export default root satisfies ExportedHandler<Env>;

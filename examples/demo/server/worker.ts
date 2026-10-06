// Plain Worker entry. cf-lite never wraps it: DOs, scheduled, queue, etc. are exported right here.
import app from "../.cf-lite/app";
export { Room } from "./room";

export default {
  // The worker entry is yours. This log line lets scripts/e2e.mjs prove which requests reach the Worker.
  fetch(req, env, ctx) {
    console.log("[worker]", new URL(req.url).pathname);
    return app.fetch(req, env, ctx);
  },
  async scheduled(event, env, ctx) {
    console.log("cron fired", event.cron, new Date(event.scheduledTime).toISOString());
  },
} satisfies ExportedHandler<Env>;

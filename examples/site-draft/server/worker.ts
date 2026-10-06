import app from "../.cf-lite/app";
import { handlers } from "../.cf-lite/handlers";

export default {
  fetch(req, env, ctx) {
    console.log("[worker]", new URL(req.url).pathname);
    return app.fetch(req, env, ctx);
  },
  ...handlers,
} satisfies ExportedHandler<Env>;

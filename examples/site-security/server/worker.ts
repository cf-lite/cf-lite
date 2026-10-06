import app from "../.cf-lite/app";

export { RateLimiterDO } from "cf-lite/modules/ratelimit";

export default {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

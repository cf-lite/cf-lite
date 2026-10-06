import app from "../.cf-lite/app";

export default {
  fetch(req, env, ctx) {
    console.log("[worker]", new URL(req.url).pathname); // lets scripts/i18n-e2e.mjs prove which requests reach the Worker
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

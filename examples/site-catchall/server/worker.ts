import app from "../.cf-lite/app";

export default {
  fetch(req, env, ctx) {
    console.log("[worker]", new URL(req.url).pathname);
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

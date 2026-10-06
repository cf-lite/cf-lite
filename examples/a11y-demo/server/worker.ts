import app from "../.cf-lite/app";

export default {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

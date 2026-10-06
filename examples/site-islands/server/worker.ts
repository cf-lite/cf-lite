import app from "../.cf-lite/app";

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;

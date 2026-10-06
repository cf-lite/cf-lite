import app from "../.cf-lite/app";

// Docs are 100% static assets; this Worker only exists because cf-lite needs an entry. It answers /api/* (none) only.
export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
} satisfies ExportedHandler<Env>;

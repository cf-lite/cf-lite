import app from "../.cf-lite/app";

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;

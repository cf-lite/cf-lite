import app from "../.cf-lite/app";

// Durable Object classes must be exported from the Worker entry.
export * from "../.cf-lite/do-classes";
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;

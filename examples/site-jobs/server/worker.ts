import app from "../.cf-lite/app";
import { handlers } from "../.cf-lite/handlers"; // { scheduled, queue, email } - generated only because server/{cron,queues,email} exist

// Workflow classes must be exported from the Worker entry.
export * from "../.cf-lite/workflow-classes";
export default { fetch: app.fetch, ...handlers } satisfies ExportedHandler<Env>;

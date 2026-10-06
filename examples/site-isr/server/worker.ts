import app from "../.cf-lite/app";
import { handlers } from "../.cf-lite/handlers"; // { scheduled, queue, email } - generated only because server/{cron,queues,email} exist

export default { fetch: app.fetch, ...handlers } satisfies ExportedHandler<Env>;

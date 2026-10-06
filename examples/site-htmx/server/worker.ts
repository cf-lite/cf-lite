// Plain Worker entry. cf-lite never wraps it: Durable Objects, scheduled(), queue() ... are exported right here.
import app from "../.cf-lite/app";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

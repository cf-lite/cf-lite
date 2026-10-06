import app from "../.cf-lite/app";
import { handlers } from "../.cf-lite/handlers"; // { queue } - the ISR consumer is generated because a page exports `isr`

export default { fetch: app.fetch, ...handlers } satisfies ExportedHandler<Env>;

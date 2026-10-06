import { Hono } from "hono";
import { genericAdapter, webhookReceiver } from "cf-lite/modules/webhook";

// POST /api/webhooks/cms - verify (HMAC + timestamp) -> dedupe -> enqueue -> 200. The purge happens in server/queues/cms-webhook.ts, off the request path.
export default new Hono<{ Bindings: Env }>().post("/cms", webhookReceiver({ adapter: genericAdapter() }));

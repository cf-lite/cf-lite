// Fixture Worker for test/webhook-workerd.test.ts: receiver + consumer + a cache page + an ISR page, all tracking content deps.
import { Hono } from "hono";
import { cacheRoute } from "../../src/modules/cache.js";
import { isr, isrConsumer } from "../../src/modules/isr.js";
import { dispatchQueue } from "../../src/modules/queue.js";
import { contentTags, genericAdapter, trackContent, webhookConsumer, webhookReceiver, type WebhookEnv } from "../../src/modules/webhook.js";

const app = new Hono<{ Bindings: WebhookEnv }>();
const nonce = () => crypto.randomUUID().slice(0, 8);
const track = (c: any) => { trackContent(c, "post", c.req.param("id")); trackContent(c, "author", "1"); };

// Cache API tier (per colo) invalidated through the shared KV ledger
const cachedPage = cacheRoute({ cache: ({ req }: { req: Request }) => ({ maxAge: 600, tags: contentTags(req) }) } as any, (c) => { track(c); return c.text(`cache post ${c.req.param("id")} nonce:${nonce()}`); });
app.get("/cache/:id", (c) => cachedPage(c));
// ISR tier (R2 shared by colos)
app.get("/isr/:id", isr({ maxAge: 600, swr: 600, tags: (c) => contentTags(c) }), (c) => { track(c); return c.text(`isr post ${c.req.param("id")} nonce:${nonce()}`); });
app.post("/hook", webhookReceiver({ adapter: genericAdapter() }));

export default {
  fetch: (req: Request, env: unknown, ctx: ExecutionContext) => app.fetch(req, env as WebhookEnv, ctx),
  queue: (batch: MessageBatch<any>, env: unknown, ctx: ExecutionContext) =>
    dispatchQueue({ "cms-webhook": webhookConsumer(), isr: isrConsumer({ render: (r, e, x) => app.fetch(r, e, x), origin: "http://colo-a.test" }) }, batch, env, ctx),
};

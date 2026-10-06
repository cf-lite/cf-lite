/**
 * `cf-lite add webhook [--provider generic|optimizely]`: scaffold the CMS publish webhook (docs/webhooks.md):
 * `server/api/webhooks.ts` (receiver, mounted at `POST /api/webhooks/cms`) + `server/queues/cms-webhook.ts` (consumer, picked up by the queues
 * convention) + the wrangler queue producer/consumer. Idempotent, never overwrites a file. Secrets/KV are left to the human (printed).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { editWrangler } from "./add-jobs.js";

export const WEBHOOK_PROVIDERS = ["generic", "optimizely"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export function receiverTemplate(provider: WebhookProvider): string {
  return provider === "optimizely"
    ? `import { Hono } from "hono";\nimport { webhookReceiver } from "cf-lite/modules/webhook";\nimport { optimizelyAdapter, optimizelyVerify } from "cf-lite/modules/webhook-optimizely";\n\n// STUB adapter: shape from public Optimizely Graph docs, not tested against a live tenant (docs/webhooks.md).\n// Register the webhook in Graph with an \`x-api-key\` header equal to CMS_WEBHOOK_SECRET.\nexport default new Hono<{ Bindings: Env }>().post("/cms", webhookReceiver({ adapter: optimizelyAdapter({ type: "page" }), verify: optimizelyVerify }));\n`
    : `import { Hono } from "hono";\nimport { genericAdapter, webhookReceiver } from "cf-lite/modules/webhook";\n\n// POST /api/webhooks/cms  -  header \`x-cms-signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>\`, optional \`x-cms-delivery\`.\n// Body: { "events": [{ "action": "publish", "type": "post", "id": "42" }] }\nexport default new Hono<{ Bindings: Env }>().post("/cms", webhookReceiver({ adapter: genericAdapter() }));\n`;
}
export const consumerTemplate = (): string =>
  `import { webhookConsumer, type WebhookMessage } from "cf-lite/modules/webhook";\n\nexport const queue = "cms-webhook";\nexport const binding = "WEBHOOK_QUEUE"; // the receiver enqueues through env.WEBHOOK_QUEUE\nexport type Message = WebhookMessage;\n\n// Optional: resolve: (ev) => ({ paths: ev.id ? [\`/blog/\${ev.id}\`] : [] }) to add slug-derived paths on top of the content tags.\nexport default webhookConsumer();\n`;

export function addWebhook(dir: string, log: (m: string) => void = () => {}, opts: { provider?: string } = {}): { changed: string[] } {
  const provider = (opts.provider ?? "generic") as WebhookProvider;
  if (!WEBHOOK_PROVIDERS.includes(provider)) throw new Error(`cf-lite add webhook: --provider must be one of ${WEBHOOK_PROVIDERS.join(", ")} (got "${opts.provider}")`);
  const changed: string[] = [];
  const put = (rel: string, body: string) => {
    const f = join(dir, rel);
    if (existsSync(f)) { log(`  keep   ${rel} (exists)`); return; }
    mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); changed.push(rel); log(`  create ${rel}`);
  };
  put("server/api/webhooks.ts", receiverTemplate(provider));
  put("server/queues/cms-webhook.ts", consumerTemplate());
  const wr = ["wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!wr) log("  no wrangler.jsonc found - add the queue producer WEBHOOK_QUEUE + consumer by hand (docs/webhooks.md)");
  else {
    const src = readFileSync(wr, "utf8"), r = editWrangler(src, "queue", "cms-webhook", { binding: "WEBHOOK_QUEUE" });
    if (r.text !== src) { writeFileSync(wr, r.text); changed.push(wr.slice(dir.length + 1)); log(`  edit   ${wr.slice(dir.length + 1)}`); }
    if (r.manual) log(`  add to ${wr.slice(dir.length + 1)} by hand: ${r.manual}`);
  }
  log("  then: wrangler secret put CMS_WEBHOOK_SECRET   (comma-separated list while rotating)");
  log("  and bind a KV namespace as WEBHOOK_KV (or CF_CACHE_TAGS) for duplicate-delivery protection, plus CF_CACHE_TAGS/CF_CACHE_DB (+ ISR_BUCKET) for the purge");
  return { changed };
}

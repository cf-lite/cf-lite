interface Env {
  ASSETS: Fetcher;
  ISR_BUCKET: R2Bucket;
  ISR_QUEUE: Queue;
  /** Mock CMS storage + webhook idempotency keys. */
  CONTENT: KVNamespace;
  /** cf-lite/modules/webhook: receiver -> queue (producer binding); the consumer is server/queues/cms-webhook.ts. */
  WEBHOOK_QUEUE: Queue;
  /** Webhook idempotency (delivery ids). */
  WEBHOOK_KV: KVNamespace;
  /** Real CMS GraphQL endpoint. Unset = the in-process mock (cms/mock.ts). */
  CMS_URL?: string;
  /** Bearer for CMS reads of draft content and for the mock's admin mutations. */
  CMS_TOKEN: string;
  /** HMAC key shared with the CMS for webhook signatures (cms/seams.ts). */
  CMS_WEBHOOK_SECRET: string;
  /** cf-lite/modules/draft: seals the preview cookie, gates /api/draft/enable (>= 32 chars). */
  DRAFT_SECRET: string;
  ISR_REVALIDATE_TOKEN?: string;
}

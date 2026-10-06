interface Env {
  ASSETS: Fetcher;
  ISR_BUCKET: R2Bucket;
  ISR_QUEUE: Queue;
  CONTENT: KVNamespace;
  ISR_REVALIDATE_TOKEN?: string;
}

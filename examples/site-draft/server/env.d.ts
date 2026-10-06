interface Env {
  ASSETS: Fetcher;
  ISR_BUCKET: R2Bucket;
  CONTENT: KVNamespace;
  DRAFT_SECRET?: string;
}

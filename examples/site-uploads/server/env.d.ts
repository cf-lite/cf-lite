interface Env {
  DB: D1Database;
  KV: KVNamespace;
  BUCKET: R2Bucket;
  /** Upload cap in bytes (default 5 MiB). */
  MAX_UPLOAD_BYTES?: string;
  /** Optional R2 API-token secrets; only needed for presigned URLs. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

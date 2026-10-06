interface Env {
  ROOM: DurableObjectNamespace<import("./room").Room>;
  CF_CACHE_TAGS: KVNamespace;
  CF_CACHE_DB: D1Database;
  CF_CACHE_STORE?: string;
  CACHE_PURGE_TOKEN?: string;
}

/**
 * OPTIONAL module: a typed, JSON-first view of one KV namespace.
 *
 * KV is eventually consistent: a write is visible in the writing location immediately but can take ~60 s to show up
 * elsewhere (and `cacheTtl` reads add their own staleness). Use it for config, feature flags, cached renders and
 * other read-mostly data. Use D1 for anything relational or needing read-your-writes, Durable Objects for counters,
 * locks and coordination.
 */
export interface KvOptions {
  /** Key prefix (namespacing several logical stores in one namespace). */
  prefix?: string;
  /** Default `expirationTtl` in seconds for `put` (KV minimum is 60). Omit for no expiry. */
  ttl?: number;
  /** Edge cache TTL for reads in seconds (KV minimum is 30). Trades freshness for latency. */
  cacheTtl?: number;
}
export interface KvPutOptions<M = unknown> { ttl?: number; expiresAt?: number; metadata?: M }
export interface KvListPage<M = unknown> { keys: { key: string; expiration?: number; metadata?: M }[]; cursor?: string; done: boolean }

const MIN_TTL = 60;

export function kv<T = unknown, M = unknown>(ns: KVNamespace, opts: KvOptions = {}) {
  const p = opts.prefix ?? "";
  const k = (key: string) => p + key;
  const strip = (key: string) => (p && key.startsWith(p) ? key.slice(p.length) : key);
  const readOpts = opts.cacheTtl ? { type: "json" as const, cacheTtl: Math.max(30, opts.cacheTtl) } : ("json" as const);

  const api = {
    get: (key: string): Promise<T | null> => ns.get<T>(k(key), readOpts as never),
    /** Value plus the metadata stored with it (one read). */
    getWithMetadata: async (key: string): Promise<{ value: T | null; metadata: M | null }> => {
      const r = await ns.getWithMetadata<T, M>(k(key), readOpts as never);
      return { value: r.value, metadata: r.metadata };
    },
    /** `ttl`/`expiresAt` below KV's 60 s floor are clamped up rather than failing at runtime. */
    put: (key: string, value: T, o: KvPutOptions<M> = {}) => {
      const ttl = o.ttl ?? opts.ttl;
      const init: KVNamespacePutOptions = {};
      if (o.expiresAt !== undefined) init.expiration = Math.max(Math.floor(Date.now() / 1000) + MIN_TTL, Math.floor(o.expiresAt));
      else if (ttl !== undefined) init.expirationTtl = Math.max(MIN_TTL, Math.floor(ttl));
      if (o.metadata !== undefined) init.metadata = o.metadata;
      return ns.put(k(key), JSON.stringify(value), init);
    },
    delete: (key: string) => ns.delete(k(key)),
    /** One page; pass `cursor` from the previous page. `limit` is capped at KV's 1000. */
    list: async (o: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<KvListPage<M>> => {
      const r = await ns.list<M>({ prefix: p + (o.prefix ?? ""), limit: Math.min(1000, o.limit ?? 1000), cursor: o.cursor });
      return { keys: r.keys.map((x) => ({ ...x, key: strip(x.name) } as never)), cursor: r.list_complete ? undefined : r.cursor, done: r.list_complete };
    },
    /** Async iterator over every key (follows cursors). */
    async *keys(o: { prefix?: string; pageSize?: number } = {}): AsyncGenerator<string> {
      let cursor: string | undefined;
      for (;;) {
        const page = await api.list({ prefix: o.prefix, limit: o.pageSize, cursor });
        for (const x of page.keys) yield x.key;
        if (page.done) return;
        cursor = page.cursor;
      }
    },
    /** Delete every key under `prefix` (paged; returns the count). */
    async clear(prefix = ""): Promise<number> {
      let n = 0;
      for await (const key of api.keys({ prefix })) { await api.delete(key); n++; }
      return n;
    },
  };
  return api;
}

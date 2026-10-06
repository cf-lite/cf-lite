/** OPTIONAL module: read-through JSON cache on KV. `ttl` in seconds (KV minimum is 60). */
export async function cached<T>(kv: KVNamespace, key: string, ttl: number, compute: () => Promise<T>): Promise<T> {
  const hit = await kv.get<T>(key, "json");
  if (hit !== null) return hit;
  const value = await compute();
  await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) });
  return value;
}

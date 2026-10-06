// SSR page cached at the edge: fresh 2s, then served stale for up to 4s while it re-renders in the background.
// `cache` can also be a function of { params, data } (see cached-fn) and `cacheKey` tunes the cache key.
export const render = "ssr";

export const cache = { maxAge: 2, swr: 4, tags: ["cached"] };

// a fresh nonce per render makes HIT / STALE / MISS observable from the outside (scripts/cache-e2e.mjs, bench/cache.mjs)
export async function loader(c: { req: { param: (k: string) => string } }) {
  return { id: c.req.param("id"), nonce: Math.random().toString(36).slice(2, 10), rows: Array.from({ length: 400 }, (_, i) => i) };
}

export default function Cached({ params, data }: { params: { id: string }; data: { nonce: string; rows: number[] } }) {
  return (
    <main>
      <h1>Cached {params.id}</h1>
      <p data-testid="nonce">nonce:{data.nonce}</p>
      <ul>{data.rows.map((r) => <li key={r}>row {r} of {params.id}</li>)}</ul>
    </main>
  );
}

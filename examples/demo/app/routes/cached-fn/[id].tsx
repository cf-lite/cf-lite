// Function form: decided after the loader runs, so it can use the data. Unknown posts are not cached.
export const render = "ssr";

export const cache = ({ params, data }: { params: Record<string, string>; data: unknown }) =>
  (data as { found: boolean }).found ? { maxAge: 60, swr: 600, tags: ["posts", `post:${params.id}`] } : false;

export async function loader(c: { req: { param: (k: string) => string } }) {
  const id = c.req.param("id");
  if (id.startsWith("slow")) await new Promise((r) => setTimeout(r, 50)); // stands in for a D1/fetch call (bench/cache.mjs)
  return { id, found: id !== "missing" && !id.includes("nocache"), nonce: Math.random().toString(36).slice(2, 10), rows: Array.from({ length: 400 }, (_, i) => i) };
}

export default function CachedFn({ data }: { data: { id: string; found: boolean; nonce: string; rows: number[] } }) {
  return (
    <main>
      <h1>{data.found ? `Post ${data.id}` : "Not found"}</h1>
      <p data-testid="nonce">nonce:{data.nonce}</p>
      <ul>{data.rows.map((r) => <li key={r}>row {r} of {data.id}</li>)}</ul>
    </main>
  );
}

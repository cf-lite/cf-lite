import type { Context } from "hono";

export const render = "ssr";
// Durable static: rendered once, stored in R2, served from any colo, regenerated in the background (docs/isr.md).
export const isr = { maxAge: 300, swr: 3600, tags: (c: Context) => ["posts", `post:${c.req.param("id")}`] };

export async function loader(c: Context<{ Bindings: Env }>) {
  const id = c.req.param("id")!;
  return { id, title: (await c.env.CONTENT.get(`post:${id}`)) ?? "untitled", at: Date.now() };
}

export default function Post({ data }: { data: { id: string; title: string; at: number } }) {
  return <main><h1 id="t">{data.title}</h1><p>rendered at {data.at}</p></main>;
}

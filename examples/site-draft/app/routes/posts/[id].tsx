import type { Context } from "hono";
import { isDraft } from "cf-lite/modules/draft";

export const render = "ssr";
export const isr = { maxAge: 300, swr: 3600 };

export async function loader(c: Context<{ Bindings: Env }>) {
  const id = c.req.param("id")!;
  return { text: (isDraft(c) ? await c.env.CONTENT.get(`draft:post:${id}`) : null) ?? (await c.env.CONTENT.get(`post:${id}`)) ?? "published-post" };
}
export default function Post({ data }: { data: { text: string } }) { return <main><h1 id="t">{data.text}</h1></main>; }

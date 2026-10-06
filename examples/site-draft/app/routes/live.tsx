import type { Context } from "hono";
import { isDraft } from "cf-lite/modules/draft";

export const render = "ssr";
export const cache = { maxAge: 300 };

export async function loader(c: Context<{ Bindings: Env }>) {
  return { text: (isDraft(c) ? await c.env.CONTENT.get("draft:live") : null) ?? (await c.env.CONTENT.get("live")) ?? "published-live" };
}
export default function Live({ data }: { data: { text: string } }) { return <main><h1 id="t">{data.text}</h1></main>; }

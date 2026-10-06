import type { Context } from "hono";
import { isDraft } from "cf-lite/modules/draft";

export const render = "static";

// static pages are rendered at build (published text) - and on demand at /__preview/about with the draft text
export async function loader(c?: Context<{ Bindings: Env }>) {
  if (!c?.env?.CONTENT) return { text: "published-about" };
  return { text: (isDraft(c) ? await c.env.CONTENT.get("draft:about") : null) ?? "published-about" };
}
export default function About({ data }: { data: { text: string } }) { return <main><h1 id="t">{data.text}</h1></main>; }

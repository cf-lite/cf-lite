// Control: the same page as rsc.tsx with render = "ssr" (loader pattern, no streaming of the slow part).
import { Counter } from "../islands/counter";
export const render = "ssr";
export const hydrate = true;
export async function loader(c: { req: { url: string } }) {
  const ms = Number(new URL(c.req.url).searchParams.get("ms") ?? 150);
  await new Promise((r) => setTimeout(r, ms));
  return { items: ["alpha", "beta", "gamma"], slow: `slow data after ${ms}ms` };
}
export default function Page({ data }: { data: { items: string[]; slow: string } }) {
  return <main><h1 id="mode">rendered by: ssr</h1><ul id="fast">{data.items.map((i) => <li key={i}>{i}</li>)}</ul><Counter label="clicks" /><p id="slow">{data.slow}</p></main>;
}

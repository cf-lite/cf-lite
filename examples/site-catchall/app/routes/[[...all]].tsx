import type { Context } from "hono";
export const render = "ssr";
// loader reads the splat through c.req.param("*") (regression: it was empty for optional catch-alls)
export const loader = (c: Context) => ({ splat: c.req.param("*") ?? "<none>" });
export default function CatchAll({ data }: { data: { splat: string } }) { return <main><h1 id="t">catch-all</h1><p id="splat">splat=[{data.splat}]</p></main>; }

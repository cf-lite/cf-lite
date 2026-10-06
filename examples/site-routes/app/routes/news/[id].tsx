// static + paths() + dynamicParams = true: id 1 is prerendered, any other id is rendered by the Worker on demand.
export const render = "static";
export const dynamicParams = true;
export async function paths() { return [{ id: "1" }]; }
export async function loader(c: { req: { param: (k: string) => string } }) { return { id: c.req.param("id"), at: Date.now() }; }
export default function News({ data }: { data: { id: string } }) { return <main><h1 data-testid="news">News {data.id}</h1></main>; }

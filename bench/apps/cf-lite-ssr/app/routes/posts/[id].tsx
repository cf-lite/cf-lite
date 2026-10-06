export const render = "ssr";
export async function loader(c: { req: { param: (k: string) => string } }) { return { id: c.req.param("id") }; }
export const head = ({ params }: { params: Record<string, string> }) => ({ title: `Post ${params.id}`, meta: [{ property: "og:title", content: params.id }] });
export default function Post({ params, data }: { params: { id: string }; data: { id: string } }) {
  return (<main><h1>Post {params.id}</h1><ul>{Array.from({ length: 20 }, (_, i) => <li key={i}>{data.id}-{i}</li>)}</ul></main>);
}

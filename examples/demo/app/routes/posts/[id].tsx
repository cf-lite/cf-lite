// Streamed in the Worker on each request (only this path + /api/* ever run the Worker).
export const render = "ssr";

export async function loader(c: { req: { param: (k: string) => string } }) {
  return { id: c.req.param("id"), renderedAt: new Date().toISOString() };
}
// head can be a function of { params, data } (data = the loader result) — rendered into the streamed HTML.
import type { Head } from "cf-lite/head";
export const head = ({ params, data }: { params: Record<string, string>; data: unknown }): Head => ({
  title: `Post ${params.id} — cf-lite`,
  meta: [{ property: "og:title", content: `Post ${params.id}` }, { name: "description", content: `rendered ${(data as { renderedAt: string }).renderedAt}` }],
  link: [{ rel: "canonical", href: `https://demo.example.com/posts/${params.id}` }],
});

export default function Post({ params, data }: { params: { id: string }; data: { renderedAt: string } }) {
  return (
    <main>
      <h1 data-testid="post-id">Post {params.id}</h1>
      <p data-testid="rendered-at">Rendered at {data.renderedAt}</p>
      <a href="/">home</a>
    </main>
  );
}

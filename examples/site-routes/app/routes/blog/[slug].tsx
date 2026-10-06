import type { PageProps } from "cf-lite/href";
// static + paths(): one prerendered file per entry; unlisted slugs are 404 (dynamicParams defaults to false).
export const render = "static";
export async function paths() { return [{ slug: "alpha" }, { slug: "beta" }]; }
export async function loader(c: { req: { param: (k: string) => string } }) { return { title: c.req.param("slug").toUpperCase(), builtAt: "build" }; }
export const head = ({ data }: { params: Record<string, string>; data: unknown }) => ({ title: `Blog ${(data as { title: string }).title}` });
export default function Post({ params, data }: PageProps<"/blog/:slug">) {
  return <main><h1 data-testid="post">Post {params.slug} / {data.title}</h1></main>;
}

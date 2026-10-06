import { seo } from "cf-lite/modules/seo";
import { find } from "../../../../server/posts";

export const render = "ssr";
export const head = ({ params }: { params: Record<string, string> }) => {
  const p = find(params.slug);
  return seo({ title: p?.title ?? "Not found", description: p?.body ?? "", path: `/posts/${params.slug}`, openGraph: { type: "article", publishedTime: p?.updated }, jsonLd: { "@type": "BlogPosting", headline: p?.title, datePublished: p?.updated } });
};

export default function Post({ params }: { params: Record<string, string> }) {
  const p = find(params.slug);
  return <article><h1>{p?.title ?? "Not found"}</h1><p>{p?.body}</p></article>;
}

import { seo } from "cf-lite/modules/seo";
import { posts } from "../../../../server/posts";

export const render = "ssr";
const find = (slug: string) => posts.find((p) => p.slug === slug);
export const head = ({ params }: { params: Record<string, string> }) => {
  const p = find(params.slug);
  return seo({
    title: p?.title ?? "Not found", description: `Post: ${p?.title}`, path: `/posts/${params.slug}`, image: `/posts/${params.slug}/opengraph-image.png`,
    openGraph: { type: "article", publishedTime: p?.updated }, jsonLd: { "@type": "BlogPosting", headline: p?.title, datePublished: p?.updated },
  });
};

export default function Post({ params }: { params: Record<string, string> }) {
  return <article><h1>{find(params.slug)?.title}</h1></article>;
}

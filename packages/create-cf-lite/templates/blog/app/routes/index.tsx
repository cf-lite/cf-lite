import { seo } from "cf-lite/modules/seo";
import { posts } from "../../server/posts";

export const render = "ssr";
export const head = seo({ title: "My blog", description: "Posts from the edge", path: "/", jsonLd: { "@type": "WebSite", name: "My blog" } });

export default function Home() {
  return <main><h1>Blog</h1><ul>{posts.map((p) => <li key={p.slug}><a href={`/posts/${p.slug}`}>{p.title}</a></li>)}</ul></main>;
}

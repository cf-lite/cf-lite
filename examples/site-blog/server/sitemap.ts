import type { SitemapEntry } from "cf-lite/modules/sitemap";
import { posts } from "./posts";

// Dynamic sitemap (would be a D1 query in a real app). Served from the Worker with edge cache + Last-Modified.
export default (): SitemapEntry[] => [{ url: "/" }, ...posts.map((p) => ({ url: `/posts/${p.slug}`, lastmod: p.updated }))];

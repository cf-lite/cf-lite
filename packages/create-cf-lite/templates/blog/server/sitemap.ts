import type { SitemapEntry } from "cf-lite/modules/sitemap";
import { posts } from "./posts";

// Served from the Worker with edge cache + Last-Modified; swap `posts` for a D1 query when posts live in a database.
export default (): SitemapEntry[] => [{ url: "/" }, ...posts.map((p) => ({ url: `/posts/${p.slug}`, lastmod: p.updated }))];

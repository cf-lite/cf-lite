// Replace with a D1 query or MDX imports. Kept as data so the template has no runtime dependency.
export const posts = [
  { slug: "hello", title: "Hello, edge", body: "First post.", updated: "2026-09-01" },
  { slug: "second", title: "A second post", body: "More words.", updated: "2026-09-10" },
];
export const find = (slug: string) => posts.find((p) => p.slug === slug);

<script lang="ts">
export const render = "ssr";
export const hydrate = true;
export async function loader(c: { req: { param: (k: string) => string } }) {
  return { slug: c.req.param("slug"), at: new Date().toISOString() };
}
export const head = ({ params }: { params: Record<string, string> }) => ({ title: `${params.slug} — site blog`, link: [{ rel: "canonical", href: `https://example.com/blog/${params.slug}` }] });
</script>
<script setup lang="ts">
defineProps<{ params: { slug: string }; data: { at: string } }>();
</script>

<template><main><h1 data-testid="h">Blog {{ params.slug }}</h1><p data-testid="at">{{ data.at }}</p></main></template>

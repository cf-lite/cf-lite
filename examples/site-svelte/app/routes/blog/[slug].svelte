<script module>
  export const render = "ssr";
  export const hydrate = true;
  export async function loader(c) {
    return { slug: c.req.param("slug"), at: new Date().toISOString() };
  }
  export const head = ({ params }) => ({ title: `${params.slug} — site blog`, link: [{ rel: "canonical", href: `https://example.com/blog/${params.slug}` }] });
</script>

<script>
  let { params, data } = $props();
</script>

<main><h1 data-testid="h">Blog {params.slug}</h1><p data-testid="at">{data.at}</p></main>

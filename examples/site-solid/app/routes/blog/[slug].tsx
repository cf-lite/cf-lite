export const render = "ssr";
export const hydrate = true;
export async function loader(c: { req: { param: (k: string) => string } }) {
  return { slug: c.req.param("slug"), at: new Date().toISOString() };
}
export const head = ({ params }: { params: Record<string, string> }) => ({ title: `${params.slug} — site blog`, link: [{ rel: "canonical", href: `https://example.com/blog/${params.slug}` }] });

export default function Post(props: { params: { slug: string }; data: { at: string } }) {
  return <main><h1 data-testid="h">Blog {props.params.slug}</h1><p data-testid="at">{props.data.at}</p></main>;
}

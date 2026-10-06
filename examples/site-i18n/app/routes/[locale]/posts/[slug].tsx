import { i18n, load, translator } from "../../../i18n";

export const render = "ssr";
export const loader = async (c: { req: { param(k: string): string } }) => ({ messages: await load(c.req.param("locale")) });

export default function Post({ params, data }: { params: Record<string, string>; data: { messages: never } }) {
  const { t } = translator(data.messages, params.locale);
  return <article><h1>{t("post.title", { slug: params.slug })}</h1><p data-locales={i18n.locales.join(",")}>SSR</p></article>;
}

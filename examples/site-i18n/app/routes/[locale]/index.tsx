import { localeParams } from "cf-lite/modules/i18n";
import { i18n, load, translator } from "../../i18n";

export const render = "static";
export const paths = () => localeParams(i18n);
export const loader = async (c: { req: { param(k: string): string } }) => ({ messages: await load(c.req.param("locale")) });
export const head = ({ params, data }: { params: Record<string, string>; data: { messages: never } }) => ({ title: translator(data.messages, params.locale).t("home.title") });

export default function Home({ params, data }: { params: Record<string, string>; data: { messages: never } }) {
  const { t } = translator(data.messages, params.locale);
  return <main><h1>{t("home.title")}</h1><p>{t("home.greeting", { name: "cf-lite" })}</p><p data-testid="plural">{t("home.items", { count: 3 })}</p><a href={`/${params.locale}/about/`}>{t("nav.about")}</a></main>;
}

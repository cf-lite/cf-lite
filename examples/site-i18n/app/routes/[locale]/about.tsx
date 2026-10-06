import { localeParams } from "cf-lite/modules/i18n";
import { i18n, load, translator } from "../../i18n";

export const render = "static";
export const paths = () => localeParams(i18n);
export const loader = async (c: { req: { param(k: string): string } }) => ({ messages: await load(c.req.param("locale")) });

export default function About({ params, data }: { params: Record<string, string>; data: { messages: never } }) {
  const { t } = translator(data.messages, params.locale);
  // `about.note` is missing in vi.json: the default locale's text is the fallback.
  return <main><h1>{t("about.title")}</h1><p data-testid="note">{t("about.note")}</p></main>;
}

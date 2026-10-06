import type { ReactNode } from "react";
import { i18nHead } from "cf-lite/modules/i18n";
import { i18n } from "../../i18n";

// <html lang> + hreflang alternates for every page below (derived from params.locale and the request path).
export const head = i18nHead(i18n);

export default function Root({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="l-root">
      <nav>{i18n.locales.map((l) => <a key={l} href={`/${l}/`} data-locale={l}>{l}</a>)}</nav>
      {children}
    </div>
  );
}

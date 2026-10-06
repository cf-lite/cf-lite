import type { ReactNode } from "react";
import { Link } from "@cf-lite/react/client";
import { LangProvider, useLang } from "../lang";

export const head = { title: "cf-lite accessibility demo", meta: [{ name: "description", content: "Synthetic page for screen reader testing" }, { name: "robots", content: "noindex" }] };

function Shell({ children }: { children?: ReactNode }) {
  const { lang, setLang, t } = useLang();
  return (
    <>
      <a href="#main" className="skip">{t.skip}</a>
      <header>
        <p><strong>{t.site}</strong></p>
        <nav aria-label={t.navLabel}>
          <Link to="/">{t.home}</Link> · <Link to="/form">{t.form}</Link> · <Link to="/live">{t.live}</Link>
        </nav>
        <div role="group" aria-label={t.langLabel}>
          <button type="button" lang="en" aria-pressed={lang === "en"} onClick={() => setLang("en")}>English</button>{" "}
          <button type="button" lang="vi" aria-pressed={lang === "vi"} onClick={() => setLang("vi")}>Tiếng Việt</button>
        </div>
      </header>
      {children}
      <footer><p>{t.footer}</p></footer>
    </>
  );
}

export default function Root({ children }: { children?: ReactNode }) {
  return <LangProvider><Shell>{children}</Shell></LangProvider>;
}

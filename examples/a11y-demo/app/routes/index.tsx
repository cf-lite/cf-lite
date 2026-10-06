import { Link } from "@cf-lite/react/client";
import { useLang } from "../lang";

export const head = { title: "Home - cf-lite accessibility demo" };

export default function Home() {
  const { t } = useLang();
  return (
    <main id="main">
      <h1>{t.homeTitle}</h1>
      <p>{t.homeIntro}</p>
      <section aria-labelledby="s1"><h2 id="s1">{t.section1}</h2>
        <ul><li>Landmarks: banner, navigation, main, contentinfo</li><li>Headings: one level 1, then level 2</li><li>Links: Home, Form, Live list</li></ul>
      </section>
      <section aria-labelledby="s2"><h2 id="s2">{t.section2}</h2>
        <p><Link to="/form">{t.form}</Link> / <Link to="/live">{t.live}</Link></p>
      </section>
    </main>
  );
}

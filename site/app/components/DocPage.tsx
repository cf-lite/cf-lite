import { Shell, pages } from "./Shell";

// Public origin of the docs site (no trailing slash), set at build time with VITE_DOCS_URL; without it no canonical link is emitted.
const DOCS_URL: string = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DOCS_URL ?? "").replace(/\/$/, "");

export interface Doc { slug: string; title: string; desc: string; html: string; toc: { level: number; id: string; text: string }[] }

export function DocPage({ doc }: { doc: Doc }) {
  const i = pages.findIndex((p) => p.slug === doc.slug);
  const prev = pages[i - 1], next = pages[i + 1];
  return (
    <Shell current={doc.slug} toc={doc.toc.length > 2}>
      <main id="main" class="doc">
        <h1>{doc.title}</h1>
        <p class="lede">{doc.desc}</p>
        <div dangerouslySetInnerHTML={{ __html: doc.html }} />
        <div class="pager">
          {prev ? <a href={`/docs/${prev.slug}/`} rel="prev"><small>Previous</small>{prev.title}</a> : <span />}
          {next ? <a href={`/docs/${next.slug}/`} rel="next"><small>Next</small>{next.title}</a> : <span />}
        </div>
      </main>
      {doc.toc.length > 2 && (
        <nav class="toc" aria-label="On this page">
          <h2>On this page</h2>
          <ul>{doc.toc.map((t) => <li class={"l" + t.level}><a href={"#" + t.id}>{t.text}</a></li>)}</ul>
        </nav>
      )}
    </Shell>
  );
}

const site = "cf-lite docs";
type A = Record<string, string>;
export const docHead = (doc: Doc): { title: string; meta: A[]; link: A[] } => ({
  title: `${doc.title} · ${site}`,
  meta: [
    { name: "description", content: doc.desc },
    { property: "og:type", content: "article" },
    { property: "og:site_name", content: site },
    { property: "og:title", content: `${doc.title} · ${site}` },
    { property: "og:description", content: doc.desc },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: `${doc.title} · ${site}` },
    { name: "twitter:description", content: doc.desc },
  ],
  link: DOCS_URL ? [{ rel: "canonical", href: `${DOCS_URL}/docs/${doc.slug}/` }] : [],
});

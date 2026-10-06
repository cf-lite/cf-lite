import type { Db, Entry } from "./types";

const v = (title: string, rest: object = {}) => ({ n: 1, at: "2026-10-01T00:00:00Z", fields: { title, ...rest } });

/** Fixture content: 2 locales x (home, about page, 2 articles) + 1 shared banner block (referenced from every home page). */
export function seed(): Db {
  const entries: Entry[] = [
    { id: "block-banner", type: "block", locale: "en", published: v("Banner", { block: { __typename: "Banner", text: "Welcome to the cf-lite CMS demo" } }), draft: null },
    { id: "block-banner-vi", type: "block", locale: "vi", published: v("Banner", { block: { __typename: "Banner", text: "Chào mừng đến với bản demo CMS cf-lite" } }), draft: null },
  ];
  for (const [locale, ref, home, about, a1, a2] of [
    ["en", "block-banner", ["Home", "Headless, edge-rendered"], ["About", "About us"], ["First post", "Hello"], ["Second post", "More"]],
    ["vi", "block-banner-vi", ["Trang chủ", "Headless, render tại edge"], ["Giới thiệu", "Về chúng tôi"], ["Bài đầu tiên", "Xin chào"], ["Bài thứ hai", "Thêm"]],
  ] as const) {
    entries.push(
      { id: `page-home-${locale}`, type: "page", locale, path: "/", draft: null, published: v(home[0], { blocks: [
        { __typename: "BlockRef", ref }, { __typename: "Hero", heading: home[0], sub: home[1] },
        { __typename: "Columns", left: [{ __typename: "RichText", html: "<p>left column</p>" }], right: [{ __typename: "Cta", label: about[0], href: `/${locale}/about` }] },
        { __typename: "ArticleList", heading: locale === "en" ? "Latest" : "Mới nhất", limit: 5 },
      ] }) },
      { id: `page-about-${locale}`, type: "page", locale, path: "/about", draft: null, published: v(about[0], { blocks: [{ __typename: "Hero", heading: about[0], sub: about[1] }, { __typename: "RichText", html: `<p>${about[1]}</p>` }] }) },
      { id: `article-1-${locale}`, type: "article", locale, path: "/blog/first", draft: null, published: v(a1[0], { excerpt: a1[1], body: `<p>${a1[1]} (1)</p>`, blocks: [{ __typename: "Cta", label: "Home", href: `/${locale}` }] }) },
      { id: `article-2-${locale}`, type: "article", locale, path: "/blog/second", draft: null, published: v(a2[0], { excerpt: a2[1], body: `<p>${a2[1]} (2)</p>`, blocks: [] }) },
    );
  }
  return { entries, seq: 0, deliveries: [] };
}

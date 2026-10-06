import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Blocks, needsArticles, registry, views, type BlockCtx } from "../app/blocks/registry";
import type { Block, PageDoc } from "../cms/types";

const ctx: BlockCtx = { locale: "en", articles: [{ id: "a", path: "/blog/a", title: "A <b>", excerpt: "e" }] };
const html = (blocks: Block[], c = ctx) => renderToStaticMarkup(<Blocks blocks={blocks} ctx={c} />);

describe("block registry", () => {
  it("has a component for every block type except the CMS-resolved BlockRef", () => {
    expect(Object.keys(registry).sort()).toEqual(["ArticleList", "Banner", "Columns", "Cta", "Hero", "RichText"]);
  });
  it("renders each type, escaping text and composing Columns recursively", () => {
    const out = html([
      { __typename: "Hero", heading: "H<1>", sub: "s" }, { __typename: "Cta", label: "go", href: "/en/x" }, { __typename: "Banner", text: "b" },
      { __typename: "Columns", left: [{ __typename: "RichText", html: "<p>L</p>" }], right: [{ __typename: "Columns", left: [{ __typename: "Cta", label: "deep", href: "/d" }], right: [] }] },
      { __typename: "ArticleList", heading: "Latest" },
    ]);
    expect(out).toContain("H&lt;1&gt;"); expect(out).toContain('href="/en/x"'); expect(out).toContain("<p>L</p>");
    expect(out).toContain(">deep</a>"); expect(out).toContain('href="/en/blog/a"'); expect(out).toContain("A &lt;b&gt;");
  });
  it("an unknown/unresolved block renders a hidden marker, not a crash", () => {
    expect(html([{ __typename: "BlockRef", ref: "x" }, { __typename: "Nope" } as never])).toContain('data-unknown-block="Nope"');
  });
  it("a custom registry overrides components", () => {
    const out = renderToStaticMarkup(<Blocks blocks={[{ __typename: "Banner", text: "t" }]} ctx={ctx} registry={{ ...registry, Banner: ({ block }) => <i>{block.text.toUpperCase()}</i> }} />);
    expect(out).toBe("<i>T</i>");
  });
  it("needsArticles takes the max limit, including inside Columns", () => {
    expect(needsArticles([{ __typename: "Hero", heading: "x" }])).toBe(0);
    expect(needsArticles([{ __typename: "ArticleList", heading: "a" }])).toBe(5);
    expect(needsArticles([{ __typename: "ArticleList", heading: "a", limit: 2 }, { __typename: "Columns", left: [{ __typename: "ArticleList", heading: "b", limit: 9 }], right: [] }])).toBe(9);
  });
  it("document type -> view", () => {
    const page: PageDoc = { __typename: "Page", id: "p", path: "/", locale: "en", version: 1, title: "T", blocks: [{ __typename: "Banner", text: "x" }] };
    expect(renderToStaticMarkup(<views.Page doc={page} ctx={ctx} />)).toContain('data-view="Page"');
    const art = renderToStaticMarkup(<views.Article doc={{ ...page, __typename: "Article", excerpt: "", body: "<p>b</p>" }} ctx={ctx} />);
    expect(art).toContain('data-view="Article"'); expect(art).toContain("<p>b</p>");
  });
});

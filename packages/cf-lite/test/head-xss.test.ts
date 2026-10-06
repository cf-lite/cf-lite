import { describe, expect, it } from "vitest";
import { escapeHtml, headFor, injectHead, mergeHead, scriptTags } from "../src/head.js";

const shell = '<!doctype html><html lang="en" class="a"><head><meta charset="utf-8"><title>Base</title><meta name="description" content="default"><link rel="canonical" href="/old"></head><body></body></html>';

describe("head injection is XSS-safe (values come from loaders / CMS data)", () => {
  it("escapeHtml covers & < > \"", () => expect(escapeHtml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;"));
  it("title, meta content and link href cannot break out of their context", () => {
    const evil = `"><script>alert(1)</script>`;
    const html = injectHead(shell, { title: evil, meta: [{ name: "description", content: evil }], link: [{ rel: "canonical", href: evil }] });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it("attribute NAMES are sanitised (no space/quote/> injection through a key)", () => {
    const html = injectHead(shell, { meta: [{ 'name" onload="x': "v" } as any], htmlAttrs: { 'x" onclick="evil': "1" } });
    expect(html).not.toMatch(/\sonload="x/);
    expect(html).not.toMatch(/\sonclick="evil/);
  });
  it("`$&` / `$1` sequences in data are inserted literally (String.replace pitfalls)", () => {
    const html = injectHead(shell, { title: "Price $& $1 $`", link: [{ rel: "stylesheet", href: "/a$&.css" }], script: [{ content: "var a='$&'" }] });
    expect(html).toContain("Price $&amp; $1 $`");
    expect(html).toContain('href="/a$&amp;.css"');
    expect(html).toContain("var a='$&'");
  });
  it("inline script content cannot close the element; src is escaped; nonce applied to inline + idle loader", () => {
    const out = scriptTags([{ content: "x</script><script>alert(1)" }, { src: '/a"b.js', strategy: "async" }, { src: "/i.js", strategy: "idle", attrs: { "data-x": "</script>" } }], 'n"1');
    expect(out).toContain("x<\\/script><script>alert(1)");
    expect(out.match(/<\/script>/g)).toHaveLength(3); // inline + async + idle loader: the injected `</script>` was neutralised, so no extra element ends early
    expect(out).toContain('src="/a&quot;b.js"');
    expect(out).toContain(' async');
    expect(out).toContain('nonce="n&quot;1"');
    expect(out).not.toContain("</script>\"}]"); // idle loader JSON escapes `<`
    expect(out).toContain("\\u003c/script>");
  });
  it("script strategies: defer (non-module), module without defer, blocking, typed inline", () => {
    const out = scriptTags([{ src: "/a.js" }, { src: "/m.js", type: "module" }, { src: "/b.js", strategy: "blocking" }, { content: "{}", type: "application/ld+json" }]);
    expect(out).toContain('<script src="/a.js" defer>');
    expect(out).toContain('<script src="/m.js" type="module">');
    expect(out).toContain('<script src="/b.js">');
    expect(out).toContain('<script type="application/ld+json">{}</script>');
  });
  it("htmlAttrs replace existing attributes (quoted / unquoted) and add new ones", () => {
    const html = injectHead('<html lang=en data-x=\'1\'><head></head>', { htmlAttrs: { lang: "vi", "data-x": "2", dir: "ltr" } });
    expect(html).toBe('<html lang="vi" data-x="2" dir="ltr"><head></head>'.replace('lang="vi" data-x="2"', 'lang="vi" data-x="2"'));
  });
  it("injectHead replaces the shell's unmanaged meta/canonical rather than duplicating", () => {
    const html = injectHead(shell, { meta: [{ name: "description", content: "new" }], link: [{ rel: "canonical", href: "/new" }] });
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('content="new"');
  });
  it("mergeHead: keys for charset/property/http-equiv/itemprop, scripts dedupe by src/inline, htmlAttrs merge", () => {
    const m = mergeHead([
      { meta: [{ charset: "utf-8" }, { property: "og:a", content: "1" }, { "http-equiv": "x", content: "1" }, { itemprop: "i", content: "1" }], script: [{ src: "/a.js" }, { content: "x" }], htmlAttrs: { a: "1" } },
      undefined,
      { meta: [{ charset: "latin1" }, { property: "og:a", content: "2" }, { content: "k" }], script: [{ src: "/a.js", strategy: "async" }, { content: "x" }], htmlAttrs: { b: "2" } },
    ]);
    expect(m.meta!.find((x) => x.charset)!.charset).toBe("latin1");
    expect(m.meta!.filter((x) => x.property === "og:a")).toEqual([{ property: "og:a", content: "2" }]);
    expect(m.script).toHaveLength(2);
    expect(m.script![0]).toEqual({ src: "/a.js", strategy: "async" });
    expect(m.htmlAttrs).toEqual({ a: "1", b: "2" });
  });
  it("headFor: function heads get ctx; legacy title export", () => {
    expect(headFor([{ title: "L" }, { head: (c) => ({ title: c.params.id }) }], { params: { id: "7" }, data: undefined })).toEqual({ title: "7" });
    expect(headFor([{ title: "Only" }], { params: {}, data: undefined }).title).toBe("Only");
  });
});

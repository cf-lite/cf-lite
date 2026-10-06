import { describe, expect, it } from "vitest";
import { headFor, injectHead, mergeHead, resolveHead } from "../src/head.js";

describe("head merge", () => {
  it("title: innermost defined wins; legacy `title` export works", () => {
    expect(mergeHead([{ title: "a" }, {}, { title: "c" }]).title).toBe("c");
    expect(mergeHead([{ title: "a" }, {}]).title).toBe("a");
    expect(resolveHead({ title: "legacy" }, { params: {}, data: null }).title).toBe("legacy");
    expect(resolveHead({ title: "legacy", head: { title: "new" } }, { params: {}, data: null }).title).toBe("new");
  });
  it("meta dedupes by name/property, link by rel+href (canonical singular)", () => {
    const h = mergeHead([
      { meta: [{ name: "description", content: "outer" }, { property: "og:title", content: "o" }], link: [{ rel: "canonical", href: "/a" }, { rel: "stylesheet", href: "/x.css" }] },
      { meta: [{ name: "description", content: "inner" }], link: [{ rel: "canonical", href: "/b" }, { rel: "stylesheet", href: "/y.css" }] },
    ]);
    expect(h.meta).toEqual([{ property: "og:title", content: "o" }, { name: "description", content: "inner" }]);
    expect(h.link).toEqual([{ rel: "stylesheet", href: "/x.css" }, { rel: "canonical", href: "/b" }, { rel: "stylesheet", href: "/y.css" }]);
  });
  it("head functions receive params + loader data; layouts come first", () => {
    const h = headFor(
      [{ head: { title: "layout", meta: [{ name: "a", content: "1" }] } }, { head: ({ params, data }) => ({ title: `${params.id}:${(data as any).x}` }) }],
      { params: { id: "7" }, data: { x: 1 } },
    );
    expect(h).toEqual({ title: "7:1", meta: [{ name: "a", content: "1" }] });
  });
});

describe("injectHead", () => {
  const shell = `<html><head><title>Base</title><meta name="description" content="default"><link rel="canonical" href="/old"></head><body></body></html>`;
  it("replaces title (remembering base), replaces conflicting defaults, escapes attributes", () => {
    const out = injectHead(shell, { title: 'A & "B"', meta: [{ name: "description", content: 'x"y<' }], link: [{ rel: "canonical", href: "/new" }] });
    expect(out).toContain(`<title data-cf-base="Base">A &amp; &quot;B&quot;</title>`);
    expect(out).toContain(`<meta name="description" content="x&quot;y&lt;" data-cf-head>`);
    expect(out).not.toContain('content="default"');
    expect(out).not.toContain('href="/old"');
    expect(out).toContain(`<link rel="canonical" href="/new" data-cf-head></head>`);
  });
  it("no head -> shell unchanged", () => expect(injectHead(shell, {})).toBe(shell));
});

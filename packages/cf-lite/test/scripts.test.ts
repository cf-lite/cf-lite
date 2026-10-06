import { describe, expect, it } from "vitest";
import { injectHead, mergeHead, scriptTags } from "../src/head.js";

const shell = "<html><head><title>x</title></head><body></body></html>";

describe("head script strategies", () => {
  it("defer is the default for src; async/blocking; module scripts need no defer", () => {
    expect(scriptTags([{ src: "/a.js" }, { src: "/b.js", strategy: "async" }, { src: "/c.js", strategy: "blocking" }, { src: "/d.js", type: "module" }])).toBe(
      '<script src="/a.js" defer></script><script src="/b.js" async></script><script src="/c.js"></script><script src="/d.js" type="module"></script>',
    );
  });
  it("idle scripts load through one inline requestIdleCallback loader (setTimeout fallback)", () => {
    const out = scriptTags([{ src: "/i1.js", strategy: "idle" }, { src: "/i2.js", strategy: "idle", attrs: { "data-x": "1" } }]);
    expect(out.match(/<script/g)).toHaveLength(1);
    expect(out).toContain("requestIdleCallback");
    expect(out).toContain("setTimeout");
    expect(out).toContain('"src":"/i1.js"');
    expect(out).not.toContain(' src="/i1.js"'); // not fetched by the parser
  });
  it("nonce is applied to every emitted script including the idle loader; inline content cannot close the tag", () => {
    const out = injectHead(shell, { script: [{ src: "/a.js" }, { src: "/i.js", strategy: "idle" }, { content: "a='</script><b>'" }] }, { nonce: "N0nce" });
    expect(out.match(/<script/g)).toHaveLength(3);
    expect(out.match(/nonce="N0nce"/g)).toHaveLength(3);
    expect(out).not.toContain("</script><b>");
  });
  it("no nonce attr without a nonce; attrs are escaped", () => {
    const out = scriptTags([{ src: "/a.js", attrs: { "data-k": 'v"<' } }]);
    expect(out).not.toContain("nonce");
    expect(out).toContain('data-k="v&quot;&lt;"');
  });
  it("merge dedupes by src (inner wins) and inline by content", () => {
    const h = mergeHead([{ script: [{ src: "/a.js", strategy: "defer" }, { content: "x" }] }, { script: [{ src: "/a.js", strategy: "idle" }, { content: "x" }] }]);
    expect(h.script).toEqual([{ src: "/a.js", strategy: "idle" }, { content: "x" }]);
  });
  it("heads without scripts are unchanged", () => {
    expect(injectHead(shell, { title: "t" })).toBe(injectHead(shell, { title: "t", script: [] }));
  });
});

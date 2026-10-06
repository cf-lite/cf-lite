import { describe, expect, it } from "vitest";
import { GqlError, execute, parse, project } from "../cms/graphql";
import { ARTICLES_QUERY, ROUTE_QUERY } from "../cms/client";

describe("graphql subset", () => {
  it("parses the head's own documents", () => {
    const d = parse(ROUTE_QUERY);
    expect(d.kind).toBe("query"); expect(d.name).toBe("Route"); expect(d.vars).toEqual(["path", "locale", "preview"]);
    expect(d.sel[0].name).toBe("route"); expect(Object.keys(d.sel[0].args)).toEqual(["path", "locale", "preview"]);
    expect(parse(ARTICLES_QUERY).sel[0].name).toBe("articles");
  });
  it("parses literals, enums, comments, anonymous shorthand and mutations", () => {
    const d = parse('# c\n{ a(x: 1, y: -2.5, s: "q\\"z", b: true, n: null, e: en) { id } }');
    expect(d.sel[0].args).toEqual({ x: { v: 1 }, y: { v: -2.5 }, s: { v: 'q"z' }, b: { v: true }, n: { v: null }, e: { v: "en" } });
    expect(parse("mutation { publish(id: \"x\") { id } }").kind).toBe("mutation");
  });
  it.each(["{ a ", "{ a: b }", "{ ...F }", "query Q { a } extra", "{ a(x: ) }", "{ a } §", "{ a(x: $) }"])("rejects %s", (src) => {
    expect(() => parse(src)).toThrow(GqlError);
  });
  it("projects fields and applies inline fragments by __typename", () => {
    const v = { __typename: "Page", id: "1", secret: "no", blocks: [{ __typename: "Hero", heading: "h", x: 1 }, { __typename: "Cta", label: "l" }] };
    const sel = parse("{ r { __typename id blocks { __typename ... on Hero { heading } ... on Cta { label } } } }").sel[0].sel;
    expect(project(v as never, sel)).toEqual({ __typename: "Page", id: "1", blocks: [{ __typename: "Hero", heading: "h" }, { __typename: "Cta", label: "l" }] });
  });
  it("executes with variables; unknown fields and resolver GqlErrors become per-field errors", async () => {
    const doc = parse("query($n: Int) { ok(n: $n) { v } nope boom }");
    const out = await execute(doc, { ok: (a) => ({ v: a.n as number }), boom: () => { throw new GqlError("bad"); } }, { n: 4 });
    expect(out.data).toEqual({ ok: { v: 4 }, nope: null, boom: null });
    expect(out.errors?.map((e) => e.message)).toEqual(['Cannot query field "nope"', "bad"]);
  });
  it("lets non-GqlErrors escape", async () => {
    await expect(execute(parse("{ a }"), { a: () => { throw new TypeError("x"); } })).rejects.toThrow(TypeError);
  });
});

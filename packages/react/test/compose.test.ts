import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { compose } from "../src/compose.js";

it("wraps outermost first and passes params; Page null = 404", () => {
  const L = (name: string) => ({ children, params }: any) => createElement("div", { "data-l": name, "data-p": params.id }, children);
  const html = renderToString(compose({ Page: () => createElement("i", null, "page"), layouts: [L("root"), L("inner")], params: { id: "9" } }));
  expect(html).toBe(`<div data-l="root" data-p="9"><div data-l="inner" data-p="9"><i>page</i></div></div>`);
  expect(renderToString(compose({ Page: null, layouts: [], params: {} }))).toBe("<h1>404</h1>");
});

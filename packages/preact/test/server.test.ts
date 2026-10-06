import { expect, it } from "vitest";
import { h } from "preact";
import { render, renderToString } from "../src/server.js";

const L = (name: string) => ({ children, params }: any) => h("div", { "data-l": name, "data-p": params.id }, children);
const view = { Page: ({ data }: any) => h("i", null, `page ${data}`), layouts: [L("root"), L("inner")], params: { id: "9" }, data: "d" };

it("composes layouts around the page, string and web stream", async () => {
  const expected = `<div data-l="root" data-p="9"><div data-l="inner" data-p="9"><i>page d</i></div></div>`;
  expect((await renderToString(view)).body).toBe(expected);
  expect(await new Response((await render(view)).body as ReadableStream).text()).toBe(expected);
});

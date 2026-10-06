import { expect, it } from "vitest";
import { h, defineComponent } from "vue";
import { render, renderToString } from "../src/server.js";

const Layout = (name: string) => defineComponent({ props: ["params"], setup: (p, { slots }) => () => h("div", { "data-l": name, "data-p": p.params.id }, slots.default?.()) });
const view = { Page: defineComponent({ props: ["params", "data"], setup: (p) => () => h("i", `page ${p.data}`) }), layouts: [Layout("root"), Layout("inner")], params: { id: "9" }, data: "d" };

it("composes layouts around the page (default slot), string and web stream", async () => {
  const expected = `<div data-l="root" data-p="9"><div data-l="inner" data-p="9"><i>page d</i></div></div>`;
  expect((await renderToString(view)).body).toBe(expected);
  const { body } = await render(view);
  expect(await new Response(body as ReadableStream).text()).toBe(expected);
});

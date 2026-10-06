import { expect, it } from "vitest";
import { createComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { render, renderToString } from "../src/server.js";

const el = (tag: string, attrs: Record<string, unknown>, children?: () => unknown) => createComponent(Dynamic as never, { component: tag, ...attrs, get children() { return children?.(); } } as never);
const L = (name: string) => (p: any) => el("div", { "data-l": name, "data-p": p.params.id }, () => p.children);
const view = { Page: (p: any) => el("i", {}, () => `page ${p.data}`), layouts: [L("root"), L("inner")], params: { id: "9" }, data: "d" };
const strip = (s: string) => s.replace(/ data-hk="[^"]*"/g, "").replace(/ >/g, ">");

it("composes layouts around the page (outermost first), string and web stream", async () => {
  const expected = `<div data-l="root" data-p="9"><div data-l="inner" data-p="9"><i>page d</i></div></div>`;
  expect(strip((await renderToString(view)).body)).toBe(expected);
  expect(strip(await new Response((await render(view)).body as ReadableStream).text())).toBe(expected);
});
it("emits the hydration bootstrap only when the page hydrates", async () => {
  expect((await renderToString(view)).head).toBeUndefined();
  expect((await render({ ...view, hydrate: true })).head).toContain("_$HY");
});
it("renders a 404 when there is no page", async () => {
  expect(strip((await renderToString({ ...view, Page: null, layouts: [] })).body)).toBe("<h1>404</h1>");
});

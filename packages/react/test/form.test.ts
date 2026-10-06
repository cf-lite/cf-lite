import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Form, useFormStatus } from "../src/form.js";

it("<Form> renders a real post form (works with JS off) and a caller cannot downgrade it to GET", () => {
  const html = renderToString(createElement(Form, { action: "?/save", method: "get" } as any, createElement("button", null, "Go")));
  expect(html).toContain('method="post"'); expect(html).not.toContain('method="get"');
  expect(html).toContain('action="?/save"'); expect(html).toContain('aria-busy="false"');
});
it("useFormStatus starts idle with no result (before any submission / on the server)", () => {
  const Probe = () => { const s = useFormStatus(); return createElement("i", null, `${s.pending}|${s.result}`); };
  expect(renderToString(createElement(Form, null, createElement(Probe)))).toContain("false|null");
  expect(renderToString(createElement(Probe))).toContain("false|null"); // outside a <Form>: default context
});

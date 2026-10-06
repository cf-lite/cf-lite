import { expect, it } from "vitest";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { Form, useFormStatus } from "../src/form.js";

it("<Form> renders a real post form (works with JS off) and a caller cannot downgrade it to GET", () => {
  const html = renderToString(h(Form as any, { action: "?/save", method: "get" }, h("button", null, "Go")));
  expect(html).toContain('method="post"'); expect(html).not.toContain('method="get"');
  expect(html).toContain('action="?/save"');
});
it("useFormStatus starts idle with no result", () => {
  const Probe = () => { const s = useFormStatus(); return h("i", null, `${s.pending}|${s.result}`); };
  expect(renderToString(h(Form as any, null, h(Probe, null)))).toContain("false|null");
  expect(renderToString(h(Probe, null))).toContain("false|null");
});

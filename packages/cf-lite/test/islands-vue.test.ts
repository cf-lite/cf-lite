// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h, ref } from "vue";
import { renderToString } from "vue/server-renderer";
import { island } from "../../vue/src/islands.js";
import { mount } from "../../vue/src/islands-client.js";
import vueAdapter from "../../vue/src/index.js";
import { wrapIsland, islandVueTransform, islandTransform, ISLAND_FILE, islandId } from "../src/vite-islands.js";

const Counter = defineComponent({
  props: { start: { type: Number, default: 0 }, label: { type: String, default: "count" } },
  setup(p) { const n = ref(p.start); return () => h("button", { onClick: () => n.value++ }, `${p.label}: ${n.value}`); },
});
const html = (Comp: unknown, props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(Comp as never, props) }));

describe("vue island()", () => {
  it("renders <cfl-island> around the component, props as JSON, strategy only when not load", async () => {
    const I = island(Counter, "app/islands/Counter", "load");
    expect(await html(I, { start: 2, label: "clicks" })).toBe('<cfl-island data-i="app/islands/Counter" data-p="{&quot;start&quot;:2,&quot;label&quot;:&quot;clicks&quot;}"><button>clicks: 2</button></cfl-island>');
    expect(await html(island(Counter, "x", "visible"), {})).toBe('<cfl-island data-i="x" data-w="visible"><button>count: 0</button></cfl-island>');
    expect((I as unknown as { inner: unknown }).inner).toBe(Counter);
  });
  it("hostile props stay inside the attribute", async () => {
    const out = await html(island(Counter, "x", "load"), { label: '"><img src=x onerror=1>' });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
  it("props must be plain JSON, slots cannot cross into the browser", async () => {
    const I = island(Counter, "app/islands/Counter", "load");
    await expect(html(I, { onClick: () => 1 })).rejects.toThrow(/prop props\.onClick is a function/);
    const withSlot = defineComponent({ render: () => h(I as never, null, { default: () => "child" }) });
    await expect(renderToString(createSSRApp(withSlot))).rejects.toThrow(/cannot take `children`/);
  });
  it("browser mount hydrates the server HTML in place (state works, no mismatch warning)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = await html(island(Counter, "c", "load"), { start: 4 });
    const el = document.querySelector("cfl-island")!;
    const before = el.querySelector("button")!;
    mount(el, Counter, JSON.parse((el as HTMLElement).dataset.p!));
    expect(el.querySelector("button")).toBe(before); // hydrated, not re-created
    before.click(); await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    expect(before.textContent).toBe("count: 5");
    expect(warn.mock.calls.filter((c) => /hydrat/i.test(String(c[0])))).toEqual([]);
    warn.mockRestore();
  });
});

describe("vue adapter + plugin wiring", () => {
  it("adapter declares islands", () => expect(vueAdapter().islands).toEqual({ wrap: "@cf-lite/vue/islands", mount: "@cf-lite/vue/islands-client" }));
  it("ISLAND_FILE matches .island.vue next to tsx/jsx", () => {
    for (const f of ["a.island.vue", "a.island.tsx", "a.island.jsx"]) expect(ISLAND_FILE.test(f)).toBe(true);
    expect(ISLAND_FILE.test("a.vue")).toBe(false); expect(islandId("/r", "/r/app/islands/A.island.vue")).toBe("app/islands/A");
  });
  const compiled = `import _sfc_main from "/r/app/i/A.island.vue?vue&type=script&setup=true&lang.ts";\nexport * from "/r/app/i/A.island.vue?vue&type=script&setup=true&lang.ts";\nexport default _sfc_main;\n`;
  it("wrapIsland wraps the compiled SFC default export and honours an explicit strategy", () => {
    const out = wrapIsland(compiled, "app/i/A.island.vue", "app/i/A", "@cf-lite/vue/islands", "idle");
    expect(out).toContain('import { island as __cflWrap } from "@cf-lite/vue/islands"');
    expect(out).toContain("const __cflInner = _sfc_main;");
    expect(out).toContain('export default __cflWrap(__cflInner, "app/i/A", "idle");');
  });
  it("islandVueTransform: main .island.vue modules only (post), strategy from the SFC source; the tsx plugin leaves .vue alone", () => {
    const ad = { islands: { wrap: "@cf-lite/vue/islands", mount: "m" } } as never;
    const p = islandVueTransform("/r", ad) as { enforce: string; transform(c: string, id: string): { code: string } | null };
    expect(p.enforce).toBe("post");
    expect(p.transform(compiled, "/r/app/i/A.island.vue?vue&type=template")).toBeNull();
    expect(p.transform(compiled, "/r/app/i/Plain.vue")).toBeNull();
    expect(p.transform(compiled, "/r/node_modules/x/A.island.vue")).toBeNull();
    expect(p.transform(compiled, "/elsewhere/A.island.vue")).toBeNull();
    const t = islandTransform("/r", ad) as unknown as { transform(c: string, id: string): unknown };
    expect(t.transform(compiled, "/r/app/i/A.island.vue")).toBeNull();
  });
});

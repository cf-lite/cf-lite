import { defineComponent, h, type Component } from "vue";
import { encodeProps } from "cf-lite/islands";

/**
 * Wraps the default export of an `*.island.vue` (done by the cf-lite Vite plugin after plugin-vue compiled it): server HTML inside `<cfl-island>`,
 * props (everything passed to the component, as attrs) as JSON in `data-p`. `.inner` is what the browser hydrates. Slots cannot cross into the browser.
 */
export function island(Inner: Component, id: string, when: string) {
  const Island = defineComponent({
    name: `Island(${(Inner as { name?: string; __name?: string }).name ?? (Inner as { __name?: string }).__name ?? id})`,
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h("cfl-island", { "data-i": id, "data-p": encodeProps(id, slots.default ? { ...attrs, children: "slot" } : { ...attrs }), "data-w": when === "load" ? undefined : when }, [h(Inner, attrs)]);
    },
  });
  return Object.assign(Island, { inner: Inner });
}

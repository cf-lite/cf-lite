import { createSSRApp, type Component } from "vue";

/** Hydrate one island: `el` is the `<cfl-island>` whose children are the server HTML of `Component` (the raw component, not the wrapper). Vue hydrates synchronously. */
export function mount(el: Element, Component: Component, props: Record<string, unknown>) {
  createSSRApp(Component, props).mount(el);
}

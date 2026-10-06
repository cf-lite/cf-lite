import { h, hydrate } from "preact";

/** Hydrate one island: `el` is the `<cfl-island>` whose children are the server HTML of `Component`. */
export function mount(el: Element, Component: any, props: Record<string, unknown>, _sync?: boolean) {  // preact hydrates synchronously
  hydrate(h(Component, props), el);
}

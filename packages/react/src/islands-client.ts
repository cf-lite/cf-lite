import { createElement } from "react";
import { flushSync } from "react-dom";
import { hydrateRoot } from "react-dom/client";

/** Hydrate one island: `el` is the `<cfl-island>` whose children are the server HTML of `Component`. `sync` = finish before returning (a click is replayed right after). */
export function mount(el: Element, Component: any, props: Record<string, unknown>, sync?: boolean) {
  const tree = createElement(Component, props);
  if (sync) flushSync(() => { hydrateRoot(el, tree); });
  else hydrateRoot(el, tree);
}

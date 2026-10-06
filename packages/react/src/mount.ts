import { createElement, useSyncExternalStore } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { createRouter, type ClientRoute, type Router } from "cf-lite/client";
import { compose } from "./compose.js";

function App({ router }: { router: Router }) {
  const view = useSyncExternalStore(router.subscribe, () => router.current, () => router.current);
  return compose(view as never);
}

/** Entry: hydrate when the document was prerendered/streamed (data-ssr), otherwise plain client render. */
export async function mount(routes: ClientRoute[], el: Element = document.getElementById("root")!) {
  const tree = createElement(App, { router: await createRouter(routes) });
  if (el.hasAttribute("data-ssr")) hydrateRoot(el, tree);
  else createRoot(el).render(tree);
}

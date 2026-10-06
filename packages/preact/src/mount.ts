import { h, hydrate, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createRouter, type ClientRoute, type Router } from "cf-lite/client";
import { compose } from "./compose.js";

function App({ router }: { router: Router }) {
  const [view, setView] = useState(router.current);
  useEffect(() => { setView(router.current); return router.subscribe(setView); }, [router]);
  return compose(view as never);
}

export async function mount(routes: ClientRoute[], el: Element = document.getElementById("root")!) {
  const tree = h(App, { router: await createRouter(routes) });
  if (el.hasAttribute("data-ssr")) hydrate(tree, el);
  else render(tree, el);
}

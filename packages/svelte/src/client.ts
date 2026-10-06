import { hydrate, mount as svelteMount } from "svelte";
import { createRouter, navigate as navigateTo, type ClientRoute } from "cf-lite/client";
import type { Navigate } from "cf-lite/href";
import Root from "../lib/Root.svelte";

/** `<Link>` is a component: `import Link from "@cf-lite/svelte/Link.svelte"`. Params arrive as the `params` prop of pages and layouts. */
/** Typed from the generated route table (`cf-lite/href`). Params are props (`PageProps<"/blog/:slug">`), there is no `useParams`. */
export const navigate: Navigate = navigateTo;

export async function mount(routes: ClientRoute[], el: Element = document.getElementById("root")!) {
  const props = { router: await createRouter(routes) };
  (el.hasAttribute("data-ssr") ? hydrate : svelteMount)(Root, { target: el, props });
}

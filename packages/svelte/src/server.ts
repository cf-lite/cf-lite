import { render as svelteRender } from "svelte/server";
import type { Rendered, View } from "cf-lite/adapter";
import Root from "../lib/Root.svelte";

/** Svelte 5 SSR is synchronous: one chunk, no streaming. `<svelte:head>` output is returned as `head`. */
export async function render(view: View): Promise<Rendered> {
  const { body, head } = svelteRender(Root, { props: { view } });
  return { body, head };
}
export async function renderToString(view: View) {
  const { body, head } = svelteRender(Root, { props: { view } });
  return { body, head };
}

import { createComponent, type Component } from "solid-js";
import { generateHydrationScript, renderToStream, renderToString as toString } from "solid-js/web";
import type { Rendered, View } from "cf-lite/adapter";
import { compose } from "./compose.js";

/** Streaming SSR (`renderToStream`; Suspense boundaries resolve in order on the same stream). Hydration bootstrap goes into <head> only when the page hydrates. */
export async function render(view: View): Promise<Rendered> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  renderToStream(() => compose(() => view)).pipeTo(writable as never);
  return { body: readable, head: view.hydrate ? generateHydrationScript() : undefined };
}
export async function renderToString(view: View) {
  return { body: toString(() => compose(() => view)), head: view.hydrate ? generateHydrationScript() : undefined };
}

/** Component preview (cf-lite `/__preview`): the component with fixed props as a router-agnostic Page. */
export const bind = (C: unknown, props: Record<string, unknown>) => () => createComponent(C as Component<any>, props);

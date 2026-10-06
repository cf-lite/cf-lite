import { createSSRApp, h, ref, type Component } from "vue";
import { renderToString as toString, renderToWebStream } from "vue/server-renderer";
import type { Rendered, View } from "cf-lite/adapter";
import { compose, PARAMS } from "./compose.js";

const app = (view: View) => createSSRApp({ render: () => compose(view) }).provide(PARAMS, ref(view.params));

export async function render(view: View): Promise<Rendered> {
  return { body: renderToWebStream(app(view)) as ReadableStream<Uint8Array> };
}
export async function renderToString(view: View) {
  return { body: await toString(app(view)) };
}

/** Component preview (cf-lite `/__preview`): the component with fixed props as a router-agnostic Page. */
export const bind = (C: unknown, props: Record<string, unknown>) => () => h(C as Component, props);

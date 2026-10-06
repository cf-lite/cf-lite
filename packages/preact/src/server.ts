import { h, type ComponentType } from "preact";
import { renderToString as toString } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";
import type { Rendered, View } from "cf-lite/adapter";
import { compose } from "./compose.js";

export async function render(view: View): Promise<Rendered> {
  return { body: renderToReadableStream(compose(view)) as unknown as ReadableStream<Uint8Array> };
}
export async function renderToString(view: View) {
  return { body: toString(compose(view)) };
}

/** Component preview (cf-lite `/__preview`): the component with fixed props as a router-agnostic Page. */
export const bind = (Component: unknown, props: Record<string, unknown>) => () => h(Component as ComponentType<any>, props);

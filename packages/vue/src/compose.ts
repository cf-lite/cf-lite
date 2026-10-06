import { h, type Component, type VNode } from "vue";
import type { View } from "cf-lite/adapter";

/** provide/inject key for `useParams()`; a string so client and server bundles agree. */
export const PARAMS = "cf-lite:params";

/** Layouts receive the page as their default slot (`<slot />`), so a layout keeps its instance across navigations. */
export function compose(v: View): VNode {
  let node: VNode = v.Page ? h(v.Page as Component, { params: v.params, data: v.data }) : h("h1", "404");
  for (let i = v.layouts.length - 1; i >= 0; i--) {
    const inner = node;
    node = h(v.layouts[i] as Component, { params: v.params }, { default: () => inner });
  }
  return node;
}

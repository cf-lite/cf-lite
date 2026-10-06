import { defineComponent, h, inject, type ComputedRef, type PropType } from "vue";
import { handleLinkClick, navigate as navigateTo, type LinkTo } from "cf-lite/client";
import type { Navigate, Params, RoutePattern } from "cf-lite/href";
import { PARAMS } from "./compose.js";

export { mount } from "./mount.js";
/** Typed from the generated route table (`cf-lite/href`): `navigate("/blog/x")` rejects unknown routes; `href()` results are accepted. */
export const navigate: Navigate = navigateTo;
/** Route params as a computed ref. `useParams("/blog/:slug").value.slug`: typed from the route pattern (only a type witness); no argument = `Record<string, string>`. */
export interface UseParams {
  (): ComputedRef<Record<string, string>>;
  <P extends RoutePattern>(pattern: P): ComputedRef<Params<P>>;
}
export const useParams: UseParams = (() => inject<ComputedRef<Record<string, string>>>(PARAMS)!) as UseParams;

export const Link = defineComponent({
  name: "CfLink",
  inheritAttrs: false,
  props: { to: { type: String as PropType<LinkTo>, required: true } },
  setup(props, { slots, attrs }) {
    return () => h("a", {
      ...attrs, href: props.to,
      onClick: (e: MouseEvent) => { (attrs.onClick as ((e: MouseEvent) => void) | undefined)?.(e); handleLinkClick(e, props.to, attrs.target as string | undefined); },
    }, slots.default?.());
  },
});


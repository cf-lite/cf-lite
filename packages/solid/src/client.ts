import { createComponent, createSignal, mergeProps, splitProps, type JSX } from "solid-js";
import { Dynamic, hydrate, render } from "solid-js/web";
import { createRouter, handleLinkClick, navigate as navigateTo, type ClientRoute, type LinkTo } from "cf-lite/client";
import type { Navigate, UseParams } from "cf-lite/href";
import { compose, useParams as useParamsCtx } from "./compose.js";

/** Typed from the generated route table (`cf-lite/href`): `navigate("/blog/x")` rejects unknown routes; `href()` results are accepted. */
export const navigate: Navigate = navigateTo;
/** `useParams("/blog/:slug").slug`: params typed from the route pattern (docs/typegen.md). Without an argument: `Record<string, string>`. */
export const useParams: UseParams = ((): unknown => useParamsCtx()) as UseParams;

/** `<Link to="/x">`: client-side navigation for SPA routes, a normal document navigation otherwise. */
export function Link(props: { to: LinkTo } & JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const [local, rest] = splitProps(props, ["to", "onClick"]);
  const onClick = (e: MouseEvent) => { (local.onClick as ((e: MouseEvent) => void) | undefined)?.(e); handleLinkClick(e, local.to, rest.target); };
  return createComponent(Dynamic as never, mergeProps(rest, { component: "a", get href() { return local.to; }, onClick }) as never);
}

export async function mount(routes: ClientRoute[], el: Element = document.getElementById("root")!) {
  const router = await createRouter(routes);
  // No wrapper component: the server renders `compose(view)` as the root, and hydration ids must line up level for level.
  const [view, setView] = createSignal(router.current);
  router.subscribe((v) => setView(() => v));
  const app = () => compose(view as never);
  (el.hasAttribute("data-ssr") ? hydrate : render)(app, el as HTMLElement);
}

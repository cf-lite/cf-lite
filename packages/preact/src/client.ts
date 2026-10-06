import { h, type JSX } from "preact";
import { useContext } from "preact/hooks";
import { handleLinkClick, navigate as navigateTo, prefetch, type LinkTo } from "cf-lite/client";
import type { Navigate, UseParams } from "cf-lite/href";
import { ParamsCtx } from "./compose.js";

export { mount } from "./mount.js";
/** Typed from the generated route table (`cf-lite/href`): `navigate("/blog/x")` rejects unknown routes; `href()` results are accepted. */
export const navigate: Navigate = navigateTo;
/** `useParams("/blog/:slug").slug`: params typed from the route pattern (docs/typegen.md). Without an argument: `Record<string, string>`. */
export const useParams: UseParams = (() => useContext(ParamsCtx)) as UseParams;

export function Link({ to, prefetch: pf = "intent", ...rest }: { to: LinkTo; prefetch?: "intent" | false } & JSX.HTMLAttributes<HTMLAnchorElement>) {
  const onClick = (e: MouseEvent) => { (rest.onClick as any)?.(e); handleLinkClick(e, to, (rest as any).target); };
  const warm = pf === false ? {} : { onMouseEnter: (e: any) => { (rest.onMouseEnter as any)?.(e); prefetch(to); }, onFocus: (e: any) => { (rest.onFocus as any)?.(e); prefetch(to); } };
  return h("a", { ...rest, ...warm, href: to, onClick } as never);
}

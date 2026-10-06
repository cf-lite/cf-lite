import { createElement, useContext, type FocusEvent as _F, type TouchEvent as TouchEvent_, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { handleLinkClick, navigate as navigateTo, prefetch, type LinkTo } from "cf-lite/client";
import type { Navigate, UseParams } from "cf-lite/href";
import { ParamsCtx } from "./compose.js";

// mount lives in its own module: a layout that imports Link into an SSR Worker must not drag react-dom/client along.
export { mount } from "./mount.js";
/** Typed from the generated route table (`cf-lite/href`): `navigate("/blog/x")` rejects unknown routes; `href()` results are accepted. */
export const navigate: Navigate = navigateTo;
/** `useParams("/blog/:slug").slug`: params typed from the route pattern (docs/typegen.md). Without an argument: `Record<string, string>`. */
export const useParams: UseParams = (() => useContext(ParamsCtx)) as UseParams;

/** `prefetch` (default "intent"): warm the target route's modules on hover/focus/touch; `false` to disable. */
export function Link({ to, prefetch: pf = "intent", ...rest }: { to: LinkTo; prefetch?: "intent" | false } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => { rest.onClick?.(e); handleLinkClick(e, to, rest.target); };
  const warm = pf === false ? {} : {
    onMouseEnter: (e: MouseEvent<HTMLAnchorElement>) => { rest.onMouseEnter?.(e); prefetch(to); },
    onFocus: (e: _F<HTMLAnchorElement>) => { rest.onFocus?.(e); prefetch(to); },
    onTouchStart: (e: TouchEvent_<HTMLAnchorElement>) => { rest.onTouchStart?.(e); prefetch(to); },
  };
  return createElement("a", { ...rest, ...warm, href: to, onClick });
}

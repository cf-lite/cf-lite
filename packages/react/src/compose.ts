import { Component, createContext, createElement, Suspense, type ComponentType, type ReactNode } from "react";
import type { View } from "cf-lite/adapter";

export const ParamsCtx = createContext<Record<string, string>>({});

/** Catches render errors under a page and shows the route's `_error` (props: `error`, and `data.error` like the server-side render). Layouts stay mounted. */
class Boundary extends Component<{ fallback: ComponentType<any>; params: Record<string, string>; children?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    const error = { message: e.message, digest: (e as { digest?: string }).digest };
    return createElement(this.props.fallback, { error, data: { error }, params: this.props.params });
  }
}

/** <Root><Nested><Page/></Nested></Root> - layouts keep their position in the tree, so React keeps their state across navigations. */
export function compose(v: View): ReactNode {
  let node: ReactNode = v.Page
    ? createElement(v.Page as ComponentType<any>, { params: v.params, data: v.data })
    : createElement("h1", null, "404");
  if (v.Page && v.error) node = createElement(Boundary, { fallback: v.error as ComponentType<any>, params: v.params }, node);
  if (v.Page && v.loading) node = createElement(Suspense, { fallback: createElement(v.loading as ComponentType<any>, { params: v.params }) }, node);
  for (let i = v.layouts.length - 1; i >= 0; i--) node = createElement(v.layouts[i] as ComponentType<any>, { params: v.params }, node);
  return createElement(ParamsCtx.Provider, { value: v.params }, node);
}

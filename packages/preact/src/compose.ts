import { Component, createContext, h, type ComponentType, type VNode } from "preact";
import type { View } from "cf-lite/adapter";

export const ParamsCtx = createContext<Record<string, string>>({});

/** Catches render errors under a page and shows the route's `_error` (props: `error`, `data.error`). Layouts stay mounted. `_loading` is not used: preact has no Suspense in core. */
class Boundary extends Component<{ fallback: ComponentType<any>; params: Record<string, string> }, { error: Error | null }> {
  state = { error: null as Error | null };
  componentDidCatch(error: Error) { this.setState({ error }); }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children as never;
    const error = { message: e.message, digest: (e as { digest?: string }).digest };
    return h(this.props.fallback, { error, data: { error }, params: this.props.params });
  }
}

export function compose(v: View): VNode<any> {
  let node: VNode<any> = v.Page ? h(v.Page as ComponentType<any>, { params: v.params, data: v.data }) : h("h1", null, "404");
  if (v.Page && v.error) node = h(Boundary as never, { fallback: v.error as ComponentType<any>, params: v.params }, node);
  for (let i = v.layouts.length - 1; i >= 0; i--) node = h(v.layouts[i] as ComponentType<any>, { params: v.params }, node);
  return h(ParamsCtx.Provider, { value: v.params }, node);
}

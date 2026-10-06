import { createComponent, createContext, untrack, useContext, type Accessor, type Component, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { View } from "cf-lite/adapter";

export const ParamsCtx = createContext<Record<string, string>>({});
export const useParams = () => useContext(ParamsCtx);

const NotFound: Component = () => createComponent(Dynamic, { component: "h1", children: "404" });

/**
 * Page wrapped in its layouts (outermost first), inside a params context. No JSX here: the adapter package is plain tsc output.
 * Every nesting level is a memo keyed on the *identity* of its component, so an SPA navigation only re-creates the levels whose
 * component changed - layouts shared by the old and new route stay mounted (state + DOM kept), as in the other adapters.
 * On the server the view never changes, so the same code renders once.
 */
export function compose(view: Accessor<View>): JSX.Element {
  const params = new Proxy({} as Record<string, string>, { // context values are read once in Solid: hand out a live view of the params
    get: (_, k) => (typeof k === "string" ? view().params[k] : undefined),
    has: (_, k) => typeof k === "string" && k in view().params,
    ownKeys: () => Reflect.ownKeys(view().params),
    getOwnPropertyDescriptor: (_, k) => (typeof k === "string" && k in view().params ? { enumerable: true, configurable: true, value: view().params[k] } : undefined),
  });
  const level = (i: number): JSX.Element =>
    createComponent(Dynamic, {
      // Solid's own <Dynamic> keeps the rendered component while the identity is unchanged, and is symmetric on server and client (hydration ids).
      get component() { return (i < view().layouts.length ? view().layouts[i] : view().Page ?? NotFound) as Component<any>; },
      get params() { return view().params; },
      get data() { return view().data; },
      get children() { return untrack(() => (i < view().layouts.length ? level(i + 1) : undefined)); }, // untracked: level i+1 reacts to the view by itself
    } as never) as unknown as JSX.Element;
  return createComponent(ParamsCtx.Provider, { value: params, get children() { return level(0); } });
}

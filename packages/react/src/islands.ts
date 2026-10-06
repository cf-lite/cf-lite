import { createElement, type ComponentType } from "react";
import { encodeProps } from "cf-lite/islands";

const warned = new Set<string>();
/**
 * Wraps an island component (a `*.island.tsx` default export, or an auto-island export; done by the cf-lite Vite plugin): server HTML inside `<cfl-island>`, props as JSON in `data-p`. `.inner` is what the browser hydrates.
 * `soft` (auto-islands): props that cannot cross into the browser (functions, `children`, elements) are not an error: the component renders plainly, as part of whatever tree it sits in.
 */
export function island<P extends object>(Inner: ComponentType<P>, id: string, when: string, soft?: boolean) {
  const Island = (props: P) => {
    let data: string | undefined;
    if (soft) {
      try { data = encodeProps(id, props as Record<string, unknown>); }
      catch (e) {
        if ((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV && !warned.has(id)) { warned.add(id); console.warn(`[cf-lite] auto-island "${id}" rendered without hydrating: ${(e as Error).message}`); }
        return createElement(Inner, props);
      }
    } else data = encodeProps(id, props as Record<string, unknown>);
    return createElement("cfl-island", { "data-i": id, "data-p": data, "data-w": when === "load" ? undefined : when }, createElement(Inner, props));
  };
  Island.inner = Inner;
  Island.displayName = `Island(${(Inner as { displayName?: string; name?: string }).displayName ?? Inner.name ?? id})`;
  return Island;
}

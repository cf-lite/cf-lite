import { h, type ComponentType } from "preact";
import { encodeProps } from "cf-lite/islands";

/** Wraps an `*.island.tsx` default export (done by the cf-lite Vite plugin): server HTML inside `<cfl-island>`, props as JSON in `data-p`. `.inner` is what the browser hydrates. */
export function island<P extends object>(Inner: ComponentType<P>, id: string, when: string) {
  const Island = (props: P) => h("cfl-island" as never, { "data-i": id, "data-p": encodeProps(id, props as Record<string, unknown>), "data-w": when === "load" ? undefined : when } as never, h(Inner as ComponentType<any>, props));
  Island.inner = Inner;
  Island.displayName = `Island(${(Inner as { displayName?: string; name?: string }).displayName ?? Inner.name ?? id})`;
  return Island;
}

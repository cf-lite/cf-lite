/**
 * Browser side of SSR islands (docs/islands.md): finds `<cfl-island>` elements and hydrates each by its strategy
 * (`data-w`: load (default) | idle | visible | interaction), loading the island's own chunk first. The framework-specific
 * `mount(el, Component, props)` comes from the adapter (`adapter.islands.mount`).
 */
/** `sync`: hydrate synchronously (a click is about to be replayed on the island). */
type Mount = (el: Element, component: any, props: Record<string, unknown>, sync?: boolean) => void;
type Loaders = Record<string, () => Promise<{ default: { inner?: unknown } }>>;
const EVENTS = ["pointerover", "focusin", "touchstart", "click", "keydown"] as const;

export function start(loaders: Loaders, mount: Mount, root: ParentNode = document): void {
  const hydrate = async (el: HTMLElement, first?: Event) => {
    if (el.hasAttribute("data-h")) return;
    el.setAttribute("data-h", "");
    const id = el.dataset.i ?? "";
    // A click that lands before the island's code is ready (or is the trigger itself) is replayed on its target once handlers are attached.
    let clicked: HTMLElement | null = first?.type === "click" && first.target instanceof HTMLElement ? first.target : null;
    const note = (e: Event) => { if (e.target instanceof HTMLElement) clicked = e.target; };
    el.addEventListener("click", note, true);
    try {
      const mod = await loaders[id]!();
      el.removeEventListener("click", note, true);
      // sync: hydration finishes before mount returns, so the replayed click (and any click right after an interaction trigger) is handled
      mount(el, mod.default.inner ?? mod.default, el.dataset.p ? JSON.parse(el.dataset.p) : {}, !!clicked || !!first);
      if (clicked) setTimeout(() => clicked!.click(), 0);
    } catch (e) { el.removeEventListener("click", note, true); console.error(`[cf-lite] island "${id}" failed to hydrate`, e); }
  };
  // Only outermost islands hydrate by themselves: an island inside another one is part of its parent's tree.
  const els = [...root.querySelectorAll<HTMLElement>("cfl-island")].filter((el) => !el.parentElement?.closest("cfl-island"));
  for (const el of els) {
    const when = el.dataset.w ?? "load";
    if (when === "idle") {
      const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, o?: object) => void);
      ric ? ric(() => hydrate(el), { timeout: 2000 }) : setTimeout(() => hydrate(el), 200);
    } else if (when === "visible" && "IntersectionObserver" in window && el.firstElementChild) {
      // the island element is display:contents (no box), so observe its rendered children
      const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); hydrate(el); } }, { rootMargin: "200px" });
      for (const k of el.children) io.observe(k);
    } else if (when === "interaction") {
      const on = (e: Event) => { for (const n of EVENTS) el.removeEventListener(n, on, true); hydrate(el, e); };
      for (const n of EVENTS) el.addEventListener(n, on, { capture: true, passive: true });
    } else hydrate(el);
  }
}

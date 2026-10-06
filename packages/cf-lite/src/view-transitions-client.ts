/**
 * Browser side of `viewTransitions: { router: true }` (docs/view-transitions.md): importing this module (the Vite plugin injects the import into the HTML shell)
 * makes the client router run each SPA view swap inside `document.startViewTransition`. Separate module so apps without the option ship none of it.
 */
import { setViewSwapHook } from "./client.js";

/**
 * Run `update` (which makes the UI framework swap the view) inside `document.startViewTransition` when the browser supports it and the user has not asked
 * for reduced motion; otherwise just run it. Framework-neutral: the transition callback resolves after the first DOM mutation under `#root` (the adapter
 * re-rendered) or after 100 ms when nothing changed, so it works with every adapter without a per-framework hook.
 */
export function withViewTransition(update: () => void, doc: Document = document, win: Window = window): Promise<void> {
  const svt = (doc as Document & { startViewTransition?: (cb: () => Promise<void>) => unknown }).startViewTransition;
  if (!svt || win.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return Promise.resolve(update());
  return new Promise<void>((applied) => svt.call(doc, () => new Promise<void>((resolve) => {
    const root = doc.getElementById("root") ?? doc.body;
    const done = () => { mo.disconnect(); clearTimeout(t); setTimeout(() => { resolve(); applied(); }, 0); };
    const mo = new (win as unknown as typeof globalThis).MutationObserver(done);
    const t = setTimeout(done, 100);
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    update();
  })));
}

setViewSwapHook((update) => withViewTransition(update));

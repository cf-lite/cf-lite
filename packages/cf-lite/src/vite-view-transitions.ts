import type { Plugin } from "vite";

/** `viewTransitions` option of `cfLite()`. `true` = cross-document only; `{ router: true }` also animates the client router's SPA navigations. */
export type ViewTransitionsOption = boolean | { router?: boolean };

/**
 * Cross-document View Transitions are one CSS at-rule in the HTML shell, so every shell-derived page (static, prerendered, SSR, SPA) gets it:
 * browsers that support it animate same-origin document navigations, the rest ignore the rule. Gated on `prefers-reduced-motion`
 * (the at-rule is allowed inside a media query), so nobody who asked for less motion gets a transition.
 */
export const VT_CSS = "@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto}}";

export function viewTransitions(opt: ViewTransitionsOption): Plugin {
  const router = typeof opt === "object" && !!opt.router;
  return {
    name: "cf-lite:view-transitions",
    // `order: "pre"`: the injected module script must exist before Vite's own HTML pass, which is what bundles inline module scripts
    transformIndexHtml: {
      order: "pre",
      handler() {
        return [
          { tag: "style", attrs: { "data-cf-vt": "" }, children: VT_CSS, injectTo: "head" as const },
          ...(router ? [{ tag: "script", attrs: { type: "module" }, children: 'import "cf-lite/view-transitions-client";', injectTo: "head" as const }] : []),
        ];
      },
    },
  };
}

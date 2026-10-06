# View Transitions

**Status: experimental, opt-in** (`viewTransitions` in `cfLite()`; off by default, apps that do not set it build byte-identically). Runs in the browser only; no Worker code, no cost, no binding.

The [View Transitions API](https://developer.mozilla.org/docs/Web/API/View_Transition_API) animates between two page states. Two cases, two mechanisms, one option:

```ts
// vite.config.ts
cfLite({ renderer: react(), viewTransitions: true });              // cross-document only
cfLite({ renderer: react(), viewTransitions: { router: true } });  // + the client router's SPA navigations
```

| Navigation | What animates it | Needs |
|---|---|---|
| document -> document (static, prerendered, `ssr` pages, plain links) | CSS `@view-transition { navigation: auto }` injected into the HTML shell | `viewTransitions: true`. Same-origin only; browsers without support ignore the rule |
| SPA route -> SPA route (client router, `<Link>`) | `document.startViewTransition()` around the view swap | `viewTransitions: { router: true }` (injects a module script importing `cf-lite/view-transitions-client`, which installs the router hook; without the option the router carries no transition code) |

* The at-rule sits inside `@media (prefers-reduced-motion: no-preference)`, and the router checks the same query: nobody who asked for less motion gets a transition.
* The router is framework-neutral (`withViewTransition` in `src/view-transitions-client.ts`): the transition callback resolves after the first DOM mutation under `#root` (the adapter re-rendered), or after 100 ms when nothing changed, so it works with every adapter without a per-framework hook. Focus/scroll handling (`announceNavigation`) runs after the swap.
* Style the animation with the usual CSS (`::view-transition-old(root)`, `view-transition-name` on an element that should morph). Give shared elements the same `view-transition-name` on both pages.
* The rule goes into the shell (`index.html` / `_shell.tpl`), so it reaches static, prerendered, SSR and SPA pages. It is an inline `<style>`: static pages get it covered by the hash CSP, SSR pages by the nonce.

## Limits

* **RSC pages** (`render = "rsc"`) are documents rendered by React, not the shell: they do **not** get the cross-document rule. Add `@view-transition { navigation: auto }` to your own stylesheet imported by a client component (or a `head.link` stylesheet) if you want it there. The RSC soft navigation does not use `startViewTransition` yet.
* Cross-document transitions need both pages to opt in (the rule is on every shell-derived page, so this holds unless you mix in RSC pages).
* Same-document transitions are Chromium/Safari; Firefox support for cross-document is behind a flag at the time of writing - the feature degrades to a normal navigation.
* The router wraps only SPA navigations: `ssr`/`static` routes are real documents and use the cross-document path.

Tests: `packages/cf-lite/test/view-transitions.test.ts` (plugin output, router gating and timing).

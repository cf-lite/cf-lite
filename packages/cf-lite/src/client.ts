/**
 * Framework-free client router. SPA routes navigate client-side; static/ssr routes are real documents.
 * An adapter's `mount()` calls `createRouter(routes)`, then renders `router.current` and re-renders on `subscribe` -
 * how it keeps layouts mounted is the UI framework's business. Nothing here touches a UI framework.
 */
import { applyHead, headFor, type HeadSource } from "./head.js";
import type { View } from "./adapter.js";
import { matchPath } from "./match.js";

export interface RouteModule extends HeadSource { default: unknown }
export interface ClientRoute {
  path: string;
  render: "spa" | "static" | "ssr";
  hydrate: boolean;
  /** Layout modules, outermost first. */
  layouts?: (() => Promise<RouteModule>)[];
  load: () => Promise<RouteModule>;
  /** Nearest `_loading` / `_error` / `_not-found` modules (lazy). */
  loading?: () => Promise<RouteModule>;
  error?: () => Promise<RouteModule>;
  notFound?: () => Promise<RouteModule>;
  /** Nearest `_forbidden` / `_unauthorized` (server-rendered 403 / 401 pages; carried here for completeness, a client navigation never produces those statuses). */
  forbidden?: () => Promise<RouteModule>;
  unauthorized?: () => Promise<RouteModule>;
  /** Synthetic last-resort route built from the root `_not-found`. */
  isNotFound?: boolean;
}

type Match = { route: ClientRoute; params: Record<string, string> };

export { matchPath };
export type { LinkTo } from "./href.js";

export function matchRoute(routes: ClientRoute[], pathname: string): Match | null {
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

/** Warm the module graph of the route `to` would open (what `<Link>` does on hover/focus). No-op for unknown paths; never throws. */
export function prefetch(to: string, routes: ClientRoute[] = activeRoutes): void {
  try {
    const m = matchRoute(routes, new URL(to, location.href).pathname);
    if (!m || m.route.isNotFound) return;
    void Promise.all([m.route.load(), ...(m.route.layouts ?? []).map((l) => l()), m.route.loading?.(), m.route.error?.()]).catch(() => {});
  } catch { /* prefetch is best-effort */ }
}

let pushed = false; // true while the popstate in flight came from navigate() (scroll to top), false for back/forward (the browser restores scroll)

export function navigate(to: string, replace = false) {
  pushed = !replace;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

let activeRoutes: ClientRoute[] = [];

/** Go to `to` the way a link would: client-side for an SPA route, a real document navigation for anything else (ssr/static pages, server routes). */
export function visit(to: string, replace = false): void {
  const url = new URL(to, location.href);
  const m = url.origin === location.origin ? matchRoute(activeRoutes, url.pathname) : null;
  if (m && m.route.render === "spa" && !m.route.isNotFound) navigate(url.pathname + url.search + url.hash, replace);
  else if (replace) location.replace(url.href);
  else location.assign(url.href);
}

/** For an adapter's `<Link>` onClick: navigates client-side iff `to` is an SPA route; otherwise leaves the click alone (real document navigation). Returns true when it handled it. */
export function handleLinkClick(e: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; preventDefault(): void }, to: string, target?: string | null): boolean {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || target) return false;
  const m = matchRoute(activeRoutes, new URL(to, location.href).pathname);
  if (m && m.route.render === "spa") { e.preventDefault(); navigate(to); return true; }
  return false;
}

/** `Page === null` = no route matched (the adapter renders its own 404 view). */
export interface RouterView extends Omit<View, "Page"> { Page: unknown | null; path: string }

// --- accessibility: announce + focus + scroll after a client navigation (SPA routes swap the view without a document load) ---
const SR_ONLY = "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";
export function announceNavigation(doc: Document = document, win: Window = window, scroll = true): void {
  let el = doc.getElementById("cf-lite-announcer");
  if (!el) {
    el = doc.createElement("div");
    el.id = "cf-lite-announcer";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("role", "status");
    el.setAttribute("style", SR_ONLY);
    doc.body.appendChild(el);
  }
  const h1 = doc.querySelector("h1")?.textContent?.trim();
  el.textContent = doc.title || h1 || win.location.pathname;
  // Move focus to the new content so keyboard/screen-reader users are not left on the clicked link.
  const target = (doc.querySelector("main") ?? doc.querySelector("h1")) as HTMLElement | null;
  if (target) {
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
  if (win.location.hash) doc.getElementById(decodeURIComponent(win.location.hash.slice(1)))?.scrollIntoView();
  else if (scroll) win.scrollTo(0, 0);
}

/** Optional wrapper around the view swap of a client navigation; installed by `cf-lite/view-transitions-client` (injected by `viewTransitions: { router: true }`). */
let swapHook: ((update: () => void) => Promise<void>) | undefined;
export const setViewSwapHook = (h: typeof swapHook): void => { swapHook = h; };

export const REFRESH_EVENT = "cf-lite:refresh";
/**
 * `refresh()` (Next.js `router.refresh()`): re-fetch the current page's server data without losing client state. The RSC router re-requests
 * the Flight payload in place, an SPA route has no server data (no-op); for an ssr/static document (no client router owns the page) it falls back to
 * `location.reload()`. Handlers claim the event with `preventDefault()`.
 */
export function refresh(win: Window = window): void {
  if (matchRoute(activeRoutes, win.location.pathname)?.route.render === "spa") return; // a client-only page has no server data to re-fetch
  if (win.dispatchEvent(new CustomEvent(REFRESH_EVENT, { cancelable: true }))) win.location.reload();
}

export interface Router {
  /** Always set once `createRouter` has resolved. */
  current: RouterView;
  subscribe(fn: (v: RouterView) => void): () => void;
}

/** Load page + layouts, update <head>. `data` is only known for the first (server-rendered) view. */
async function loadView(m: Match, path: string, data?: unknown): Promise<RouterView> {
  const [page, loading, error, ...ls] = await Promise.all([m.route.load(), m.route.loading?.(), m.route.error?.(), ...(m.route.layouts ?? []).map((l) => l())]);
  applyHead(headFor([...ls, page], { params: m.params, data, url: path.split(/[?#]/)[0] }), document);
  return { path, Page: page.default, layouts: ls.map((l) => l.default), params: m.params, data, loading: loading?.default, error: error?.default };
}

/** Resolves with the initial view already loaded (needed to hydrate synchronously). */
export async function createRouter(routes: ClientRoute[]): Promise<Router> {
  activeRoutes = routes;
  const first = matchRoute(routes, location.pathname);
  const notFound = (path: string): RouterView => ({ path, Page: null, layouts: [], params: {} });
  const router: Router = {
    current: first ? await loadView(first, location.pathname, (window as any).__CF_LITE_DATA__) : notFound(location.pathname),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
  const subs = new Set<(v: RouterView) => void>();
  let token = 0;
  const set = (v: RouterView) => { router.current = v; subs.forEach((f) => f(v)); };
  window.addEventListener("popstate", async () => {
    const path = location.pathname, mine = ++token;
    if (router.current.path === path) return;
    const m = matchRoute(routes, path);
    const v = m ? await loadView(m, path) : notFound(path);
    if (mine === token) { const scroll = pushed; pushed = false; if (swapHook) await swapHook(() => set(v)); else set(v); setTimeout(() => announceNavigation(document, window, scroll), 0); } // after the adapter re-rendered
  });
  return router;
}

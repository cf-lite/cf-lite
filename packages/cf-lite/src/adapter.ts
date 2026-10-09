/**
 * The UI-adapter contract (docs/adapters.md). The core never imports a UI framework; an adapter package
 * (`@cf-lite/react|preact|vue|svelte`, or your own) default-exports a factory returning a `UiAdapter`.
 * Only module *specifiers* and Vite plugins cross into the bundles - no function of the adapter object runs in the Worker/browser.
 */
import type { IslandCandidate, IslandsAuto } from "./islands.js";
import type { PluginOption, UserConfig } from "vite";
import type { ClientRoute } from "./client.js";

/** What a page looks like to an adapter: components are whatever the route module's default export is. */
export interface View {
  Page: unknown;
  /** Layout components, outermost first. */
  layouts: unknown[];
  params: Record<string, string>;
  data?: unknown;
  /** true when the page will be hydrated in the browser (ssr + `hydrate = true`). Lets an adapter skip hydration bootstrap markup otherwise. */
  hydrate?: boolean;
  /** `_loading` / `_error` component of the page's nearest directory: Suspense fallback / error boundary (adapters that cannot do a boundary ignore them). */
  loading?: unknown;
  error?: unknown;
}

/** Result of a server render. `head` = extra markup the UI framework wants in <head> (e.g. Svelte's <svelte:head>). */
export interface Rendered { body: ReadableStream<Uint8Array> | string; head?: string }

/** `server` module of an adapter: runs in the Worker (ssr routes) and in Node (prerender). */
export interface UiServer {
  render(view: View): Promise<Rendered>;
  renderToString(view: View): Promise<{ body: string; head?: string }>;
  /** Component preview (docs/preview.md): turns `(Component, props)` into a `View.Page` that ignores the router's `params`/`data` and renders the component with exactly these props. Absent = `/__preview` cannot render components for this adapter. */
  bind?(Component: unknown, props: Record<string, unknown>): unknown;
}
/** `client` module of an adapter: runs in the browser. `navigate` is re-exported from cf-lite/client. */
export interface UiClient {
  mount(routes: ClientRoute[], el?: Element): Promise<void>;
}

export interface UiAdapter {
  /** npm package name; the prerender step re-imports the adapter by it (it runs outside the user's Vite config). */
  id: string;
  /** JSON-serialisable options the factory was called with (kept in .cf-lite/meta.json). */
  options?: unknown;
  /** Extensions of route/layout modules, e.g. [".tsx", ".jsx"] or [".vue"]. */
  extensions: string[];
  /** Module specifiers, resolved by Vite from the app. */
  client: string;
  server: string;
  /** SSR islands (docs/islands.md): `wrap` = module exporting `island(Component, id, strategy)` (runs in the Worker and in the page bundle), `mount` = browser module exporting `mount(el, Component, props)`. Absent = the adapter has no islands. */
  islands?: {
    wrap: string;
    mount: string;
    /** Auto-islands: classify the components a source module exports (framework-specific; core never parses UI code itself). `null` = not a component module. Optional: without it `islands.auto` is a no-op for this adapter. */
    detect?: (source: string, file: string) => IslandCandidate[] | null;
    /** Set by core from `cfLite({ islands: { auto } })`, never by the adapter. */
    auto?: IslandsAuto;
  };
  /** Framework Vite plugin(s) + config (aliases...). Used by the app build and by the prerender server. */
  vite(): { plugins: PluginOption[]; config?: UserConfig };
}

/** Static description used by `cf-lite add <ui>` / `create-cf-lite --ui <ui>` (kept out of UiAdapter: it never ships to an app). */
export interface AdapterScaffold {
  /** Dependencies the *app* needs, name -> semver range. */
  deps: Record<string, string>;
  devDeps?: Record<string, string>;
  /** Client entry file (relative to the app root) and its content. */
  entry: { file: string; content: string };
  /** Extra starter files, relative path -> content (only written when absent). */
  starter: Record<string, string>;
  /** Deep-merged into tsconfig.json (when it is plain JSON). */
  tsconfig?: Record<string, unknown>;
  /** Attributes added to `<div id="root">` in index.html (htmx: the `hx-get`/`hx-trigger` that loads the first fragment). */
  rootAttrs?: string;
}

export const defineAdapter = (a: UiAdapter): UiAdapter => a;

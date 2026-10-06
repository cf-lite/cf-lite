/**
 * `cf-lite/rsc`: the server-component side of `render = "rsc"` (docs/design/rsc.md). Runs ONLY in the `rsc` Vite environment
 * (react-server condition); the generated `.cf-lite/rsc-entry.tsx` calls `createRsc()`. Page / layout code imports the helpers:
 *
 *   import { notFound, redirect, getRequest } from "cf-lite/rsc";
 *   export default async function Page() { const { env, params } = getRequest(); ... }
 */
import { AsyncLocalStorage } from "node:async_hooks";
// @ts-ignore optional peer (only resolvable in apps that opt in to RSC)
import { createElement } from "react";
import { headFor, type Head, type HeadSource } from "../head.js";
import { digestOf } from "./rsc-digest.js";

const h: (...a: any[]) => any = createElement as never;

export { notFound, forbidden, unauthorized, redirect, permanentRedirect } from "../navigation.js";

/** Request-scoped context, readable from any server component / loader / `React.cache` function of the request. */
export interface RscRequest {
  /** Worker bindings (`env`). */
  env: unknown;
  /** The Worker's ExecutionContext (`waitUntil`); undefined when the request has none (tests). */
  ctx?: { waitUntil(p: Promise<unknown>): void };
  req: Request;
  params: Record<string, string>;
  url: URL;
  /** What the route's `loader` returned (undefined without one). */
  data: unknown;
  /** Verified draft/preview state (`cf-lite/modules/draft`), undefined for a public request. Such responses are never stored in a shared cache. */
  draft?: unknown;
  /** `Set-Cookie` lines queued by `updateTag()` during a server action; the action route appends them to its response. */
  cookies?: string[];
}
const als = new AsyncLocalStorage<RscRequest>();
/** The current request. Throws outside a server-component render. */
export function getRequest(): RscRequest {
  const r = als.getStore();
  if (!r) throw new Error("cf-lite/rsc: getRequest() called outside a server-component render");
  return r;
}
export const getEnv = <E = unknown>(): E => getRequest().env as E;
/** True when the request carries a valid draft-mode cookie (`cfLite({ draft })`): read unpublished content, never cache. */
export const isDraft = (): boolean => !!getRequest().draft;

type Mod = Record<string, any>;
export interface RscRouteDef {
  load(): Promise<Mod>;
  /** `_layout.rsc.tsx` modules, outermost first. */
  layouts: (() => Promise<Mod>)[];
  error?: () => Promise<Mod>;
  notFound?: () => Promise<Mod>;
  forbidden?: () => Promise<Mod>;
  unauthorized?: () => Promise<Mod>;
}
export interface RscCtx { /** Collects `Set-Cookie` lines from `updateTag()` (actions only). */ cookies?: string[]; /** `security()` CSP nonce of the request: stamped on `head.script` entries. */ nonce?: string; env: unknown; ctx?: RscRequest["ctx"]; req: Request; digest: string; /** Verified draft state of the request (see RscRequest.draft). */ draft?: unknown; /** false = pure server page (`hydrate = false`): no client boundary, so no client reference reaches the page. */ js?: boolean }
export type RscMode = "page" | "not-found" | "error" | "forbidden" | "unauthorized";
export interface RscOptions {
  /** `renderToReadableStream` of `@vitejs/plugin-rsc/rsc`. */
  render(model: unknown, o: { onError(e: unknown): string | undefined }): ReadableStream<Uint8Array>;
  /** Generated `"use client"` error boundary (`.cf-lite/rsc-boundary.tsx`). */
  Boundary: unknown;
  routes: Record<string, RscRouteDef>;
  /** `loadServerAction` of `@vitejs/plugin-rsc/rsc` (absent: the app has no actions; every POST is refused). */
  loadAction?(id: string): Promise<unknown>;
}
export interface RscConfig {
  cache?: unknown; cacheKey?: unknown; isr?: unknown;
  /** `export const actionGuard = ({ req, env, ctx, params, id }) => boolean | Response | void`: rate-limit / authz hook, runs before an action; `false` = 429. */
  actionGuard?: (a: { req: Request; env: unknown; ctx?: RscRequest["ctx"]; params: Record<string, string>; id: string }) => unknown;
  /** `export const actionMaxBytes = N`: body limit for this route's actions (default 1 MiB). */
  actionMaxBytes?: number;
  /** Ids of the server references the page / its layouts export in `serverActions = [fn, ...]`: the per-route action allowlist. */
  actions: string[];
}
export interface FlightResult { stream: ReadableStream<Uint8Array>; data: unknown }

/** `head` export -> React elements (rendered inside the document `<head>`; React 19 hoists/dedupes title/meta/link). */
const ATTR: Record<string, string> = { "http-equiv": "httpEquiv", charset: "charSet", hreflang: "hrefLang", crossorigin: "crossOrigin", class: "className", imagesrcset: "imageSrcSet", imagesizes: "imageSizes", referrerpolicy: "referrerPolicy", fetchpriority: "fetchPriority", nomodule: "noModule" };
const attrs = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [ATTR[k] ?? k, v]));
export function headElements(hd: Head, nonce?: string): unknown[] {
  const out: unknown[] = [];
  if (hd.title !== undefined) out.push(h("title", { key: "title" }, hd.title));
  (hd.meta ?? []).forEach((m, i) => out.push(h("meta", { key: "m" + i, ...attrs(m) })));
  (hd.link ?? []).forEach((l, i) => out.push(h("link", { key: "l" + i, ...attrs(l) })));
  (hd.script ?? []).forEach((s, i) => out.push(s.content !== undefined
    ? h("script", { key: "s" + i, ...(s.type ? { type: s.type } : {}), ...attrs(s.attrs ?? {}), ...(nonce ? { nonce } : {}), dangerouslySetInnerHTML: { __html: s.content.replace(/<\/(script)/gi, "<\\/$1") } })
    : h("script", { key: "s" + i, src: s.src, ...(s.type ? { type: s.type } : {}), ...(s.strategy === "blocking" ? {} : s.strategy === "defer" || !s.strategy ? { defer: true } : { async: true }), ...attrs(s.attrs ?? {}), ...(nonce ? { nonce } : {}) })));
  return out;
}

export function createRsc(o: RscOptions) {
  const route = (path: string) => { const r = o.routes[path]; if (!r) throw new Error(`cf-lite/rsc: no rsc route ${path}`); return r; };

  async function flight(path: string, params: Record<string, string>, url: string, rctx: RscCtx, mode: RscMode = "page"): Promise<FlightResult> {
    const def = route(path), u = new URL(url);
    const [page, ...layouts] = await Promise.all([def.load(), ...def.layouts.map((l) => l())]);
    const store: RscRequest = { env: rctx.env, ctx: rctx.ctx, req: rctx.req, params, url: u, data: undefined, draft: rctx.draft };
    return als.run(store, async () => {
      // loader: runs before anything is rendered, so a `throw notFound()` / `throw redirect()` becomes a real status
      if (mode === "page" && typeof page.loader === "function") store.data = await page.loader({ env: rctx.env, ctx: rctx.ctx, req: rctx.req, params, url: u, draft: rctx.draft });
      const data = store.data;
      const hd = headFor([...layouts, mode === "page" ? page : {}] as HeadSource[], { params, data, url: u.pathname });
      const props = { params, url, data };
      let body: unknown;
      let Fallback: unknown;
      if (mode === "page") body = h(page.default, props);
      else {
        const bm = await (mode === "error" ? def.error : mode === "forbidden" ? def.forbidden : mode === "unauthorized" ? def.unauthorized : def.notFound)?.();
        const title = { error: "Something went wrong", "not-found": "Not Found", forbidden: "Forbidden", unauthorized: "Unauthorized" }[mode];
        body = bm ? h(bm.default, { ...props, digest: rctx.digest }) : h("main", null, h("h1", null, title), mode === "error" ? h("p", null, `digest ${rctx.digest}`) : null);
      }
      for (let i = layouts.length - 1; i >= 0; i--) body = h(layouts[i].default, { params, url, data }, body);
      if (mode === "page" && rctx.js !== false) {
        const [nf, er, fb, un] = await Promise.all([def.notFound?.(), def.error?.(), def.forbidden?.(), def.unauthorized?.()]);
        // notFound is rendered here (a server component cannot be passed to the client as a function); `error` needs the digest at runtime, so it must be a client component
        Fallback = { notFound: nf ? h(nf.default, props) : undefined, forbidden: fb ? h(fb.default, props) : undefined, unauthorized: un ? h(un.default, props) : undefined, error: (er?.default as { $$typeof?: symbol } | undefined)?.$$typeof === Symbol.for("react.client.reference") ? er!.default : undefined };
      }
      const bprops = (Fallback ?? {}) as Record<string, unknown>;
      const doc = h("html", { lang: "en", ...attrs(hd.htmlAttrs ?? {}) },
        h("head", null, h("meta", { charSet: "utf-8" }), ...headElements(hd, rctx.nonce)),
        h("body", null, h("div", { id: "root" }, mode === "page" && rctx.js !== false ? h(o.Boundary as never, bprops, body) : body)));
      const stream = o.render({ root: doc }, {
        onError(e) {
          const d = digestOf(e);
          if (d) return d;
          console.error(`[cf-lite] rsc render error digest=${rctx.digest} ${rctx.req.method} ${u.pathname}`, e);
          (globalThis as unknown as Record<symbol, ((...a: unknown[]) => void) | undefined>)[Symbol.for("cf-lite.report")]?.(e, { digest: rctx.digest, method: rctx.req.method, url }, rctx.env, rctx.ctx);
          return rctx.digest;
        },
      });
      return { stream, data };
    });
  }

  /** Route-level `cache` / `cacheKey` / `isr` exports, handed to `cacheRoute` / `isrRoute` in the Worker environment; plus the action hooks. */
  async function config(path: string): Promise<RscConfig> {
    const def = route(path), [m, ...ls] = await Promise.all([def.load(), ...def.layouts.map((l) => l())]);
    const actions = [m, ...ls].flatMap((x) => (Array.isArray(x.serverActions) ? x.serverActions : [])).map((f: { $$id?: unknown }) => f?.$$id).filter((i): i is string => typeof i === "string");
    return { cache: m.cache, cacheKey: m.cacheKey, isr: m.isr, actionGuard: m.actionGuard, actionMaxBytes: m.actionMaxBytes, actions };
  }

  /**
   * Runs one form action inside the request context. The id was already shape-checked by `parseActionRequest`; here it must additionally
   * resolve to a registered server reference with exactly that id (the plugin's registry only contains `"use server"` modules under
   * `app/actions/**` / `*.actions.ts`, see `rscActions` in vite.ts). Anything else is `unknown`, never executed.
   */
  async function action(path: string, params: Record<string, string>, url: string, rctx: RscCtx, id: string, form: FormData): Promise<"unknown" | "ok"> {
    route(path);
    if (!o.loadAction) return "unknown";
    let fn: any;
    try { fn = await o.loadAction(id); } catch { return "unknown"; }
    if (typeof fn !== "function" || fn.$$typeof !== Symbol.for("react.server.reference") || fn.$$id !== id) return "unknown";
    const store: RscRequest = { env: rctx.env, ctx: rctx.ctx, req: rctx.req, params, url: new URL(url), data: undefined, draft: rctx.draft, cookies: rctx.cookies };
    await als.run(store, () => fn(form));
    return "ok";
  }
  return { flight, config, action };
}

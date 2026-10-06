/**
 * SSR helper used by the generated Hono app for `export const render = "ssr"` pages.
 * This is the ONLY framework code that can run on a request, and only for those routes.
 * The HTML shell is the built index.html, saved at build time as /_shell.tpl (see prerender.ts).
 */
import type { Context } from "hono";
import type { UiServer } from "./adapter.js";
import { headFor, injectHead, type HeadSource } from "./head.js";
import { matchPath } from "./match.js";
import { isNavigationSignal, signalStatus } from "./navigation.js";
import { requestId } from "./modules/request-id.js";
import { addNonce } from "./modules/csp.js";
import { handleAction, withActionData, type ActionsModule } from "./modules/actions.js";

export { notFound, forbidden, unauthorized, redirect, permanentRedirect } from "./navigation.js";

interface SsrModule extends HeadSource, ActionsModule {
  default: unknown;
  loader?: (c: Context) => unknown | Promise<unknown>;
}

let shellCache: string | undefined;
const SCRIPTS = /<script type="module"[^>]*><\/script>|<link rel="modulepreload"[^>]*>/g;

async function getShell(c: Context): Promise<string> {
  if (shellCache) return shellCache;
  const env = c.env as { ASSETS?: Fetcher };
  const res = await env.ASSETS!.fetch(new URL("/_shell.tpl", c.req.url));
  const text = await res.text();
  // dev (vite) has no _shell.tpl: the assets worker answers with the SPA index.html, which is what we want.
  if (!text.includes('id="root"')) throw new Error("cf-lite: could not load HTML shell");
  if (!isDev()) shellCache = text;
  return text;
}

export interface SsrOpts {
  ui: UiServer;
  hydrate: boolean;
  layouts?: (HeadSource & { default: unknown })[];
  /** Route pattern (`/docs/*?`): params (incl. the `*` catch-all) come from it; a non-match falls through to the next handler. */
  path?: string;
  /** Boundary modules (nearest ancestor's `_loading` / `_error` / `_not-found`). */
  loading?: { default: unknown };
  error?: { default: unknown };
  notFound?: { default: unknown };
  /** `_forbidden` / `_unauthorized` (403 / 401 pages for `forbidden()` / `unauthorized()`). */
  forbidden?: { default: unknown };
  unauthorized?: { default: unknown };
  /** static + `paths()` + `dynamicParams = true`: try the prerendered file in assets first, SSR only when it is missing. */
  staticFirst?: boolean;
}

export function ssr(mod: SsrModule, opts: SsrOpts) {
  const layouts = opts.layouts ?? [];
  const enc = new TextEncoder();

  /** Render `page` inside the layouts with the given status. `boundary` renders never hydrate (there is nothing matching to hydrate). */
  async function respond(c: Context, page: SsrModule, params: Record<string, string>, data: unknown, status: number, boundary = false): Promise<Response> {
    const hydrate = !boundary && opts.hydrate;
    const scripts = !boundary && (opts.hydrate || isDev());
    const nonce = c.get("cspNonce"); // set by cf-lite/modules/csp `security()`; undefined = no CSP nonce flow
    let shell = await getShell(c);
    shell = injectHead(shell, headFor([...layouts, page], { params, data, url: new URL(c.req.url).pathname }), { nonce });
    if (!scripts) shell = shell.replace(SCRIPTS, "");
    const { body, head: uiHead } = await opts.ui.render({
      Page: page.default, layouts: layouts.map((l) => l.default), params, data, hydrate,
      loading: opts.loading?.default, error: opts.error?.default,
    });
    if (uiHead) shell = shell.replace("</head>", () => uiHead + "</head>");
    if (nonce) shell = addNonce(shell, nonce); // the shell's own inline <script>/<style> (fonts, theme bootstrap) + uiHead
    const [head, tail] = shell.split(/<div id="root">\s*<\/div>/);
    const extra = scripts ? `<script${nonce ? ` nonce="${nonce}"` : ""}>window.__CF_LITE_DATA__=${JSON.stringify(data ?? null).replace(/</g, "\\u003c")}</script>` : "";
    const { readable, writable } = new TransformStream();
    (async () => {
      const w = writable.getWriter();
      await w.write(enc.encode(head + extra + '<div id="root" data-ssr>'));
      if (typeof body === "string") await w.write(enc.encode(body));
      else {
        const r = body.getReader();
        for (;;) { const { done, value } = await r.read(); if (done) break; await w.write(value); }
      }
      await w.write(enc.encode("</div>" + (tail ?? "")));
      await w.close();
    })().catch(() => {});
    return new Response(readable, { status, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  /** Signal/exception -> Response. Runs before any byte is written, so status and Location are real. */
  async function recover(c: Context, e: unknown, params: Record<string, string>): Promise<Response> {
    if (isNavigationSignal(e)) {
      if (e.kind === "redirect") return new Response(null, { status: e.status, headers: { location: e.url } });
      const status = signalStatus(e.kind), page = e.kind === "forbidden" ? opts.forbidden : e.kind === "unauthorized" ? opts.unauthorized : opts.notFound;
      try { if (page) return await respond(c, page as SsrModule, params, undefined, status, true); } catch { /* fall through */ }
      return new Response(e.kind === "forbidden" ? "Forbidden" : e.kind === "unauthorized" ? "Unauthorized" : "Not Found", { status, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const digest = requestId(c);
    console.error(`[cf-lite] render error digest=${digest} ${c.req.method} ${new URL(c.req.url).pathname}`, e);
    let ectx: { waitUntil(p: Promise<unknown>): void } | undefined; try { ectx = c.executionCtx; } catch { /* none */ }
    (globalThis as unknown as Record<symbol, ((...a: unknown[]) => void) | undefined>)[Symbol.for("cf-lite.report")]?.(e, { digest, method: c.req.method, url: c.req.url }, c.env, ectx); // set by modules/error when server/error.ts exists
    const error = { message: isDev() ? String((e as Error)?.message ?? e) : "Internal Server Error", digest };
    try { if (opts.error) return await respond(c, opts.error as SsrModule, params, { error, digest }, 500, true); } catch (e2) { console.error(`[cf-lite] _error boundary failed digest=${digest}`, e2); }
    return new Response(`Internal Server Error (digest ${digest})`, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  return async (c: Context, next?: () => Promise<void>): Promise<Response> => {
    const url = new URL(c.req.url);
    let params: Record<string, string> = c.req.param();
    if (opts.path) {
      const m = matchPath(opts.path, url.pathname);
      if (!m) return (next ? next() : c.notFound()) as Promise<Response>; // fall through: Hono answers 404
      params = { ...params, ...m };
      // Hono never exposes the `*` splat (nor our `*?`) through c.req.param(): serve the merged params so loaders, isr tags and cache policies see them.
      const all = params;
      c.req.param = ((k?: string) => (k === undefined ? { ...all } : all[k])) as typeof c.req.param;
    }
    if (c.req.method === "POST") {
      // `export const actions`: the form-post half of the route (CSRF, `?/name` dispatch, re-render with `actionData`; modules/actions.ts)
      if (!mod.actions) return (next ? next() : c.notFound()) as Promise<Response>;
      return handleAction(c, mod, {
        rerender: async (actionData, status) => {
          try {
            const data = withActionData(mod.loader ? await mod.loader(c) : undefined, actionData);
            return await respond(c, mod, params, data, status);
          } catch (e) { return recover(c, e, params); }
        },
        recover: (e) => recover(c, e, params),
      });
    }
    if (opts.staticFirst && !isDev()) {
      const res = await (c.env as { ASSETS: Fetcher }).ASSETS.fetch(c.req.raw);
      if (res.status !== 404) return res;
    }
    try {
      const data = mod.loader ? await mod.loader(c) : undefined;
      c.set("cflData", data); // read by cf-lite/modules/cache (function-form `export const cache`)
      return await respond(c, mod, params, data, 200);
    } catch (e) {
      return recover(c, e, params);
    }
  };
}

const isDev = () => !!(import.meta as any).env?.DEV;

/**
 * Opt-in RSC route handler (docs/design/rsc.md). Only imported by generated `.cf-lite/app.ts` when a page exports
 * `render = "rsc"`, so apps that do not opt in never bundle react-server-dom / the Flight client.
 * Runs in the `ssr` Vite environment (the Worker entry); the page itself runs in the child `rsc` environment.
 *
 * Caching (docs/caching.md, docs/isr.md): a route's `export const cache` / `isr` wrap this handler exactly like an ssr route's. The HTML
 * response already contains the Flight payload inline, so HTML + payload are one cache entry; `?__rsc` is a separate key (query string) but
 * carries the same `path:<pathname>` tag, so any tag/path purge invalidates both.
 */
import type { Context } from "hono";
// @ts-ignore optional peer (only resolvable in apps that opt in to RSC)
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr";
// @ts-ignore optional peer
import { renderToReadableStream } from "react-dom/server.edge";
// @ts-ignore optional peer
import { injectRSCPayload } from "rsc-html-stream/server";
// @ts-ignore optional peer
import { use, createElement, type ReactNode } from "react";
import { requestId } from "./request-id.js";
import { signalOf } from "./rsc-digest.js";
import { signalStatus } from "../navigation.js";
import { keepRscParam, parseActionRequest } from "./rsc-action.js";
import type { RscConfig } from "./rsc-server.js";

type Mode = "page" | "not-found" | "error" | "forbidden" | "unauthorized";
interface RscCtx { cookies?: string[]; nonce?: string; draft?: unknown; env: unknown; ctx?: { waitUntil(p: Promise<unknown>): void }; req: Request; digest: string }
interface RscModule {
  flight(path: string, params: Record<string, string>, url: string, rctx: RscCtx, mode?: Mode): Promise<{ stream: ReadableStream<Uint8Array>; data: unknown }>;
  config(path: string): Promise<RscConfig>;
  action(path: string, params: Record<string, string>, url: string, rctx: RscCtx, id: string, form: FormData): Promise<"unknown" | "ok">;
}
export interface RscRouteOptions {
  path: string;
  /** The page exports `cache` / `isr`: wrap the handler with `cacheRoute` / `isrRoute` (isr inside cache, like ssr routes). */
  cache?: boolean;
  isr?: boolean;
  /** `export const hydrate = false` on the page: a pure server page - no bootstrap script, no inline Flight payload, zero client JS. */
  js?: boolean;
}

// The plugin rewrites these literal `import.meta.viteRsc.*(...)` call sites at build time (aliasing the object breaks it).
// @ts-ignore import.meta.viteRsc is typed by @vitejs/plugin-rsc/types (not a dependency of cf-lite)
const loadRsc = async () => (await import.meta.viteRsc.loadModule("rsc", "index")) as RscModule;
// @ts-ignore see above
const loadBootstrap = async () => (await import.meta.viteRsc.loadBootstrapScriptContent("index")) as string;

const text = (status: number, body: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...extra } });
const html = { "content-type": "text/html;charset=utf-8" };

const rctxOf = (c: Context): RscCtx => { let ectx: RscCtx["ctx"]; try { ectx = c.executionCtx; } catch { /* no ExecutionContext (tests) */ } return { env: c.env, ctx: ectx, req: c.req.raw, digest: requestId(c), nonce: c.get("cspNonce") as string | undefined, draft: c.get("draft") }; };

function makeRespond(opts: Pick<RscRouteOptions, "path" | "js">) {
  return async function respond(c: Context, rsc: RscModule, mode: Mode, status: number, flightOnly = new URL(c.req.url).searchParams.has("__rsc")): Promise<Response> {
    const rctx = { ...rctxOf(c), js: opts.js };
    const { stream, data } = await rsc.flight(opts.path, c.req.param() as Record<string, string>, c.req.url, rctx, mode);
    c.set("cflData", data); // read by cf-lite/modules/cache (function-form `export const cache`)
    if (flightOnly) return new Response(stream, { status, headers: { "content-type": "text/x-component;charset=utf-8", vary: "accept" } });
    const noJs = opts.js === false;
    const nonce = c.get("cspNonce") as string | undefined; // `security()` nonce: stamped on the bootstrap script and every inline Flight script (cache/isr bypass when set)
    const [s1, s2] = noJs ? [stream, undefined as never] : stream.tee(); // s2 rides inside the HTML so the browser hydrates without a second fetch
    let tree: Promise<{ root: ReactNode }> | undefined;
    const Root = () => use((tree ??= (createFromReadableStream as any)(s1) as Promise<{ root: ReactNode }>)).root;
    try {
      // Resolves once the shell (everything outside Suspense) is ready, rejects if the shell errors: still before any byte, so the status is real.
      const out = await renderToReadableStream(createElement(Root), { ...(noJs ? {} : { bootstrapScriptContent: await loadBootstrap(), nonce }), onError: (e: unknown) => (e as { digest?: string })?.digest });
      return new Response(noJs ? out : out.pipeThrough(injectRSCPayload(s2, { nonce })), { status, headers: html });
    } catch (e) {
      s1.cancel().catch(() => {}); s2?.cancel().catch(() => {});
      throw e;
    }
  }

}

export function rscRoute(opts: RscRouteOptions) {
  const respond = makeRespond(opts);
  async function handle(c: Context): Promise<Response> {
    const rsc = await loadRsc();
    try { return await respond(c, rsc, "page", 200); }
    catch (e) {
      const sig = signalOf(e);
      if (sig?.kind === "redirect") return new Response(null, { status: sig.status, headers: { location: sig.url } });
      const kind: Mode = sig ? (sig.kind as Mode) : "error";
      if (!sig) console.error(`[cf-lite] rsc shell error digest=${requestId(c)} ${c.req.method} ${new URL(c.req.url).pathname}`, e);
      try { return await respond(c, rsc, kind, sig ? signalStatus(sig.kind as "not-found") : 500); }
      catch (e2) { console.error(`[cf-lite] rsc ${kind} boundary failed digest=${requestId(c)}`, e2); }
      return sig ? text(signalStatus(sig.kind as "not-found"), { forbidden: "Forbidden", unauthorized: "Unauthorized" }[sig.kind as string] ?? "Not Found") : text(500, `Internal Server Error (digest ${requestId(c)})`);
    }
  }

  if (!opts.cache && !opts.isr) return handle;
  // `cache` / `isr` live in the page module, which only exists in the rsc environment: read them once, then wrap like an ssr route.
  let wrapped: Promise<(c: Context) => Response | Promise<Response>> | undefined;
  const build = async () => {
    const raw = await (await loadRsc()).config(opts.path);
    const cfg = { ...raw, cacheKey: keepRscParam(raw.cacheKey), cache: typeof raw.cache === "function" ? raw.cache : keepRscParam(raw.cache), isr: keepRscParam(raw.isr) };
    let h: (c: Context) => Response | Promise<Response> = handle;
    if (opts.isr) h = (await import("./isr.js")).isrRoute(cfg as never, h) as never;
    if (opts.cache) h = (await import("./cache.js")).cacheRoute(cfg as never, h);
    return h;
  };
  return async (c: Context): Promise<Response> => (await (wrapped ??= build().catch((e) => { wrapped = undefined; throw e; })))(c);
}

const gone = (kind: string) => text(kind === "unknown" ? 400 : 500, kind === "unknown" ? "Unknown action" : "Internal Server Error");

/**
 * `POST <rsc route>`: a form-based server action (docs/design/rsc.md section 11). Order of checks, each cheaper than the next:
 * origin/CSRF + content type -> body size -> parse + exactly one well-formed `$ACTION_ID_` -> route `actionGuard` (rate limit / authz hook)
 * -> id must be a registered server reference. No Flight request is ever decoded. Result: `303` back to the page (no-JS / PRG), or - when the
 * client router asks with `Accept: text/x-component` - the freshly rendered page payload (`x-cf-lite-redirect` instead of a 3xx for `redirect()`).
 */
export function rscActionRoute(opts: Pick<RscRouteOptions, "path" | "js">) {
  const respond = makeRespond(opts);
  return async (c: Context): Promise<Response> => {
    const rsc = await loadRsc();
    const cfg = await rsc.config(opts.path);
    const pr = await parseActionRequest(c.req.raw, { maxBytes: cfg.actionMaxBytes });
    const u = new URL(c.req.url), flight = (c.req.header("accept") ?? "").includes("text/x-component");
    if (!pr.ok) {
      console.warn(`[cf-lite] rsc action refused ${u.pathname}: ${pr.reason}`);
      return text(pr.status, pr.status === 413 ? "Payload Too Large" : pr.status === 405 ? "Method Not Allowed" : pr.status === 415 ? "Unsupported Media Type" : pr.status === 403 ? "Cross-site request blocked" : "Bad Request", pr.status === 405 ? { allow: "GET" } : {});
    }
    if (!cfg.actions.includes(pr.id)) { console.warn(`[cf-lite] rsc action refused ${u.pathname}: id not in this route's \`serverActions\` allowlist`); return gone("unknown"); } // ids are app-global; a route only accepts the ones it exports
    const rctx = rctxOf(c), params = c.req.param() as Record<string, string>;
    rctx.cookies = []; // `updateTag()` in the action queues its read-your-writes cookie here
    const ck = async (res: Response | Promise<Response>): Promise<Response> => { const r = await res; for (const k of rctx.cookies ?? []) r.headers.append("set-cookie", k); return r; };
    if (cfg.actionGuard) {
      let g: unknown;
      try { g = await cfg.actionGuard({ req: c.req.raw, env: c.env, ctx: rctx.ctx, params, id: pr.id }); }
      catch (e) { console.error(`[cf-lite] rsc actionGuard threw ${u.pathname}`, e); return text(500, "Internal Server Error"); }
      if (g instanceof Response) return g;
      if (g === false) return text(429, "Too Many Requests", { "retry-after": "60" });
    }
    const back = u.pathname + u.search;
    const renderErr = async (kind: Mode, status: number) => { try { return await respond(c, rsc, kind, status, flight); } catch (e2) { console.error(`[cf-lite] rsc ${kind} boundary failed digest=${rctx.digest}`, e2); return text(status, status === 404 ? "Not Found" : status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : `Internal Server Error (digest ${rctx.digest})`); } };
    try {
      if ((await rsc.action(opts.path, params, c.req.url, rctx, pr.id, pr.form)) === "unknown") { console.warn(`[cf-lite] rsc action refused ${u.pathname}: unknown id`); return gone("unknown"); }
    } catch (e) {
      const sig = signalOf(e);
      if (sig?.kind === "redirect") return ck(flight ? new Response(null, { status: 200, headers: { "x-cf-lite-redirect": sig.url } }) : new Response(null, { status: 303, headers: { location: sig.url } }));
      if (sig) return renderErr(sig.kind as Mode, signalStatus(sig.kind as "not-found"));
      console.error(`[cf-lite] rsc action error digest=${rctx.digest} ${u.pathname}`, e);
      (globalThis as unknown as Record<symbol, ((...a: unknown[]) => void) | undefined>)[Symbol.for("cf-lite.report")]?.(e, { digest: rctx.digest, method: "POST", url: c.req.url }, c.env, rctx.ctx);
      return renderErr("error", 500);
    }
    if (flight) { try { return await ck(respond(c, rsc, "page", 200, true)); } catch (e) { console.error(`[cf-lite] rsc post-action render failed digest=${rctx.digest}`, e); return renderErr("error", 500); } }
    return ck(new Response(null, { status: 303, headers: { location: back } }));
  };
}

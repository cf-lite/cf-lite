/**
 * Mock layer runtime (docs/mocks.md). Dev only: the generated app loads this behind `import.meta.env.DEV && MOCK=1`, so it is
 * never part of a production Worker. Route-level JSON/handler mocks answer (a) requests to this app's own origin and
 * (b) `fetch()` calls made by pages/loaders/components - to the app's own origin and to other origins that have a `mocks/<host>/` folder.
 */
import type { Context } from "hono";
import { matchPath } from "../match.js";

export interface MockContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body (`application/json`), the raw text for other bodies, `undefined` for GET/HEAD/no body. */
  body: unknown;
}
/** A value becomes a JSON 200; a `Response` passes through (status, headers, streaming); `undefined` is 204. */
export type MockHandler = (ctx: MockContext) => unknown | Promise<unknown>;
/** Identity helper that types a handler file: `export default defineMock(({ params }) => ({ id: params.id }))`. */
export const defineMock = (h: MockHandler): MockHandler => h;

export interface MockRouteDef {
  method: string;
  host?: string;
  pattern: string;
  file: string;
  json?: unknown;
  handler?: MockHandler;
}

export interface MockTable {
  routes: readonly MockRouteDef[];
  /** The matching route (and its params) for a request line, or null. `origin` is this app's own origin (host-less mocks only apply to it). */
  match(method: string, url: URL, origin: string): { route: MockRouteDef; params: Record<string, string> } | null;
  respond(request: Request, hit: { route: MockRouteDef; params: Record<string, string> }): Promise<Response>;
  /** Hono middleware: answers matching same-origin requests, otherwise `next()`. Also installs the `fetch` interception on first use. */
  middleware(c: Context, next: () => Promise<void>): Promise<Response | void>;
}

export function createMocks(routes: readonly MockRouteDef[]): MockTable {
  const match: MockTable["match"] = (method, url, origin) => {
    for (const route of routes) {
      if (route.method !== "*" && route.method !== method.toUpperCase()) continue;
      if (route.host ? route.host !== url.host : url.origin !== origin) continue;
      const params = matchPath(route.pattern, url.pathname);
      if (params) return { route, params };
    }
    return null;
  };
  const respond: MockTable["respond"] = async (request, { route, params }) => {
    let out: unknown;
    if (route.handler) {
      const url = new URL(request.url);
      let body: unknown;
      if (request.method !== "GET" && request.method !== "HEAD") {
        const text = await request.clone().text();
        body = /json/.test(request.headers.get("content-type") ?? "") ? safeJson(text) : text || undefined;
      }
      out = await route.handler({ request, url, params, query: Object.fromEntries(url.searchParams), body });
    } else out = route.json;
    const res = out instanceof Response ? out : out === undefined ? new Response(null, { status: 204 }) : Response.json(out);
    const headers = new Headers(res.headers);
    headers.set("x-cfl-mock", route.file);
    console.log(`[cf-lite] mock ${request.method} ${new URL(request.url).pathname} <- ${route.file}`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  const table: MockTable = {
    routes,
    match,
    respond,
    async middleware(c, next) {
      installMocks(table, new URL(c.req.url).origin);
      const hit = match(c.req.method, new URL(c.req.url), new URL(c.req.url).origin);
      if (!hit) return next();
      return respond(c.req.raw, hit);
    },
  };
  return table;
}

function safeJson(t: string): unknown { try { return JSON.parse(t); } catch { return t; } }

const KEY = Symbol.for("cf-lite.mock-fetch");
/** Wraps `globalThis.fetch` once per isolate: a request that a mock matches never leaves the Worker. The table is swapped on HMR reloads. */
export function installMocks(table: MockTable, origin: string): void {
  const g = globalThis as unknown as Record<symbol, { table: MockTable; origin: string } | undefined> & { fetch: typeof fetch };
  const st = g[KEY];
  if (st) { st.table = table; st.origin = origin; return; }
  const state = { table, origin };
  g[KEY] = state;
  const real = g.fetch.bind(globalThis);
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const hit = state.table.match(req.method, new URL(req.url), state.origin);
    return hit ? state.table.respond(req, hit) : real(input as RequestInfo, init);
  }) as typeof fetch;
}
